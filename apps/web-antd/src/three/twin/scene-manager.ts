import type * as THREE_NS from 'three';

import type { LoadedModel, LoadModelOptions } from './model-loader';
import type {
  AnchorDescriptor,
  AnchorRuntimeState,
  AnchorTransform,
  TwinSceneError,
  TwinSceneState,
  TwinViewConfig,
} from './types';

import { applyAnchorToObject, buildAncestryPivots } from './ancestry';
import { disposeSubtree } from './disposal';
import { attachKtx2, loadModel } from './model-loader';

/**
 * 场景生命周期管理（**「方便切换场景」这一需求的核心实现**）。
 *
 * ## 三个职责
 *
 * 1. **世界坐标链**：沿父场景链递归合成 `worldMatrix`，把「本场景局部坐标」映射到
 *    「顶层世界坐标」。子场景通过 `anchor_*` 变换嵌进父场景 —— 这是「整栋楼平移一次，
 *    楼上所有点位自动跟着走」的唯一正确姿势。
 * 2. **切换状态机**：`disposed → loading → ready → disposing → disposed`，失败进 `failed`。
 *    每次迁移都通过 `onStateChange` 暴露，页面据此渲染进度/错误/禁用操作。
 * 3. **两种切换模式**：`switch`（默认，单场景驻留）与 `fly`（可选，父子同驻留）。
 *    不满足飞行条件时**显式回退并给出原因**（不静默）。
 *
 * ## 为什么渲染器/相机/控制器只建一次
 *
 * WebGL 上下文重建代价高（需重新上传全部材质与着色器），且浏览器在活跃 WebGL 上下文
 * 超过约 16 个后会开始丢弃最旧的（`webglcontextlost`）。因此「切场景」只换场景内的
 * 模型节点，**不重建 renderer**。
 */

/** 场景切换模式。 */
export type TwinSwitchMode = 'fly' | 'switch';

/** 飞行模式允许的最大模型字节数（超过则禁用飞行：双场景驻留会耗尽显存）。 */
export const FLY_MAX_MODEL_BYTES = 20 * 1024 * 1024;

/** 设备内存阈值（GB）：`navigator.deviceMemory <= 4` 时禁用飞行模式。 */
export const FLY_MIN_DEVICE_MEMORY_GB = 4;

/** 内存自检：切换多次后 `geometries` 超过基线的该增量即告警（开发期观测）。 */
export const MEMORY_LEAK_GEOMETRY_THRESHOLD = 20;

/** 画布背景色（深色：设备状态色在深底上对比度更好）。 */
const SCENE_BACKGROUND = '#0b1220';

/**
 * 环境光/平行光颜色。
 *
 * 刻意用 `Color` 对象 + CSS 字符串而不是十六进制字面量（`0xffffff`）：
 * 本仓的 formatter（oxfmt）会把十六进制数字**降为小写**，而 linter（oxlint 的
 * `unicorn/number-literal-case`）要求**大写** —— 两者对同一行互相改写，本地
 * `--fix` 与 CI 检查永远对不上（实测：本地通过、CI 的「Lint（oxlint，类型感知）」失败）。
 * 用 `Color` 从字符串构造既规避该冲突，也比裸数字更具可读性。
 */
const LIGHT_COLOR_HEX = '#ffffff';

/** 锚点层契约（由 `anchor-layer.ts` 实现，画布组件装配）。 */
export interface AnchorLayer {
  /** 把锚点挂到模型上（每次进入场景调用一次）。 */
  attach: (modelRoot: THREE_NS.Object3D, anchors: AnchorDescriptor[]) => void;
  /** 卸载全部锚点（切场景/销毁时调用）。 */
  detach: () => void;
  /**
   * 在渲染循环里绘制锚点层（CSS2D 渲染器需要每帧绘制一次）。
   *
   * 为什么由 manager 调用而不是锚点层自己开循环：一个画布只应有一个 rAF 循环。
   * 两个循环（3D + CSS2D）会在不同帧提交，标签与模型之间出现一帧的错位抖动。
   */
  render: (scene: THREE_NS.Scene, camera: THREE_NS.Camera) => void;
  /** 画布尺寸变化时同步 CSS2D 渲染器（否则标签位置在缩放后偏移）。 */
  resize: (width: number, height: number) => void;
  /** 批量更新运行态（rAF 合并后调用）。 */
  update: (states: Map<string, AnchorRuntimeState>) => void;
}

