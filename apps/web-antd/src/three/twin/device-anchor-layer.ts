import type * as THREE_NS from 'three';

import type { AnchorLayer } from './scene-manager';
import type { AnchorDescriptor } from './types';

/**
 * 设备锚点层（**无任何标注的极简版**）。
 *
 * ## 设计口径（用户明确要求，不要改回去）
 *
 * > 「不要有圆点。直接把设备当做锚点。鼠标可以直接选择设备。不要有圆点这种概念。」
 *
 * 因此本模块**不创建任何视觉元素**：
 * - 没有 Sprite 圆点、没有 CSS2D 标签、没有数值气泡；
 * - 设备就是模型里的那个节点（柜子/灯杆/摄像头…），高亮与选中由 `device-focus.ts`
 *   直接作用在**模型节点材质**上（自发光 + 其余压暗）；
 * - 本层只剩两件事：**命中检测**（鼠标在哪台设备上）与**位置换算**（供详情卡定位）。
 *
 * ## 为什么还保留一个「层」
 *
 * 命中与位置换算需要知道「每台设备在屏幕上的位置」，而这依赖模型节点而非 3D 点位：
 * 1. **优先用节点包围盒投影**（点的是柜子本身，不是一个悬浮点）；
 * 2. 节点不在模型里时退回「点位世界坐标投影」（数据没配好也不至于点不到）。
 *
 * 命中算法：把每个点位的屏幕矩形缓存下来（相机/尺寸变化时重算），
 * `pointermove` 时做矩形包含判定（带容差），O(n)，点位数量 ≤ 500 足够。
 *
 * ## 与旧版本的差异（删掉的东西）
 *
 * 旧的 `anchor-layer` 承担了：Sprite 圆点、CSS2D 胶囊标签、标签防重叠布局、呼吸/扩散环/
 * 数值闪烁动效、hover 粘滞与 DOM 权威判定。这些**全部随圆点一起删除**——
 * 它们的存在意义就是「在没有选中设备时也能看到设备」，而现在设备本身就看得见。
 */

/** 单个设备在场景中的命中信息。 */
interface DeviceNode {
  descriptor: AnchorDescriptor;
  /** 模型里对应的节点（找不到时为空，退回点位投影）。 */
  objects: THREE_NS.Object3D[];
  /** 屏幕命中矩形（容器坐标；每帧按相机重算，见 `refreshScreenRects`）。 */
  rect?: { height: number; width: number; x: number; y: number };
}

/** 命中容差（像素）：设备在远处很小，纯矩形判定过严。 */
const HIT_PADDING_PX = 6;

/**
 * 创建设备锚点层。
 *
 * @param THREE three 命名空间（调用方动态 import 后传入）
 * @param container 画布容器
 * @param callbacks 交互回调
 * @returns 锚点层实例（`render` 时顺便刷新屏幕矩形）
 */
