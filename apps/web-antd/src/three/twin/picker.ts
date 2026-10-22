import type * as THREE_NS from 'three';

/**
 * 3D 内拾取（配置态的核心交互）。
 *
 * ## 三条必须做对的规则
 *
 * 1. **射线拾取用 BVH 加速**：建筑级模型常有几十万到几百万三角形，原生 `Raycaster`
 *    是 O(n)，点击一次卡 100~500ms。`three-mesh-bvh` 给每个 mesh 建 BVH 后降到接近 O(log n)。
 *    BVH 构建本身有成本（首次进入场景几十~几百毫秒），因此**只在配置态构建**
 *    （运行态用户不拾取模型表面，只点锚点，不需要 BVH）。
 * 2. **命中结果要区分「锚点」与「模型表面」**：点到已有锚点 = 选中该点位；
 *    点到模型表面 = 在交点处放置新锚点。两者语义完全不同。
 *
 * 拖拽微调不在本模块（由 `point-form` 的数值输入承担）：`TransformControls` 需要
 * 额外的 gizmo 生命周期管理与「拖拽期间禁用 OrbitControls」的时序，而点位坐标的
 * 精度要求用数值输入更可靠（拖拽只能到像素级）。
 */

/** 拾取结果。 */
export type PickResult =
  | {
      /** 命中了已有锚点。 */
      kind: 'anchor';
      pointId: string;
    }
  | {
      /** 命中了模型表面（可在此放置新锚点）。 */
      kind: 'surface';
      /**
       * 命中对象的节点名（可能为空）。
       *
       * 运行态用它反查「点中的是哪个设备点位」：点位绑定了 `nodeName` 时，
       * 点柜子即可选中该设备（用户明确要的交互）。
       */
      nodeName?: null | string;
      /** 世界坐标法线（已归一化）。 */
      normal: { x: number; y: number; z: number };
      /** 世界坐标交点。 */
      point: { x: number; y: number; z: number };
    };

/** 拾取器选项。 */
export interface PickerOptions {
  /**
   * OrbitControls。
   *
   * 保留在契约里是为了将来做拖拽微调时能临时禁用相机控制（否则拖拽会带着相机转）。
   * 当前实现不做拖拽（坐标用数值输入更精确），故未使用，但接口先留出，
   * 避免将来加拖拽时改调用方签名。
   */
  controls?: import('three/addons/controls/OrbitControls.js').OrbitControls;
  /** 画布 DOM（绑定鼠标事件）。 */
  domElement: HTMLElement;
  /** 相机。 */
  camera: THREE_NS.PerspectiveCamera;
  /** 模型根（射线检测范围）。 */
  getModelRoot: () => THREE_NS.Group | undefined;
  /** 点击回调（空点击 = 点到空白处）。 */
  onClick: (result?: PickResult) => void;
  /** three 命名空间。 */
  THREE: typeof THREE_NS;
  /**
   * 是否对模型表面建 BVH。
   *
   * true（配置态）：建 BVH，拾取快；首次进入场景多花几十~几百毫秒。
   * false（运行态）：不建，用户不需要点模型表面。
   */
  useBvh: boolean;
}

/** 拾取器：绑定到画布，处理点击。 */
export class TwinPicker {
  private bvhBuilt = false;

  private readonly bvhEnabled: boolean;

  private readonly camera: THREE_NS.PerspectiveCamera;

  private disposed = false;

  private readonly domElement: HTMLElement;

  private readonly onClickHandler: (event: MouseEvent) => void;

  private readonly options: PickerOptions;

  private readonly pointer: THREE_NS.Vector2;

  private readonly raycaster: THREE_NS.Raycaster;

  private readonly THREE: typeof THREE_NS;

  constructor(options: PickerOptions) {
    this.options = options;
    this.THREE = options.THREE;
    this.domElement = options.domElement;
    this.camera = options.camera;
    this.raycaster = new this.THREE.Raycaster();
    this.pointer = new this.THREE.Vector2();
    this.bvhEnabled = options.useBvh;

    this.onClickHandler = (event: MouseEvent) => {
      this.handleClick(event);
    };
    this.domElement.addEventListener('pointerup', this.onClickHandler);
  }