/** 场景管理器构造选项。 */
export interface SceneManagerOptions {
  /** 挂载容器的 DOM 元素。 */
  container: HTMLElement;
  /** 错误文案工厂（引擎层不做 i18n，由页面注入本地化文案）。 */
  errorMessages: {
    downloadFailed: (detail: string) => string;
    parseFailed: (detail: string) => string;
  };
  /** 状态变化回调。 */
  onStateChange: (state: TwinSceneState, error?: TwinSceneError) => void;
  /**
   * 取访问令牌（由画布组件注入，引擎层不直接依赖状态库）。
   *
   * 目的：让引擎层保持「零首屏依赖」，three 才能被真正按需加载（工单 #125）。
   */
  getAccessToken?: () => null | string | undefined;
}

/** 一个场景的加载描述（由页面从场景响应 + 资产响应转换而来）。 */
export interface SceneLoadRequest {
  /** 场景 ID。 */
  sceneId: string;
  /** 模型绝对地址（已由 `resolveModelUrl` 拼好）。 */
  modelUrl: string;
  /** glTF 内部相对资源的基准路径（分离资源模型必传）。 */
  basePath: string;
  /** 该场景自身的锚点变换。 */
  anchor: AnchorTransform;
  /** 从根到本场景的完整祖先链（**含自身**，按根→叶顺序）。 */
  ancestry: AnchorTransform[];
  /** 默认视角配置（可空 ⇒ 用引擎默认）。 */
  view?: null | TwinViewConfig;
  /** 场景内设备锚点。 */
  anchors: AnchorDescriptor[];
  /** 模型文件字节数（用于判断飞行模式是否允许）。 */
  modelBytes?: null | number;
}

/**
 * 飞行模式回退原因（**结构化，不在引擎层本地化**）。
 *
 * <p>引擎层不做 i18n：它拿不到 `$t`，返回中文字符串会导致英文界面出现中英混杂
 * （工单 #131 的实测问题）。这里只返回「用哪个 key、带什么参数」，
 * 由画布层用 `$t(key, params)` 渲染。</p>
 */
export interface TwistFallbackReason {
  /** i18n key（`page.iot.twin.*`）。 */
  key: string;
  /** 插值参数（`$t` 的第二个参数）。 */
  params?: Record<string, number | string>;
}

/** `enterScene` 的返回值：实际使用的模式与（可选的）回退原因。 */
export interface EnterSceneResult {
  /** 因不满足条件而未启用飞行模式时的原因（页面要展示，不能静默）。 */
  fallbackReason?: TwistFallbackReason;
  /** 实际使用的切换模式。 */
  mode: TwinSwitchMode;
}

/** 模型**解析**阶段的错误（与下载失败区分，给用户不同文案）。 */
export class ModelParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ModelParseError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * 场景管理器（每个画布一个实例）。
 *
 * 生命周期：`new TwinSceneManager(opts)` → `await init()` → 反复 `enterScene(...)` →
 * `dispose()`。
 */
export class TwinSceneManager {
  /**
   * 当前场景的祖先链 pivot（嵌套 Group）。
   *
   * 存下来是为了 dispose 时整条移除：只摘模型根会把 pivot 留在场景图里，
   * 下次进入场景又会叠一层，反复切换后场景图无限增长（形状上也表现为模型越走越远）。
   */
  private ancestryPivots: THREE_NS.Object3D[] = [];

  private anchorLayer?: AnchorLayer;

  private animationFrameId = 0;

  /** 上一次切换建立的内存基线（geometries 数量）。 */
  private baselineGeometries = 0;

  private camera?: THREE_NS.PerspectiveCamera;

  private container: HTMLElement;

  private controls?: import('three/addons/controls/OrbitControls.js').OrbitControls;