export function createDeviceAnchorLayer(
  THREE: typeof THREE_NS,
  container: HTMLElement,
  callbacks: {
    /** 指针悬停到某台设备（离开时 `undefined`）。 */
    onHoverAnchor?: (pointId: string | undefined) => void;
  },
): AnchorLayerInstance {
  const nodes = new Map<string, DeviceNode>();
  let modelRoot: THREE_NS.Object3D | undefined;
  let hoveredPointId: string | undefined;
  /** 上一帧的相机矩阵签名：相机或尺寸没变就不重算屏幕矩形（省每帧 O(n) 投影）。 */
  let lastSignature = '';
  /** 指针位置（容器坐标）。 */
  let pointer: undefined | { x: number; y: number };

  function attach(root: THREE_NS.Object3D, anchors: AnchorDescriptor[]): void {
    modelRoot = root;
    nodes.clear();
    for (const anchor of anchors) {
      nodes.set(anchor.pointId, {
        descriptor: anchor,
        objects: resolveObjects(root, anchor),
      });
    }
    lastSignature = '';
  }

  function detach(): void {
    nodes.clear();
    modelRoot = undefined;
    hoveredPointId = undefined;
    lastSignature = '';
    pointer = undefined;
  }

  /**
   * 每帧调用：相机变化时刷新屏幕矩形，并按指针位置更新 hover。
   *
   * @param scene 场景（未使用，保持 `AnchorLayer` 契约）
   * @param camera 相机
   */
  function render(scene: THREE_NS.Scene, camera: THREE_NS.Camera): void {
    void scene;
    refreshScreenRects(camera);
    if (pointer) {
      updateHover();
    }
  }

  /**
   * 指针移动（容器上由 scene-manager 转发）。
   *
   * @param x 容器坐标 X（像素）
   * @param y 容器坐标 Y（像素）
   */
  function pointerMove(x: number, y: number): void {
    pointer = { x, y };
    updateHover();
  }

  /** 指针离开画布。 */
  function pointerLeave(): void {
    pointer = undefined;
    if (hoveredPointId !== undefined) {
      hoveredPointId = undefined;
      callbacks.onHoverAnchor?.(undefined);
    }
  }

  /** 按缓存矩形判定命中的设备。 */
  function updateHover(): void {
    const hit = hitTest(pointer?.x ?? -1, pointer?.y ?? -1);
    if (hit === hoveredPointId) {
      return;
    }
    hoveredPointId = hit;
    callbacks.onHoverAnchor?.(hit);
  }

  /**
   * 命中测试：返回指针下的设备点位 ID（多个重叠时取中心最近的）。
   *
   * @param x 容器坐标 X
   * @param y 容器坐标 Y
   * @returns 点位 ID；无命中 undefined
   */
  function hitTest(x: number, y: number): string | undefined {
    let best: undefined | { distance: number; pointId: string };
    for (const [pointId, node] of nodes) {
      const rect = node.rect;
      if (!rect) {
        continue;
      }
      if (
        x < rect.x - HIT_PADDING_PX ||
        y < rect.y - HIT_PADDING_PX ||
        x > rect.x + rect.width + HIT_PADDING_PX ||
        y > rect.y + rect.height + HIT_PADDING_PX
      ) {
        continue;
      }
      const distance = Math.hypot(
        rect.x + rect.width / 2 - x,
        rect.y + rect.height / 2 - y,
      );
      if (!best || distance < best.distance) {
        best = { distance, pointId };
      }
    }
    return best?.pointId;
  }

  /** 相机/尺寸变化时重算每个设备的屏幕矩形（节点包围盒投影，失败退回点位投影）。 */
  function refreshScreenRects(camera: THREE_NS.Camera): void {
    const root = modelRoot;
    if (!root) {
      return;
    }
    const signature = `${camera.matrixWorld.elements.join(',')}|${container.clientWidth}x${container.clientHeight}`;
    if (signature === lastSignature) {
      return;
    }
    lastSignature = signature;
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    for (const node of nodes.values()) {
      node.rect = projectObjects(node, camera, width, height);
    }
  }

  /**
   * 把一个设备的节点包围盒投影成屏幕矩形。
   *
   * @param node 设备节点
   * @param camera 相机
   * @param width 容器宽
   * @param height 容器高
   * @returns 屏幕矩形（容器坐标）；不可见时 undefined
   */
  function projectObjects(
    node: DeviceNode,
    camera: THREE_NS.Camera,
    width: number,
    height: number,
  ): undefined | { height: number; width: number; x: number; y: number } {
    if (node.objects.length === 0) {
      // 退回点位世界坐标：模型里没有对应节点时至少还能点（数据未配好也不至于点不到）
      const world = node.descriptor.local;
      const screen = projectPoint(
        new THREE.Vector3(world.x, world.y, world.z).applyMatrix4(
          // 点位坐标是「场景局部」：用模型根矩阵还原到世界
          modelRoot?.matrixWorld ?? new THREE.Matrix4(),
        ),
        camera,
        width,
        height,
      );
      return screen
        ? { height: 18, width: 18, x: screen.x - 9, y: screen.y - 9 }
        : undefined;
    }
    const box = new THREE.Box3();
    for (const object of node.objects) {
      object.updateWorldMatrix(true, false);
      box.expandByObject(object);
    }
    if (box.isEmpty()) {
      return undefined;
    }
    const min = projectPoint(box.min, camera, width, height);
    const max = projectPoint(box.max, camera, width, height);
    if (!min || !max) {
      return undefined;
    }
    const x = Math.min(min.x, max.x);
    const y = Math.min(min.y, max.y);
    return {
      height: Math.max(6, Math.abs(max.y - min.y)),
      width: Math.max(6, Math.abs(max.x - min.x)),
      x,
      y,
    };
  }

  return {
    attach,
    detach,
    dispose: () => {
      detach();
    },
    getLabelScreenPosition: (pointId: string) => {
      const rect = nodes.get(pointId)?.rect;
      if (!rect) {
        return undefined;
      }
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;
      return { visible: x >= 0 && y >= 0 && x <= width && y <= height, x, y };
    },
    pointerLeave,
    pointerMove,
    render,
    resize: () => {
      // 尺寸变化 ⇒ 下一帧强制重算
      lastSignature = '';
    },
    update: (states) => {
      // 极简版不展示数值：运行态只用于「是否有告警」这类上层展示（卡片自行读取）。
      void states;
    },
  };
}