  /**
   * 为首个场景的模型建 BVH（幂等：只建一次）。
   *
   * 为什么不在 constructor 里建：模型还没加载。为什么只建一次：场景切换后需调用
   * {@link resetForNewModel} 重置标记再重新建。
   */
  buildBvh(): void {
    if (!this.bvhEnabled || this.bvhBuilt) {
      return;
    }
    const root = this.options.getModelRoot();
    if (!root) {
      return;
    }
    void (async () => {
      try {
        const bvh = await import('three-mesh-bvh');
        const computeBoundsTree = bvh.computeBoundsTree as unknown as
          | (() => void)
          | undefined;
        if (!computeBoundsTree) {
          throw new Error('three-mesh-bvh 未导出 computeBoundsTree');
        }
        // 官方推荐的挂法：给 BufferGeometry 原型加 computeBoundsTree
        const geometryProto = this.THREE.BufferGeometry
          .prototype as unknown as {
          computeBoundsTree?: () => void;
        };
        geometryProto.computeBoundsTree = computeBoundsTree;
        root.traverse((object) => {
          const mesh = object as THREE_NS.Mesh;
          if (mesh.isMesh && mesh.geometry) {
            (
              mesh.geometry as unknown as { computeBoundsTree?: () => void }
            ).computeBoundsTree?.();
          }
        });
        this.bvhBuilt = true;
      } catch (error) {
        // BVH 不可用不是致命问题：退回原生 Raycaster，只是变慢。
        // 必须留痕（否则用户只会觉得「点着卡」而不知道原因）。
        console.warn(
          '[iot/twin] three-mesh-bvh 装配失败，拾取退回原生 Raycaster（大模型上会变慢）：',
          error,
        );
      }
    })();
  }

  /** 解绑事件并释放。 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.domElement.removeEventListener('pointerup', this.onClickHandler);
  }

  /** 场景切换后重置 BVH 标记（新模型需要重新构建）。 */
  resetForNewModel(): void {
    this.bvhBuilt = false;
  }

  /**
   * 处理点击：先检测锚点，再检测模型表面。
   *
   * 为什么锚点优先：锚点 sprite 尺寸很小，若先测模型表面，点到锚点时可能同时命中背后的
   * 墙面而优先返回表面结果，用户会觉得「点不中锚点」。
   *
   * @param event 鼠标事件
   */
  private handleClick(event: MouseEvent): void {
    if (this.disposed) {
      return;
    }
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const root = this.options.getModelRoot();
    if (!root) {
      this.options.onClick();
      return;
    }

    const hits = this.raycaster.intersectObject(root, true);
    // 1) 命中锚点
    for (const hit of hits) {
      const pointId = (hit.object.userData as { pointId?: string }).pointId;
      if (typeof pointId === 'string') {
        this.options.onClick({ kind: 'anchor', pointId });
        return;
      }
    }
    // 2) 命中模型表面（排除 sprite）
    const surfaceHit = hits.find(
      (hit) => !(hit.object as THREE_NS.Sprite).isSprite,
    );
    if (!surfaceHit) {
      this.options.onClick();
      return;
    }
    const worldNormal = surfaceHit.face
      ? surfaceHit.face.normal
          .clone()
          .applyNormalMatrix(
            new this.THREE.Matrix3().getNormalMatrix(
              surfaceHit.object.matrixWorld,
            ),
          )
          .normalize()
      : new this.THREE.Vector3(0, 1, 0);
    // 命中对象可能是 mesh 的子层（GLTF 导出的网格常有嵌套节点），
    // 向上找最近的有名字的祖先：用户点的是「柜子的某块面板」，语义上仍是这个柜子。
    let named: null | THREE_NS.Object3D = surfaceHit.object;
    while (named && !named.name) {
      named = named.parent;
    }
    this.options.onClick({
      kind: 'surface',
      nodeName: named?.name ?? null,
      normal: { x: worldNormal.x, y: worldNormal.y, z: worldNormal.z },
      point: {
        x: surfaceHit.point.x,
        y: surfaceHit.point.y,
        z: surfaceHit.point.z,
      },
    });
  }
}

/**
 * 把「世界坐标交点」转成「本场景局部坐标」（落库口径）。
 *
 * @param worldMatrix 场景世界矩阵（局部 → 世界）
 * @param THREE three 命名空间
 * @param world 世界坐标
 * @returns 局部坐标
 */
export function worldToSceneLocal(
  worldMatrix: THREE_NS.Matrix4,
  THREE: typeof THREE_NS,
  world: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const vector = new THREE.Vector3(world.x, world.y, world.z).applyMatrix4(
    worldMatrix.clone().invert(),
  );
  return { x: vector.x, y: vector.y, z: vector.z };
}

/**
 * 把「世界坐标法线」转成「本场景局部法线」。
 *
 * 法线必须用**逆转置矩阵**变换（不是直接乘矩阵）：非均匀缩放下直接乘会让法线方向失真。
 *
 * @param worldMatrix 场景世界矩阵
 * @param THREE three 命名空间
 * @param normal 世界坐标法线
 * @returns 局部坐标法线（已归一化）
 */
export function worldNormalToSceneLocal(
  worldMatrix: THREE_NS.Matrix4,
  THREE: typeof THREE_NS,
  normal: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(
    worldMatrix.clone().invert().transpose(),
  );
  const vector = new THREE.Vector3(normal.x, normal.y, normal.z)
    .applyMatrix3(normalMatrix)
    .normalize();
  return { x: vector.x, y: vector.y, z: vector.z };
}