  /** 当前已挂载的场景 ID（用于区分「同场景重建」与「真的换场景」）。 */
  private currentSceneId?: string;

  /** 当前场景的世界变换矩阵（局部坐标 → 世界坐标）。 */
  private currentWorldMatrix?: THREE_NS.Matrix4;

  private disposed = false;

  private errorMessages: SceneManagerOptions['errorMessages'];

  private fadeOverlay?: HTMLDivElement;

  /** 取访问令牌（注入，见 SceneManagerOptions#getAccessToken）。 */
  private getAccessToken?: () => null | string | undefined;

  private initialized = false;

  /**
   * 最近一次收到的锚点描述（模型就绪前到达的**暂存**在此）。
   *
   * 为什么必须有：`refreshAnchors` 在 `modelRoot` 尚未就绪时无法挂载锚点，
   * 若直接丢弃，而此后 `props.anchors` 又不再变化（静态场景的常态），
   * 锚点就**永远不会被创建** ⇒ 画布上只有模型、没有任何设备点与标签。
   * 实测表现：同一页面刷新多次，有时 6 个标签正常、有时全空（时序竞态）。
   */
  private lastAnchors?: AnchorDescriptor[];

  /**
   * 最近一次收到的运行态（锚点层就绪前到达的数据**暂存**在此）。
   *
   * 为什么必须有：`onFlush` 在 `runtime.loadSnapshot()` 完成时触发，而画布此时
   * 可能仍在 `await manager.init()` 里（`anchorLayer` 还没 attach）⇒
   * `this.anchorLayer?.update()` 静默丢弃 ⇒ **锚点标签永远是空文本**。
   * 实测现象：`onFlush` 已收到 6 个状态，而 6 个 `.twin-anchor-label` 的
   * textContent 全为空、childNodes 为 0。
   */
  private lastAnchorStates?: Map<string, AnchorRuntimeState>;

  private modelRoot?: THREE_NS.Group;

  private onStateChange: SceneManagerOptions['onStateChange'];

  private renderer?: THREE_NS.WebGLRenderer;

  private resizeObserver?: ResizeObserver;

  private scene?: THREE_NS.Scene;

  private state: TwinSceneState = 'disposed';

  private switchCount = 0;

  /** three 命名空间（`init` 时通过动态 import 取得，避免顶层 import 破坏分包）。 */
  private THREE?: typeof THREE_NS;

  constructor(options: SceneManagerOptions) {
    this.container = options.container;
    this.onStateChange = options.onStateChange;
    this.errorMessages = options.errorMessages;
    this.getAccessToken = options.getAccessToken;
  }

  /**
   * 注册锚点层（画布装配时调用一次）。
   *
   * @param layer 锚点层实现
   */
  attachAnchorLayer(layer: AnchorLayer): void {
    this.anchorLayer = layer;
    // 重放锚点层就绪前收到的状态：否则那些数据被永久丢弃，标签一直空白
    if (this.lastAnchorStates && this.lastAnchorStates.size > 0) {
      layer.update(this.lastAnchorStates);
    }
  }