/** 锚点层实例（含命中与位置能力）。 */
export interface AnchorLayerInstance extends AnchorLayer {
  /** 释放（无 DOM/贴图资源，只有缓存）。 */
  dispose: () => void;
  /**
   * 指针移动（由 scene-manager 转发容器上的 `pointermove`）。
   *
   * @param x 容器坐标 X
   * @param y 容器坐标 Y
   */
  pointerMove: (x: number, y: number) => void;
  /** 指针离开画布。 */
  pointerLeave: () => void;
  /**
   * 取某设备的屏幕中心（相对容器左上角）。
   *
   * 详情卡用它定位：卡片贴着**设备本体**出现，而不是一个抽象点位。
   *
   * @param pointId 点位 ID
   * @returns 屏幕坐标；不可见时 undefined
   */
  getLabelScreenPosition: (
    pointId: string,
  ) => undefined | { visible: boolean; x: number; y: number };
}

/**
 * 把一个世界坐标投影到容器像素坐标。
 *
 * @param point 世界坐标
 * @param camera 相机
 * @param width 容器宽
 * @param height 容器高
 * @returns 屏幕坐标；在相机背后时 undefined
 */
function projectPoint(
  point: THREE_NS.Vector3,
  camera: THREE_NS.Camera,
  width: number,
  height: number,
): undefined | { x: number; y: number } {
  const projection = point.clone().project(camera);
  // `project` 对相机背后的点会给出镜像坐标（z > 1），必须用 z 判断
  if (projection.z < -1 || projection.z > 1) {
    return undefined;
  }
  return {
    x: ((projection.x + 1) / 2) * width,
    y: ((-projection.y + 1) / 2) * height,
  };
}

/**
 * 在模型里找点位对应的节点（精确名优先，再宽松匹配、再前缀匹配）。
 *
 * 支持多点位 `nodeName` 写成 `a|b`（多个候选名，见 `device-focus.ts`）。
 *
 * @param root 模型根
 * @param anchor 点位描述
 * @returns 命中的节点列表（可能为空）
 */
function resolveObjects(
  root: THREE_NS.Object3D,
  anchor: AnchorDescriptor,
): THREE_NS.Object3D[] {
  const names = (anchor.nodeName ?? '')
    .split('|')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    return [];
  }
  const exact = new Set(names);
  const loose = new Set(
    names.map((name) => name.toLowerCase().replaceAll(/[_\-\s.]/g, '')),
  );
  const exactHits: THREE_NS.Object3D[] = [];
  const looseHits: THREE_NS.Object3D[] = [];
  root.traverse((object) => {
    if (!object.name) {
      return;
    }
    const { isTwinAnchor } = object.userData as { isTwinAnchor?: boolean };
    if (isTwinAnchor === true) {
      return;
    }
    if (exact.has(object.name)) {
      exactHits.push(object);
      return;
    }
    if (loose.has(object.name.toLowerCase().replaceAll(/[_\-\s.]/g, ''))) {
      looseHits.push(object);
    }
  });
  if (exactHits.length > 0) {
    return exactHits;
  }
  if (looseHits.length > 0) {
    return looseHits;
  }
  return [];
}