  /**
   * 销毁管理器（页面卸载时调用）：停止渲染循环、释放全部 GPU 资源、解绑事件。
   *
   * 幂等：重复调用直接返回。
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.anchorLayer?.detach();
    this.anchorLayer = undefined;
    this.clearCurrentModelSync();
    this.fadeOverlay?.remove();
    this.fadeOverlay = undefined;
    this.controls?.dispose();
    this.controls = undefined;
    // renderer.dispose() 释放 WebGL 上下文的 GPU 侧资源；domElement 一并移除
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.renderer = undefined;
    this.scene = undefined;
    this.camera = undefined;
    this.currentWorldMatrix = undefined;
    this.THREE = undefined;
    this.setState('disposed');
  }

  /**
   * 进入（切换）一个场景。
   *
   * 并发保护：`loading`/`disposing` 期间再次调用直接抛错——GPU 资源回收与新场景加载
   * 交叠会造成显存竞态（旧模型已 dispose、新模型已上传，`renderer.info.memory` 会翻倍）。
   *
   * @param request 场景加载描述
   * @param mode 期望的切换模式（默认 `switch`）
   * @returns 实际使用的模式与（可选）回退原因
   */
  async enterScene(
    request: SceneLoadRequest,
    mode: TwinSwitchMode = 'switch',
  ): Promise<EnterSceneResult> {
    if (this.disposed) {
      throw new Error('场景管理器已销毁，不能再加载场景');
    }
    if (!this.initialized) {
      throw new Error('场景管理器未初始化：请先 await init()');
    }
    if (this.state === 'loading' || this.state === 'disposing') {
      throw new Error('场景正在切换中，请稍候');
    }

    const flyCheck = mode === 'fly' ? this.canFly(request) : { allowed: false };
    const effectiveMode: TwinSwitchMode = flyCheck.allowed ? 'fly' : 'switch';

    this.setState('loading');
    try {
      // 换场景判定必须在**加载之前**做，并且只在**真的换场景**时清掉上一场景的锚点快照。
      // 两个坑（都实测踩过）：
      //   ① 若清得太晚，`refreshAnchors` 期间暂存的新场景锚点会被一起清掉；
      //   ② 若对「同场景重建」（资产到达触发的重载）也清，会丢掉加载期间到达的最新点位。
      const sceneChanged =
        this.currentSceneId !== undefined && this.currentSceneId !== request.sceneId;
      this.currentSceneId = request.sceneId;
      if (sceneChanged) {
        this.lastAnchors = undefined;
      }
      const loaded = await this.loadModelOrThrow(request);
      await this.fadeOut();
      await this.clearCurrentModel();
      this.attachModel(loaded, request);
      await this.fadeIn();
      this.setState('ready');
      this.switchCount += 1;
      this.checkMemory();
      if (flyCheck.allowed) {
        return { mode: effectiveMode };
      }
      return {
        fallbackReason: flyCheck.reason,
        mode: effectiveMode,
      };
    } catch (error) {
      const stage = error instanceof ModelParseError ? 'parse' : 'download';
      const detail = error instanceof Error ? error.message : String(error);
      this.setState('failed', {
        message:
          stage === 'parse'
            ? this.errorMessages.parseFailed(detail)
            : this.errorMessages.downloadFailed(detail),
        stage,
      });
      throw error;
    }
  }

  /**
   * 相机（供相机控制器做聚焦飞行与重置）。
   *
   * @returns 透视相机（未初始化时为 undefined）
   */
  getCamera(): THREE_NS.PerspectiveCamera | undefined {
    return this.camera;
  }

  /**
   * OrbitControls（供拾取器在拖拽期间临时禁用以避免「拖拽带着相机转」）。
   *
   * @returns 控制器（未初始化时为 undefined）
   */
  getControls():
    | import('three/addons/controls/OrbitControls.js').OrbitControls
    | undefined {
    return this.controls;
  }

  /**
   * 当前场景的模型根（供拾取器做射线检视）。
   *
   * @returns 模型根（未加载时为 undefined）
   */
  getModelRoot(): THREE_NS.Group | undefined {
    return this.modelRoot;
  }

  /**
   * three 命名空间（供相机控制器/拾取器构造，避免它们各自再 import 一次）。
   *
   * @returns three 命名空间（未初始化时为 undefined）
   */
  getThree(): typeof THREE_NS | undefined {
    return this.THREE;
  }

  /**
   * 当前场景的世界矩阵（供拾取器做坐标换算）。
   *
   * @returns 4x4 世界矩阵（未初始化时抛错，不返回假矩阵）
   */
  getWorldMatrix(): THREE_NS.Matrix4 {
    if (!this.currentWorldMatrix) {
      throw new Error('场景管理器未初始化：世界矩阵不可用');
    }
    return this.currentWorldMatrix;
  }

  /**
   * 初始化渲染器/场景/相机/控制器（**只做一次**）。
   *
   * 重复调用是幂等的（`initialized` 短路）：画布的 `onMounted` 与「重试按钮」都会走这里，
   * 重复建 renderer 会造成上下文泄漏。
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const THREE = await import('three');
    const { OrbitControls } =
      await import('three/addons/controls/OrbitControls.js');
    this.THREE = THREE;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SCENE_BACKGROUND);

    this.camera = new THREE.PerspectiveCamera(50, this.aspect(), 0.1, 20_000);
    // 初始视角：斜上方看向原点（根场景的合理起点；子场景会被 view_json 覆盖）
    this.camera.position.set(40, 30, 40);

    this.renderer = new THREE.WebGLRenderer({
      // 不透明背景：透明背景 + 大量半透明材质的排序成本很高
      alpha: false,
      // 建筑模型上抗锯齿收益明显
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.renderer.setSize(
      this.container.clientWidth || 1,
      this.container.clientHeight || 1,
    );
    this.container.append(this.renderer.domElement);

    // 灯光：环境光给基础照明，平行光给方向感。
    // 刻意**不开阴影**：建筑级模型的阴影贴图成本高、收益低（用户主要看设备状态而非光影）。
    this.scene.add(
      new THREE.AmbientLight(new THREE.Color(LIGHT_COLOR_HEX), 1.2),
    );
    const directional = new THREE.DirectionalLight(
      new THREE.Color(LIGHT_COLOR_HEX),
      1.8,
    );
    directional.position.set(50, 100, 50);
    this.scene.add(directional);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // 禁止转到地面以下：从地下看建筑模型没有意义且容易迷失方向
    this.controls.maxPolarAngle = Math.PI / 2;

    this.currentWorldMatrix = new THREE.Matrix4();

    // 淡入淡出遮罩（切换场景时避免「黑屏一瞬」的突兀感）
    this.fadeOverlay = document.createElement('div');
    this.fadeOverlay.style.cssText = [
      'position:absolute',
      'inset:0',
      `background:${SCENE_BACKGROUND}`,
      'opacity:0',
      'pointer-events:none',
      'transition:opacity 180ms ease',
      'z-index:1',
    ].join(';');
    this.container.append(this.fadeOverlay);

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(this.container);

    this.startRenderLoop();
    this.initialized = true;
    this.setState('disposed');
  }

  /**
   * 批量更新锚点运行态（由页面在 rAF 合并后调用）。
   *
   * @param states 点位 ID → 运行态
   */
  /**
   * 只刷新锚点层（点位增删改时用），**不重载模型**。
   *
   * 为什么不能整场景重建：`attachModel` 会 `detach()` 掉全部锚点元素再重建。
   * 若运行态刷新也走这条路，锚点会被高频重建 —— 新元素文本为空、旧元素刚被移除，
   * 结果就是「标签永远看不见」（线上实测：写入 108 次、读到的 6 个元素全为空）。
   * 点位变化只影响锚点的位置/绑定，模型没变就只该重建锚点。
   *
   * @param anchors 新的锚点描述
   */
  refreshAnchors(anchors: AnchorDescriptor[]): void {
    // 无论能否立刻挂载，都要记住最新值：attachModel 会用它建锚点
    this.lastAnchors = anchors;
    if (!this.modelRoot) {
      return;
    }
    this.anchorLayer?.attach(this.modelRoot, anchors);
    // 重建后立刻重放最近一次运行态，避免标签又空一帧
    if (this.lastAnchorStates && this.lastAnchorStates.size > 0) {
      this.anchorLayer?.update(this.lastAnchorStates);
    }
  }

  updateAnchorStates(states: Map<string, AnchorRuntimeState>): void {
    // 始终先存一份：锚点层可能还没就绪（见 lastAnchorStates 的说明）
    this.lastAnchorStates = states;
    this.anchorLayer?.update(states);
  }

  /**
   * 世界法线 → 当前场景局部法线（拾取结果的落库口径）。
   *
   * 法线必须用**逆转置矩阵**变换（不是直接乘）：非均匀缩放下直接乘会让法线方向失真。
   * 且换算基准必须是 `currentWorldMatrix`（与渲染同源的场景图矩阵），不能用世界法线直传 ——
   * 父场景有旋转时直传会把「世界朝向」当成「本场景朝向」存进库，灯具/贴面朝向就错了。
   *
   * @param normal 世界坐标法线
   * @returns 本场景局部法线（已归一化）
   */
  worldNormalToLocal(normal: { x: number; y: number; z: number }): {
    x: number;
    y: number;
    z: number;
  } {
    const THREE = this.THREE;
    const matrix = this.currentWorldMatrix;
    if (!THREE || !matrix) {
      throw new Error('场景管理器未初始化：法线换算不可用');
    }
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(
      matrix.clone().invert().transpose(),
    );
    const vector = new THREE.Vector3(normal.x, normal.y, normal.z)
      .applyMatrix3(normalMatrix)
      .normalize();
    return { x: vector.x, y: vector.y, z: vector.z };
  }

  /**
   * 世界坐标 → 当前场景局部坐标（拾取结果的落库口径）。
   *
   * @param world 世界坐标
   * @returns 局部坐标
   */
  worldToLocal(world: { x: number; y: number; z: number }): {
    x: number;
    y: number;
    z: number;
  } {
    const THREE = this.THREE;
    const matrix = this.currentWorldMatrix;
    if (!THREE || !matrix) {
      throw new Error('场景管理器未初始化：坐标换算不可用');
    }
    const vector = new THREE.Vector3(world.x, world.y, world.z).applyMatrix4(
      matrix.clone().invert(),
    );
    return { x: vector.x, y: vector.y, z: vector.z };
  }

  // ---------- 私有：加载与装配 ----------

  /** 应用视角配置（空则按模型包围盒自适应，保证「一进去就能看到模型」）。 */
  private applyView(view?: null | TwinViewConfig): void {
    const THREE = this.THREE;
    if (
      !THREE ||
      !this.scene ||
      !this.camera ||
      !this.controls ||
      !this.modelRoot
    ) {
      return;
    }
    if (view?.background) {
      this.scene.background = new THREE.Color(view.background);
    }
    // 光照强度可配（场景级差异：室内楼层通常比园区暗）
    if (typeof view?.ambientIntensity === 'number') {
      for (const child of this.scene.children) {
        if (child instanceof THREE.AmbientLight) {
          child.intensity = view.ambientIntensity;
        }
      }
    }
    if (typeof view?.directionalIntensity === 'number') {
      for (const child of this.scene.children) {
        if (child instanceof THREE.DirectionalLight) {
          child.intensity = view.directionalIntensity;
        }
      }
    }

    const box = new THREE.Box3().setFromObject(this.modelRoot);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);

    if (view?.camera?.position && view.camera.target) {
      this.camera.position.set(
        view.camera.position.x,
        view.camera.position.y,
        view.camera.position.z,
      );
      this.controls.target.set(
        view.camera.target.x,
        view.camera.target.y,
        view.camera.target.z,
      );
      if (typeof view.camera.fov === 'number') {
        this.camera.fov = view.camera.fov;
        this.camera.updateProjectionMatrix();
      }
    } else if (Number.isFinite(maxDimension) && maxDimension > 0) {
      // 没有配置视角时按包围盒自适应：距离 = 尺寸 × 1.6
      // （50° fov 下该系数能让模型占据约 2/3 画面高度）
      const distance = maxDimension * 1.6;
      this.camera.position.set(
        center.x + distance * 0.6,
        center.y + distance * 0.5,
        center.z + distance * 0.6,
      );
      this.controls.target.copy(center);
      // 近远裁剪面按模型尺寸调整：建筑模型的坐标尺度可能是米或毫米，
      // 固定 0.1/5000 在毫米级模型上会整片被裁掉
      this.camera.near = Math.max(0.001, maxDimension / 10_000);
      this.camera.far = maxDimension * 100;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
  }

  private aspect(): number {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    return width / height;
  }

  /** 挂载新模型：应用锚点变换、加入场景、通知锚点层。 */
  private attachModel(loaded: LoadedModel, request: SceneLoadRequest): void {
    const THREE = this.THREE;
    if (!THREE || !this.scene) {
      throw new Error('场景管理器未初始化：无法挂载模型');
    }
    const root = loaded.scene;
    this.modelRoot = root;

    // 锚点变换：**把整条祖先链建成嵌套 Group**，而不是只设自身变换。
    //
    // ⚠️ 这里曾有一个会系统性偏移坐标的缺陷（独立复核实测发现）：
    //    旧实现只把 `request.anchor`（自身）设到 root，父链从未进场景图；
    //    但 `currentWorldMatrix` 却另外手写合成了一套**含父链**的矩阵（已删除），
    //    `worldToLocal` 又用它的逆换算落库坐标 ⇒ 渲染位置与换算矩阵不是同一套。
    //    后果：父 anchor x=10、子 anchor x=5 时，画布上看到的原点在世界 (5,0,0)，
    //    但矩阵认为在 (15,0,0)；用户点到「看到的原点」，落库局部坐标是 (-10,0,0)（正确应为 0），
    //    且多点几层误差线性放大。
    //
    // 修法：让**渲染与矩阵同源**——沿 ancestry 逐级建 Group（每级一个 anchor 变换），
    // 模型挂在最深那级下面。这样 three 的 `matrixWorld` 自然等于
    // `parentWorld × anchor`，`worldToLocal` 用它取逆即可，不需要前端自己合成一套。
    // ancestry 是「根 → 叶」顺序（含自身）：
    //   scene → pivot(根 anchor) → pivot(第2级 anchor) → … → modelRoot
    // 于是 modelRoot.matrixWorld 自然等于 `parentWorld × anchor`（与后端口径一致），
    // 不需要前端再手写一套矩阵合成。
    // 变换数学全部在 `ancestry.ts`（纯函数，可单测）——这里只负责挂载。
    const { parent, pivots: createdPivots } = buildAncestryPivots(
      THREE,
      this.scene,
      request.ancestry,
    );

    // 模型根不再叠加 anchor：父链最后一环已包含自身 anchor。
    // ancestry 为空时（防御：后端保证至少含自身）退回用 request.anchor 兜底。
    if (createdPivots.length === 0) {
      applyAnchorToObject(root, request.anchor);
    }
    parent.add(root);
    // 必须立刻刷新：matrixWorld 是「上次渲染时」算的，此处要马上用它换算坐标
    root.updateWorldMatrix(true, true);

    // 世界矩阵**直接取渲染图的实际结果**（与渲染同源，不再手写合成）
    this.currentWorldMatrix = root.matrixWorld.clone();

    // 记下 pivot 链：dispose 时整条一起移除（否则留下孤儿 Group 与残留显存）
    this.ancestryPivots = createdPivots;

    // 用**最新**的锚点：`request.anchors` 是 loadScene 开始时捕获的快照，
    // 而模型加载期间 props.anchors 可能已更新（refreshAnchors 暂存了最新值）。
    // 用旧快照会让「加载期间新增的点位」不显示。
    // 优先用加载期间暂存的新值；没有则用本次请求携带的。
    // 两者都为空是合法情况（场景暂无点位）。
    const anchorsToUse = this.lastAnchors ?? request.anchors;
    this.lastAnchors = anchorsToUse;
    this.anchorLayer?.attach(root, anchorsToUse);
    // 挂载后立刻重放运行态（数据通常比模型先到）
    if (this.lastAnchorStates && this.lastAnchorStates.size > 0) {
      this.anchorLayer?.update(this.lastAnchorStates);
    }
    this.applyView(request.view);
  }

  /** 是否允许飞行模式（不允许时给出**具体原因**，页面要能展示）。 */
  private canFly(request: SceneLoadRequest): {
    allowed: boolean;
    reason?: TwistFallbackReason;
  } {
    const bytes = request.modelBytes ?? 0;
    if (bytes > FLY_MAX_MODEL_BYTES) {
      return {
        allowed: false,
        reason: {
          key: 'page.iot.twin.flyFallbackModelTooLarge',
          params: {
            limitMb: Math.round(FLY_MAX_MODEL_BYTES / 1024 / 1024),
            modelMb: Math.round(bytes / 1024 / 1024),
          },
        },
      };
    }
    const deviceMemory = (
      globalThis.navigator as unknown as { deviceMemory?: number }
    ).deviceMemory;
    if (
      typeof deviceMemory === 'number' &&
      deviceMemory <= FLY_MIN_DEVICE_MEMORY_GB
    ) {
      return {
        allowed: false,
        reason: {
          key: 'page.iot.twin.flyFallbackLowMemory',
          params: { deviceMemory },
        },
      };
    }
    if (request.ancestry.length <= 1) {
      return {
        allowed: false,
        reason: { key: 'page.iot.twin.flyFallbackNoAnchor' },
      };
    }
    return { allowed: true };
  }

  /** 开发期内存自检：切换多次后几何体数量应回到基线附近。 */
  private checkMemory(): void {
    if (!this.renderer) {
      return;
    }
    const { geometries } = this.renderer.info.memory;
    if (this.switchCount === 1) {
      this.baselineGeometries = geometries;
      return;
    }
    if (geometries > this.baselineGeometries + MEMORY_LEAK_GEOMETRY_THRESHOLD) {
      console.warn(
        `[iot/twin] 疑似显存泄漏：切换 ${this.switchCount} 次后 geometries=${geometries}，` +
          `基线=${this.baselineGeometries}。请检查 dispose 是否覆盖了全部 geometry/material/texture`,
      );
    }
  }

  /** 清理当前模型（async：先让出一帧再加载新模型，避免显存瞬时翻倍）。 */
  private async clearCurrentModel(): Promise<void> {
    this.clearCurrentModelSync();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  }

  /** 同步清理当前模型与其 GPU 资源。 */
  private clearCurrentModelSync(): void {
    this.anchorLayer?.detach();
    if (this.modelRoot) {
      // 先回收模型根的 GPU 资源，再从最深那级 pivot 上摘下来
      disposeSubtree(this.modelRoot);
      this.modelRoot.removeFromParent();
      this.modelRoot = undefined;
    }
    // 逐级回卷移除 pivot（从最深开始）：只摘模型根会把 pivot 链留在场景图里，
    // 反复切换后场景图无限增长，表现为「模型越切越远」。
    for (let index = this.ancestryPivots.length - 1; index >= 0; index--) {
      this.ancestryPivots[index]?.removeFromParent();
    }
    this.ancestryPivots = [];
  }

  /** 淡入遮罩。 */
  private async fadeIn(): Promise<void> {
    if (!this.fadeOverlay) {
      return;
    }
    this.fadeOverlay.style.opacity = '0';
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 190);
    });
  }

  /** 淡出遮罩。 */
  private async fadeOut(): Promise<void> {
    if (!this.fadeOverlay) {
      return;
    }
    this.fadeOverlay.style.opacity = '1';
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 190);
    });
  }

  /** 加载模型（把解析异常包成可区分阶段的错误）。 */
  private async loadModelOrThrow(
    request: SceneLoadRequest,
  ): Promise<LoadedModel> {
    const options: LoadModelOptions = {
      basePath: request.basePath,
      getAccessToken: this.getAccessToken,
      url: request.modelUrl,
    };
    try {
      const loaded = await loadModel(options);
      // KTX2 需要 renderer 才能探测纹理支持；装配失败不影响未用 KTX2 的模型
      if (this.renderer) {
        const { GLTFLoader } =
          await import('three/addons/loaders/GLTFLoader.js');
        const probe = new GLTFLoader();
        await attachKtx2(probe, this.renderer);
      }
      return loaded;
    } catch (error) {
      throw new ModelParseError(
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }

  private resize(): void {
    if (!this.renderer || !this.camera) {
      return;
    }
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.anchorLayer?.resize(width, height);
  }

  private setState(state: TwinSceneState, error?: TwinSceneError): void {
    this.state = state;
    this.onStateChange(state, error);
  }

  private startRenderLoop(): void {
    const tick = () => {
      if (this.disposed) {
        return;
      }
      this.animationFrameId = requestAnimationFrame(tick);
      this.controls?.update();
      if (this.renderer && this.scene && this.camera) {
        this.renderer.render(this.scene, this.camera);
        // CSS2D 标签在同一个帧里绘制，保证与 3D 内容不错位
        this.anchorLayer?.render(this.scene, this.camera);
      }
    };
    this.animationFrameId = requestAnimationFrame(tick);
  }
}
