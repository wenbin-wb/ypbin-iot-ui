import type * as THREE_NS from 'three';

import type { LabelInput, LabelLayout } from './label-layout';
import type { TwinMotionMode } from './motion-profile';
import type { AnchorLayer } from './scene-manager';
import type { AnchorDescriptor, AnchorRuntimeState } from './types';

import {
  TWIN_COLOR_ALERT,
  TWIN_COLOR_ALERT_DIM,
  TWIN_COLOR_ALERT_RIPPLE,
  TWIN_COLOR_DISABLED,
  TWIN_COLOR_DOT_NEUTRAL,
  TWIN_COLOR_ICON_BASE,
  TWIN_COLOR_ICON_INNER,
  TWIN_COLOR_LABEL_BG,
  TWIN_COLOR_LABEL_BORDER,
  TWIN_COLOR_LABEL_BORDER_ALERT,
  TWIN_COLOR_LABEL_CAPSULE_BORDER,
  TWIN_COLOR_LABEL_CAPSULE_BORDER_HOVER,
  TWIN_COLOR_LABEL_GLOW,
  TWIN_COLOR_LABEL_SHADOW,
  TWIN_COLOR_LABEL_TEXT,
  TWIN_COLOR_LABEL_TEXT_MUTED,
  TWIN_COLOR_OFFLINE,
  TWIN_COLOR_ONLINE,
  TWIN_COLOR_UNKNOWN,
} from './colors';
import { colorForRatio, toRenderMode } from './display';
import { layoutLabels, smoothOffset } from './label-layout';
import { motionSwitches } from './motion-profile';

/**
 * 锚点渲染层：设备图标 + 数值标签 + 状态着色 + 标签防重叠 + 呼吸/脉冲动效。
 *
 * ## 为什么标签用 CSS2DRenderer 而不是 Sprite/TextGeometry
 *
 * - `Sprite` 的文字需要预生成贴图，中文要额外加载字体（体积大），改文案要重建贴图；
 * - `TextGeometry` 需要字体文件（几十 MB），且是 3D 文字，缩小时糊成一团；
 * - `CSS2DRenderer` 用 DOM 元素承载标签：中文零成本、CSS 可调样式、可点击、缩放清晰。
 *   代价是「标签不参与深度遮挡」——本实现**不做遮挡**（被墙挡住的设备标签仍可见），
 *   这对运维场景反而是优点。
 *
 * ## 为什么图标用 Sprite
 *
 * 图标需要「始终面向相机」且「尺寸恒定」。Sprite 天然满足，且能精确控制屏幕尺寸；
 * 若用 CSS2D，缩放画布时标签会跟着变得巨大/极小。
 *
 * ## 标签防重叠（本次改造）
 *
 * 改造前 6 个锚点按 3D 投影直接摆标签，密集处**完全叠成一团**。现在：
 *
 * 1. 每 {@link LAYOUT_INTERVAL_MS}（约 10Hz）按屏幕坐标做一次矩形避让
 *    （算法在 `label-layout.ts`，纯函数可单测）；
 * 2. 被挤掉的标签**降级为只显示圆点**（仍然可 hover 展开、可点击 —— 不会凭空消失）；
 * 3. 位移带平滑过渡（`smoothOffset`），不抖。
 *
 * **不做每帧 raycast**：遮挡判断在这类运维场景没有价值（用户需要看到墙后的设备），
 * 每帧对 N 个锚点打射线在几十万面的建筑模型上是纯浪费。
 *
 * ## DOM 契约（供 hover 卡片集成，**稳定契约不要改**）
 *
 * | 选择器 | 含义 |
 * |---|---|
 * | `.twin-anchor-label` | 标签胶囊（含 `.twin-anchor-dot` 圆点与 `.twin-anchor-value` 数值） |
 * | `.twin-anchor-value` | 数值文本（hover 卡片可读取，与标签同步） |
 * | `.twin-anchor-label[data-point-id]` | 点位 ID |
 * | `.twin-anchor-label[data-collapsed]` | `"true"` = 被挤压，当前只显示圆点 |
 * | `.twin-anchor-label[data-hovered]` | `"true"` = 当前 hover |
 * | `.twin-anchor-label[data-alert]` | `"true"` = 有活动告警 |
 *
 * 标签元素使用 `position:absolute; left/top` + `--twin-offset-*` CSS 变量，
 * hover 卡片可以用 `getBoundingClientRect()` 直接定位，不会与避让位移打架。
 */

/** 单个锚点在场景中的节点集合。 */
interface AnchorNode {
  /** 胶囊视觉层（圆点 + 设备名 + 数值），相对外层做「挂到圆点上方」定位。 */
  capsule: HTMLDivElement;
  descriptor: AnchorDescriptor;
  /** 当前避让偏移（平滑后的值，CSS 像素）。 */
  currentOffset: { x: number; y: number };
  /** 当前是否降级为圆点。 */
  collapsed: boolean;
  /** 圆点元素（始终显示；悬停区域）。 */
  dot: HTMLSpanElement;
  /** 是否处于 hover 态。 */
  hovered: boolean;
  /** 上一帧的锚点屏幕坐标（用于判断是否需要重排）。 */
  lastScreen?: { x: number; y: number };
  /** CSS2D 标签的 DOM 元素（胶囊：圆点 + 设备名 + 数值）。 */
  labelElement: HTMLDivElement;
  /** 上次写入的数值文本（用于检测「跳变」触发闪烁）。 */
  lastPrimaryText?: string;
  /** 上次写入的告警数（用于告警扩散环的触发）。 */
  lastAlertCount: number;
  /** 标签矩形（最近一次布局结果，供 hover 卡片读取）。 */
  layoutRect?: LabelLayout['rect'];
  /** Sprite 图标。 */
  sprite: THREE_NS.Sprite;
  /** 数值文本节点（与标签文本分离：跳变高亮只作用于数值，不影响设备名）。 */
  valueElement: HTMLSpanElement;
}

/** 状态色统一来自调色板模块（3D 画布与图例共用，保证两处永不漂移）。 */
const COLOR_ONLINE = TWIN_COLOR_ONLINE;

/** 离线色。 */
const COLOR_OFFLINE = TWIN_COLOR_OFFLINE;

/** 未知态色（平台还没拿到过该设备的连接事件，**不代表离线**）。 */
const COLOR_UNKNOWN = TWIN_COLOR_UNKNOWN;

/** 停用设备的颜色（灰化，比离线更深）。 */
const COLOR_DISABLED = TWIN_COLOR_DISABLED;

/** 告警色。 */
const COLOR_ALERT = TWIN_COLOR_ALERT;

/** 告警闪烁的浅色相位。 */
const COLOR_ALERT_DIM = TWIN_COLOR_ALERT_DIM;

/** 告警闪烁的半周期（毫秒）。 */
export const ALERT_BLINK_HALF_PERIOD_MS = 600;

/** 标签避让的重排间隔（毫秒，约 10Hz：避让不需要跟满帧率，省 CPU）。 */
export const LAYOUT_INTERVAL_MS = 100;

/** 图标在屏幕上的缩放（`sizeAttenuation=false` 时的屏幕比例）。 */
const ICON_SCREEN_SCALE = 0.045;

/** 图标贴图的画布边长（像素）。 */
const ICON_TEXTURE_SIZE = 64;

/** 标签理想位移：圆点正上方多少像素（「挂绳」感）。 */
const LABEL_LIFT_PX = 14;

/** 标签碰撞盒的估算宽度上限（设备名 + 数值，中文 12px 约 12px/字）。 */
const LABEL_ESTIMATED_HEIGHT_PX = 22;

/** 标签最小估算宽度（只有圆点时的圆点直径 14px + 内边距）。 */
const LABEL_MIN_WIDTH_PX = 18;

/** 布局容差（与圆点半径相关：标签以「圆点中心」为锚，左右各伸一半）。 */
const DOT_DIAMETER_PX = 14;

/** 数值跳变高亮的持续时间（毫秒）。 */
export const VALUE_FLASH_MS = 600;

/** hover 时标签的放大倍数。 */
const HOVER_SCALE = 1.12;

/** `pointermove` 的节流间隔（毫秒，约 30Hz：hover 判定不需要跟满帧率）。 */
export const POINTER_MOVE_THROTTLE_MS = 33;

/** 几何命中的容差（像素）：命中半径 = 圆点半径 + 该容差（手指/触控板更好点中）。 */
export const HOVER_HIT_TOLERANCE_PX = 6;

/** CSS2D 模块的最小接口（由调用方动态 import 后传入）。 */
export interface Css2dModule {
  CSS2DObject: new (element: HTMLElement) => THREE_NS.Object3D;
  CSS2DRenderer: new (parameters?: { element?: HTMLElement }) => {
    domElement: HTMLElement;
    // 注意参数类型是 `Scene`（@types/three 的 CSS2DRenderer.render 签名如此），
    // 不是更宽的 `Object3D`——写宽了会与真实类型不兼容（构造签名不协变）。
    render: (scene: THREE_NS.Scene, camera: THREE_NS.Camera) => void;
    setSize: (width: number, height: number) => void;
  };
}

/** 锚点层实例（在 `AnchorLayer` 契约之上追加释放与动效能力）。 */
export interface AnchorLayerInstance extends AnchorLayer {
  /** 释放 DOM 与贴图（页面卸载时调用）。 */
  dispose: () => void;
  /**
   * 取锚点当前屏幕位置（相对画布容器左上角，**已含避让位移**）。
   *
   * 给 hover 卡片用：卡片应该贴着「标签最终落在哪」显示，而不是 3D 锚点本身。
   *
   * @param pointId 点位 ID
   * @returns 屏幕位置与是否可见；未挂载/不可见时 undefined
   */
  getLabelScreenPosition: (
    pointId: string,
  ) => undefined | { visible: boolean; x: number; y: number };
  /** 当前动效档位（`update` 时由 scene-manager 下发；未下发视为 normal）。 */
  setMotionMode: (mode: TwinMotionMode) => void;
  /** 设置 hover 点位（hover 卡片打开时由 manager 转发，用于阻止对应标签被降级）。 */
  setHovered: (pointId?: string) => void;
}

/** 锚点层交互回调。 */
export interface AnchorLayerCallbacks {
  /** 点击锚点标签/图标。 */
  onClickAnchor: (pointId: string) => void;
  /**
   * 悬停锚点（**离开时回调 `undefined`**）。
   *
   * ⚠️ 语义说明（向后兼容）：改造前签名是 `(pointId: string) => void`，只有「进入」没有「离开」，
   * 调用方无法知道 hover 结束（hover 卡片永远关不掉）。现在参数类型放宽为
   * `(pointId?: string | undefined) => void`：
   * - 进入：`onHoverAnchor('p1')`
   * - 离开：`onHoverAnchor(undefined)`
   *
   * 只写 `(pointId: string) => void` 的旧回调**依然能赋值**（参数逆变兼容），
   * 但收到 `undefined` 时需要自己判空 —— 推荐的写法是 `(pointId) => { if (!pointId) return; ... }`。
   */
  onHoverAnchor?: (pointId: string | undefined) => void;
}

/**
 * 创建锚点层。
 *
 * @param THREE three 命名空间（由调用方动态 import 后传入，避免本模块顶层 import）
 * @param CSS2D CSS2D 模块
 * @param container 画布容器（CSS2D 渲染器的 DOM 会 append 到这里）
 * @param callbacks 交互回调
 * @returns 锚点层实例
 */
export function createAnchorLayer(
  THREE: typeof THREE_NS,
  CSS2D: Css2dModule,
  container: HTMLElement,
  callbacks: AnchorLayerCallbacks,
): AnchorLayerInstance {
  const nodes = new Map<string, AnchorNode>();
  let currentStates = new Map<string, AnchorRuntimeState>();
  let blinkTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  let blinkOn = true;
  let motionMode: TwinMotionMode = 'normal';
  /**
   * 告警扩散环的相位（秒）。
   *
   * 用**时间累积**而不是 CSS 动画：CSS 动画在 `reduced` 档需要关掉，而关掉后
   * 「已扩散到一半」的环需要能立刻停在静止相位，用时间变量最直接。
   */
  let ripplePhaseSeconds = 0;
  let hoveredPointId: string | undefined;
  /** 上一次处理 `pointermove` 的时间（节流用）。 */
  let lastPointerMoveAt = Number.NEGATIVE_INFINITY;
  /** 容器当前的鼠标位置（相对容器左上角；用于几何命中）。 */
  const pointer = { active: false, x: 0, y: 0 };
  let containerSize = {
    height: container.clientHeight || 600,
    width: container.clientWidth || 800,
  };
  let lastLayoutAt = Number.NEGATIVE_INFINITY;
  /** 上一帧的时间戳（用于算帧间隔；首帧为 undefined）。 */
  let previousFrameNow: number | undefined;

  const css2dRenderer = new CSS2D.CSS2DRenderer();
  css2dRenderer.domElement.style.cssText = [
    'position:absolute',
    'inset:0',
    'pointer-events:none',
    'overflow:hidden',
  ].join(';');
  // 与 3D 内容同层：标签必须压在画布上方、又不能挡住 fadeOverlay（z-index 1）
  css2dRenderer.domElement.style.zIndex = '2';
  container.append(css2dRenderer.domElement);

  // 图标贴图：canvas 现画圆底 + 内圈，按状态由材质 color 染色（一张贴图表现全部状态色）
  const iconTexture = createIconTexture(THREE);

  // ---- hover 判定：容器上的 pointermove + 几何命中（不依赖标签 DOM 命中测试） ----
  // 用 `passive`：只监听不阻止默认行为（否则会拖慢画布拖拽/滚动）
  const listenerOptions = { passive: true } as const;
  container.addEventListener('pointermove', onPointerMove, listenerOptions);
  container.addEventListener('pointerleave', onPointerLeave, listenerOptions);

  // ---- 共享样式：一次性注入 <style>（每个标签一行内联样式既冗余又难统一维护） ----
  const styleElement = document.createElement('style');
  styleElement.textContent = `
.twin-anchor-label {
  /* 外层：只负责「挂点位置」与悬停热区，**不画任何视觉**。
     ⚠️ pointer-events 必须显式 auto：CSS2DRenderer 的 domElement 是 pointer-events:none，
     子元素只有自己设 auto 才能重新成为命中目标（否则鼠标事件穿透到底下的 canvas）。 */
     层级：position(0,0) → CSS2DRenderer 的 translate(-50%,-50%) + translate(x,y)
     → 本层的 left/top（左上角 = 圆点中心）
     → 内层胶囊的 translate(-圆点半径, -100% - 间距)（把胶囊挂到圆点正上方） */
  position: absolute;
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  transition: opacity 160ms ease-out;
}
.twin-anchor-capsule {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: ${LABEL_ESTIMATED_HEIGHT_PX}px;
  box-sizing: border-box;
  padding: 0 8px 0 3px;
  border-radius: 999px;
  background: ${TWIN_COLOR_LABEL_BG};
  border: 1px solid ${TWIN_COLOR_LABEL_CAPSULE_BORDER};
  box-shadow: 0 2px 8px ${TWIN_COLOR_LABEL_SHADOW};
  color: ${TWIN_COLOR_LABEL_TEXT};
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
  transform: translate(-${DOT_DIAMETER_PX / 2}px, calc(-100% - ${LABEL_LIFT_PX - 8}px))
    scale(var(--twin-hover-scale, 1));
  transform-origin: ${DOT_DIAMETER_PX / 2}px 100%;
  transition: transform 120ms ease-out, box-shadow 120ms ease-out,
    border-color 120ms ease-out;
  will-change: transform;
}
.twin-anchor-label[data-hovered='true'] .twin-anchor-capsule {
  border-color: ${TWIN_COLOR_LABEL_CAPSULE_BORDER_HOVER};
  box-shadow: 0 2px 10px ${TWIN_COLOR_LABEL_SHADOW}, 0 0 0 2px ${TWIN_COLOR_LABEL_GLOW};
  z-index: 10;
}
.twin-anchor-dot {
  position: relative;
  flex: none;
  width: ${DOT_DIAMETER_PX}px;
  height: ${DOT_DIAMETER_PX}px;
  border-radius: 50%;
  border: 2px solid rgba(255,255,255,.92);
  box-sizing: border-box;
  box-shadow: 0 0 6px currentColor;
  background: currentColor;
}
.twin-anchor-dot::after {
  content: '';
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  border: 1px solid currentColor;
  opacity: 0;
  pointer-events: none;
}
.twin-anchor-label[data-alert='true'] .twin-anchor-dot::after {
  opacity: 0.75;
}
.twin-anchor-name {
  color: ${TWIN_COLOR_LABEL_TEXT};
}
.twin-anchor-value {
  color: ${TWIN_COLOR_LABEL_TEXT};
  font-variant-numeric: tabular-nums;
  transition: color 160ms ease-out, text-shadow 160ms ease-out;
}
.twin-anchor-value[data-muted='true'] {
  color: ${TWIN_COLOR_LABEL_TEXT_MUTED};
}
.twin-anchor-value[data-flash='true'] {
  color: #fff;
  text-shadow: 0 0 8px ${TWIN_COLOR_LABEL_CAPSULE_BORDER_HOVER};
}
.twin-anchor-label[data-collapsed='true'] .twin-anchor-capsule {
  padding-right: 3px;
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}
.twin-anchor-label[data-collapsed='true'] .twin-anchor-name,
.twin-anchor-label[data-collapsed='true'] .twin-anchor-value {
  display: none;
}
`;
  container.append(styleElement);

  /** 容器尺寸（避让布局的边界）。 */
  function currentBounds(): { height: number; width: number } {
    return {
      height: container.clientHeight || containerSize.height,
      width: container.clientWidth || containerSize.width,
    };
  }

  function attach(
    modelRoot: THREE_NS.Object3D,
    anchors: AnchorDescriptor[],
  ): void {
    detach();
    for (const anchor of anchors) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          // 不被模型遮挡：运维需要看到「墙后的设备」
          depthTest: false,
          map: iconTexture,
          // 恒定屏幕尺寸：缩放画布时图标不会变成巨块
          sizeAttenuation: false,
          transparent: true,
        }),
      );
      sprite.scale.set(ICON_SCREEN_SCALE, ICON_SCREEN_SCALE, 1);
      sprite.position.set(anchor.local.x, anchor.local.y, anchor.local.z);
      sprite.renderOrder = 999;
      sprite.userData.pointId = anchor.pointId;
      sprite.userData.isTwinAnchor = true;

      // 标签结构：胶囊 = 圆点 + 设备名 + 数值
      // 参考图的做法：小圆点 + 半透明胶囊；数值保留在标签里（运维场景要看实时值），
      // 但只用弱色小字，视觉权重低于设备名。
      const labelElement = document.createElement('div');
      labelElement.className = 'twin-anchor-label';
      labelElement.dataset.pointId = anchor.pointId;

      const dot = document.createElement('span');
      dot.className = 'twin-anchor-dot';

      const nameElement = document.createElement('span');
      nameElement.className = 'twin-anchor-name';
      nameElement.textContent = anchor.deviceName;

      const valueElement = document.createElement('span');
      valueElement.className = 'twin-anchor-value';

      const capsule = document.createElement('div');
      capsule.className = 'twin-anchor-capsule';
      capsule.append(dot, nameElement, valueElement);
      labelElement.append(capsule);

      capsule.addEventListener('click', (event) => {
        event.stopPropagation();
        callbacks.onClickAnchor(anchor.pointId);
      });
      capsule.addEventListener('pointerenter', () => {
        setHovered(anchor.pointId);
      });
      capsule.addEventListener('pointerleave', () => {
        if (hoveredPointId === anchor.pointId) {
          setHovered(undefined);
        }
      });

      const labelObject = new CSS2D.CSS2DObject(labelElement);
      labelObject.position.set(anchor.local.x, anchor.local.y, anchor.local.z);
      // 标签默认显隐由配置项 labelVisible 决定
      labelElement.style.display = anchor.labelVisible ? '' : 'none';

      modelRoot.add(sprite);
      modelRoot.add(labelObject);
      nodes.set(anchor.pointId, {
        capsule,
        collapsed: false,
        currentOffset: { x: 0, y: 0 },
        descriptor: anchor,
        dot,
        hovered: false,
        labelElement,
        lastAlertCount: 0,
        lastPrimaryText: undefined,
        sprite,
        valueElement,
      });
    }
    // 重放**已收到**的运行态：数据通常比模型先到（先拉 runtime 再加载 GLB），
    // 不重放会让标签停在空文本，直到设备下次上报才有内容（那时用户早已认为功能坏了）。
    if (currentStates.size > 0) {
      applyStates();
      ensureBlinkTimer();
    }
  }

  /**
   * 卸载锚点的 DOM/贴图。
   *
   * ⚠️ **刻意不清空 `currentStates`**（这是线上实测修掉的缺陷）：
   * 运行态快照是**先于**模型加载到达的（`index.vue` 先拉点位与 runtime，画布再异步加载模型）。
   * 若这里清掉已收到的状态，`attach()` 之后就没有数据可重放 ⇒ **锚点标签永远是空白**，
   * 而界面又不报错（表现为「有图标没文字」）。
   * 数据由 `update()` 持续覆盖，按点位 ID 关联，换场景后旧 ID 自然不会被命中，无需手工清理。
   */
  function detach(): void {
    clearFlashTimers();
    pointer.active = false;
    hoveredPointId = undefined;
    for (const node of nodes.values()) {
      node.sprite.removeFromParent();
      node.sprite.material.dispose();
      node.labelElement.remove();
    }
    nodes.clear();
    hoveredPointId = undefined;
  }

  function update(states: Map<string, AnchorRuntimeState>): void {
    currentStates = states;
    applyStates();
    ensureBlinkTimer();
  }

  /** 数值跳变闪烁的定时器（按点位 ID 索引）。 */
  const flashTimers = new Map<
    string,
    ReturnType<typeof globalThis.setTimeout>
  >();

  function clearFlashTimers(): void {
    for (const timer of flashTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    flashTimers.clear();
  }

  /**
   * 把 `currentStates` 应用到 DOM 与 sprite 材质。
   *
   * 数值跳变检测也在这里做：`primaryText` 与上次不同 ⇒ 闪一下。
   * **与 600ms 闪烁定时器不打架**：闪烁定时器只改 `data-alert` / sprite 颜色，
   * 数值高亮改的是 `.twin-anchor-value[data-flash]`，两者作用在不同属性上。
   */
  function applyStates(): void {
    const switches = motionSwitches(motionMode);
    for (const [pointId, node] of nodes) {
      const state = currentStates.get(pointId);
      // color 形态：图标按数值色阶染色（越界变红），比状态色更能反映「值有多糟」
      const color =
        state?.renderMode === 'color' && state.colorRatio !== undefined
          ? colorForRatio(state.colorRatio)
          : resolveColor(state);
      node.sprite.material.color.set(color);
      // 圆点用 `currentColor` 表达状态色（CSS 变量比重复写 border/background 更稳）
      node.dot.style.color = color;

      // ---- 数值跳变高亮（一次性，reduced/off 也保留：它是信息载体） ----
      const text = state?.primaryText?.trim() ? state.primaryText : '--';
      if (node.lastPrimaryText !== undefined && node.lastPrimaryText !== text) {
        flashValue(node);
      }
      node.lastPrimaryText = text;
      node.valueElement.textContent = text;
      node.valueElement.dataset.muted = String(state?.hasValue === false);

      // ---- 告警扩散环（状态变化时才动，不做每帧 DOM 写） ----
      const alertCount = state?.alertCount ?? 0;
      if (alertCount > 0) {
        node.labelElement.dataset.alert = 'true';
      } else {
        delete node.labelElement.dataset.alert;
      }
      node.lastAlertCount = alertCount;

      if (!node.descriptor.labelVisible) {
        node.labelElement.style.display = 'none';
        continue;
      }
      node.labelElement.style.display = '';
      // **按 displayType 分形态渲染**（工单 #126）。
      // 修复前五种形态渲染完全一样，等于「配置项说谎」；现在 switch/color 有真实差异，
      // 未实现的 gauge/sparkline 由 toRenderMode 回落为 label，并在 UI 上标注「暂不支持」。
      const mode = state?.renderMode ?? toRenderMode('value');
      if (mode === 'switch') {
        node.valueElement.textContent = switchGlyph(state);
      } else if (mode === 'color' && state?.colorRatio !== undefined) {
        node.labelElement.style.borderColor = colorForRatio(state.colorRatio);
      }
      // 无数据（hasValue=false）时标签用弱化色，明确告诉用户「这是没有数据，不是 0」
      node.valueElement.dataset.muted = String(state?.hasValue === false);
      if (mode !== 'color') {
        node.labelElement.style.borderColor =
          (state?.alertCount ?? 0) > 0
            ? TWIN_COLOR_LABEL_BORDER_ALERT
            : TWIN_COLOR_LABEL_BORDER;
      }
    }
    // 动效开关：关闭呼吸/扩散环时把残留的内联透明度复位（避免「停在半透明」）
    if (!switches.anchorPulse) {
      for (const node of nodes.values()) {
        if (node.labelElement.style.opacity) {
          node.labelElement.style.opacity = '';
        }
      }
    }
  }

  /** 数值跳变闪一下（一次性）。 */
  function flashValue(node: AnchorNode): void {
    if (!motionSwitches(motionMode).valueFlash) {
      return;
    }
    node.valueElement.dataset.flash = 'true';
    const existing = flashTimers.get(node.descriptor.pointId);
    if (existing !== undefined) {
      globalThis.clearTimeout(existing);
    }
    const timer = globalThis.setTimeout(() => {
      flashTimers.delete(node.descriptor.pointId);
      node.valueElement.dataset.flash = 'false';
    }, VALUE_FLASH_MS);
    flashTimers.set(node.descriptor.pointId, timer);
  }

  /**
   * `switch` 形态的符号：开 = ●（实心，配合状态色），关 = ○（空心）。
   *
   * 无法判定（非二值属性 / 无数据）时渲染 `--`，**不猜**它当前是开还是关。
   *
   * @param state 运行态
   * @returns 展示文本
   */
  function switchGlyph(state?: AnchorRuntimeState): string {
    if (state?.switchState === undefined) {
      return '--';
    }
    // 二态用 ASCII 符号而不是中文字符：引擎层不做 i18n（不许出现用户可见文案），
    // 而 ●/○ 是状态符号不是文案，任何语言下含义一致。
    return state.switchState ? '●' : '○';
  }

  /**
   * 由运行态算颜色。
   *
   * 优先级：停用 > 告警 > 在线 > 离线 > 未知。停用优先于告警是因为停用设备本来就不采集，
   * 即使有历史告警也不该继续闪（那会让运维误以为它在正常上报告警）。
   */
  function resolveColor(state?: AnchorRuntimeState): string {
    if (state?.status === 0) {
      return COLOR_DISABLED;
    }
    if ((state?.alertCount ?? 0) > 0) {
      return blinkOn ? COLOR_ALERT : COLOR_ALERT_DIM;
    }
    if (state?.onlineStatus === 'online') {
      return COLOR_ONLINE;
    }
    if (state?.onlineStatus === 'offline') {
      return COLOR_OFFLINE;
    }
    // unknown / 空（设备已不存在）：不确定就用警示色，不要伪装成在线
    return COLOR_UNKNOWN;
  }

  /** 锚点的优先级（告警 > 在线 > 离线/未知 > 停用）：决定避让时谁占原位置。 */
  function priorityOf(node: AnchorNode): number {
    const state = currentStates.get(node.descriptor.pointId);
    if ((state?.alertCount ?? 0) > 0) {
      return 3;
    }
    if (state?.status === 0) {
      return 0;
    }
    if (state?.onlineStatus === 'online') {
      return 2;
    }
    return 1;
  }

  /**
   * 只有存在告警时才有必要跑闪烁定时器（空闲时不留后台开销）。
   *
   * 每次 `update` 都会重算「是否有告警」（O(n) 遍历）。500 点位 × 60fps = 30k 次/秒的
   * 简单比较，可接受；若将来点位上千再改为事件驱动。
   */
  function ensureBlinkTimer(): void {
    const hasAlert = [...currentStates.values()].some(
      (state) => (state.alertCount ?? 0) > 0,
    );
    if (hasAlert && blinkTimer === undefined) {
      blinkTimer = globalThis.setInterval(() => {
        blinkOn = !blinkOn;
        applyStates();
      }, ALERT_BLINK_HALF_PERIOD_MS);
    } else if (!hasAlert && blinkTimer !== undefined) {
      globalThis.clearInterval(blinkTimer);
      blinkTimer = undefined;
      blinkOn = true;
    }
  }

  /** 标签估算尺寸（避让用的碰撞盒）。 */
  function measureLabel(node: AnchorNode): { height: number; width: number } {
    // 用真实 DOM 尺寸（标签已经渲染过一帧后 offsetWidth 有效）；
    // 首帧未布局时退回按字符数估算，保证避让在首帧就有合理结果。
    const width = node.capsule.offsetWidth;
    if (width > 0) {
      return {
        height: node.capsule.offsetHeight || LABEL_ESTIMATED_HEIGHT_PX,
        width,
      };
    }
    const name = node.descriptor.deviceName;
    const value = node.valueElement.textContent ?? '';
    // 中日韩字符按 12px、其余按 7px 粗估
    const estimate = (text: string): number =>
      [...text].reduce(
        (sum, char) => sum + ((char.codePointAt(0) ?? 0) > 255 ? 12 : 7),
        0,
      );
    return {
      height: LABEL_ESTIMATED_HEIGHT_PX,
      width: Math.max(
        LABEL_MIN_WIDTH_PX,
        estimate(name) + estimate(value) + DOT_DIAMETER_PX + 20,
      ),
    };
  }

  /** 取各节点的屏幕坐标（用 CSS2D 已算好的 transform，避免自己做一遍投影）。 */
  function readScreenPosition(
    node: AnchorNode,
  ): undefined | { x: number; y: number } {
    const transform = node.labelElement.style.transform;
    // CSS2DRenderer 写的是 `translate(-50%,-50%) translate(123px,456px)`
    const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(transform);
    if (!match) {
      return undefined;
    }
    const x = Number(match[1]);
    const y = Number(match[2]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  }

  /**
   * 执行一次避让布局并把结果写到 DOM。
   *
   * @param deltaSeconds 距上次布局的秒数（用于平滑过渡）
   */
  function relayout(deltaSeconds: number): void {
    const bounds = currentBounds();
    const entries: Array<{
      input: LabelInput;
      node: AnchorNode;
      screen: { x: number; y: number };
    }> = [];
    for (const node of nodes.values()) {
      if (!node.descriptor.labelVisible) {
        continue;
      }
      const screen = readScreenPosition(node);
      if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) {
        continue;
      }
      node.lastScreen = screen;
      const size = measureLabel(node);
      entries.push({
        input: {
          anchor: screen,
          idealDisplacement: { x: 0, y: -LABEL_LIFT_PX },
          // hover 中的标签不参与避让：否则鼠标一放上去它就被挤走，点击会落空
          layout: !node.hovered,
          pointId: node.descriptor.pointId,
          priority: priorityOf(node),
          size,
        },
        node,
        screen,
      });
    }
    if (entries.length === 0) {
      return;
    }
    const layouts = layoutLabels(
      entries.map((entry) => entry.input),
      bounds,
    );
    const smooth = motionSwitches(motionMode).smoothLabels;
    for (const [index, entry] of entries.entries()) {
      const layout = layouts[index];
      if (!layout) {
        continue;
      }
      const { node } = entry;
      node.layoutRect = layout.rect;
      const target = layout.offset;
      node.currentOffset = smooth
        ? smoothOffset(node.currentOffset, target, deltaSeconds)
        : { ...target };
      applyLabelTransform(node, entry.screen, layout);
    }
  }

  /**
   * 把避让结果写进标签样式。
   *
   * 位置用 `left/top` 而不是 `transform`：CSS2DRenderer 每帧会**整体重写** `transform`，
   * 写到 transform 里会被它覆盖掉。
   *
   * @param node 节点
   * @param screen 锚点屏幕坐标
   * @param layout 布局结果
   */
  function applyLabelTransform(
    node: AnchorNode,
    screen: { x: number; y: number },
    layout: LabelLayout,
  ): void {
    const element = node.labelElement;
    const size = measureLabel(node);
    // 标签以「圆点中心」为锚：圆点在胶囊左侧，所以左边距 = 圆点半径
    // 说明：CSS2DRenderer 每帧会把 element 放到 (screen.x, screen.y) 并写
    // `transform: translate(-50%,-50%)`。因此这里用 `left/top` 指定「圆心」，
    // 再配合 CSS 里的 `translate(-DOT/2, -100%-LIFT)` 把胶囊挂到圆点正上方。
    const left = screen.x - DOT_DIAMETER_PX / 2 + node.currentOffset.x;
    const top = screen.y - LABEL_LIFT_PX + node.currentOffset.y;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.dataset.collapsed = String(layout.collapsed);
    node.collapsed = layout.collapsed;
    // hover 放大：用 CSS 变量变换叠加（**不能写 transform**：CSS2DRenderer 每帧重写它，
    // 会把缩放覆盖掉，表现为「hover 没反应」）
    element.style.setProperty(
      '--twin-hover-scale',
      String(node.hovered && !layout.collapsed ? HOVER_SCALE : 1),
    );
    void size;
  }

  /**
   * 由鼠标位置找最近的锚点（**纯几何，不依赖 DOM 命中测试**）。
   *
   * 为什么必须有这条路径（线上实测）：CSS2DRenderer 每帧重写标签的 `transform`，
   * 而它的 domElement 是 `pointer-events:none`；一旦有任何父级（标签外层/胶囊）
   * 忘记恢复 `pointer-events:auto`，鼠标事件就整条穿透到 canvas 上 ——
   * 于是「悬停标签出卡片」静默失效，且 DOM 层面完全看不出来。
   * 用屏幕坐标做距离检测与 DOM 布局无关，最稳。
   *
   * @param screenX 相对容器左上角的 X
   * @param screenY 相对容器左上角的 Y
   * @returns 命中的点位与距离；未命中 undefined
   */
  function hitTestAnchor(
    screenX: number,
    screenY: number,
  ): undefined | { distance: number; pointId: string } {
    const radius = DOT_DIAMETER_PX / 2 + HOVER_HIT_TOLERANCE_PX;
    let best: undefined | { distance: number; pointId: string };
    for (const node of nodes.values()) {
      if (!node.descriptor.labelVisible) {
        continue;
      }
      const screen = node.lastScreen;
      if (!screen) {
        continue;
      }
      const dx = screen.x - screenX;
      const dy = screen.y - screenY;
      const distance = Math.hypot(dx, dy);
      if (distance > radius) {
        continue;
      }
      if (!best || distance < best.distance) {
        best = { distance, pointId: node.descriptor.pointId };
      }
    }
    return best;
  }

  /**
   * 处理 `pointermove`（节流到 ~30Hz + 几何命中）。
   *
   * 节流只限制「跑几何检测」的频率：位置每次都记录（否则最后一次移动会被丢掉，
   * 鼠标停在标签上不动时 hover 判定就永远停留在旧位置）。
   */
  function onPointerMove(event: MouseEvent | PointerEvent): void {
    updatePointerPosition(event);
    const nowMs =
      typeof performance === 'undefined' ? Date.now() : performance.now();
    if (nowMs - lastPointerMoveAt < POINTER_MOVE_THROTTLE_MS) {
      return;
    }
    lastPointerMoveAt = nowMs;
    const hit = hitTestAnchor(pointer.x, pointer.y);
    setHovered(hit?.pointId);
  }

  /** 把指针位置换算成「相对画布容器左上角」的坐标。 */
  function updatePointerPosition(event: MouseEvent | PointerEvent): void {
    const rect = container.getBoundingClientRect();
    pointer.active = true;
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
  }

  /** 指针离开画布：解除 hover（否则卡片会一直挂着）。 */
  function onPointerLeave(): void {
    pointer.active = false;
    setHovered(undefined);
  }

  /** 设置 hover 点位（内部与外部共用）。 */
  function setHovered(pointId?: string): void {
    if (hoveredPointId === pointId) {
      return;
    }
    const previous = hoveredPointId ? nodes.get(hoveredPointId) : undefined;
    if (previous) {
      previous.hovered = false;
      previous.labelElement.dataset.hovered = 'false';
      previous.labelElement.style.setProperty('--twin-hover-scale', '1');
    }
    hoveredPointId = pointId;
    const next = pointId ? nodes.get(pointId) : undefined;
    if (next) {
      next.hovered = true;
      next.labelElement.dataset.hovered = 'true';
      // hover 时强制展开（被挤压降级成圆点的标签，hover 要能看到内容）
      next.labelElement.dataset.collapsed = 'false';
      next.labelElement.style.setProperty(
        '--twin-hover-scale',
        String(HOVER_SCALE),
      );
    }
    callbacks.onHoverAnchor?.(pointId);
  }

  /**
   * 每帧动效（呼吸/告警扩散环）。
   *
   * ⚠️ 只改 `opacity`（合成层属性）与 `--twin-ripple` 变量，不改布局属性：
   * 每帧写 `left/top` 会触发整屏重排（60fps 下 CPU 直接打满）。
   */
  function tickMotion(deltaSeconds: number): void {
    const switches = motionSwitches(motionMode);
    ripplePhaseSeconds += deltaSeconds;
    for (const node of nodes.values()) {
      const state = currentStates.get(node.descriptor.pointId);
      const element = node.labelElement;
      // hover 中的标签保持静止（用户正在读数，呼吸/闪烁会干扰）
      if (node.hovered) {
        element.style.opacity = '';
        continue;
      }
      if (state?.status === 0 || !state) {
        // 停用/无数据：不脉冲（避免「停用设备也在闪」的误导）
        element.style.opacity = '';
        delete element.dataset.pulse;
        continue;
      }
      const isAlert = (state.alertCount ?? 0) > 0;
      if (isAlert && switches.alertRipple) {
        // 告警强脉冲：两个不同相位的波叠加，形成「扩散环」的不规则节奏
        const wave =
          0.5 + 0.5 * Math.sin(ripplePhaseSeconds * Math.PI * 2 * 1.1);
        element.style.opacity = String(0.82 + wave * 0.18);
        element.style.setProperty(
          '--twin-ripple-scale',
          String(1 + wave * 0.06),
        );
      } else if (switches.anchorPulse && state.onlineStatus === 'online') {
        // 在线轻微脉动：幅度极小（1px 级），长时间看不会累
        const wave =
          0.5 + 0.5 * Math.sin(ripplePhaseSeconds * Math.PI * 2 * 0.5);
        element.style.opacity = String(0.92 + wave * 0.08);
      } else {
        element.style.opacity = '';
      }
    }
  }

  function dispose(): void {
    detach();
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerleave', onPointerLeave);
    if (blinkTimer !== undefined) {
      globalThis.clearInterval(blinkTimer);
      blinkTimer = undefined;
    }
    iconTexture.dispose();
    css2dRenderer.domElement.remove();
    styleElement.remove();
  }

  return {
    attach,
    detach,
    dispose,
    getLabelScreenPosition: (pointId) => {
      const node = nodes.get(pointId);
      if (!node) {
        return undefined;
      }
      const screen = node.lastScreen;
      if (!screen) {
        return undefined;
      }
      const visible =
        node.descriptor.labelVisible &&
        node.labelElement.style.display !== 'none' &&
        screen.x >= 0 &&
        screen.y >= 0 &&
        screen.x <= currentBounds().width &&
        screen.y <= currentBounds().height;
      return { visible, x: screen.x, y: screen.y };
    },
    render: (scene, camera) => {
      css2dRenderer.render(scene, camera);
      // ⚠️ 顺序要紧：先让 CSS2DRenderer 写完 transform（得到最新屏幕坐标），
      // 再做避让 —— 反过来会用上一帧的坐标布局，画面永远慢一帧（拖拽时明显滞后）。
      const nowMs =
        typeof performance === 'undefined' ? Date.now() : performance.now();
      const deltaSeconds =
        previousFrameNow === undefined
          ? 1 / 60
          : Math.max(0, Math.min(0.1, (nowMs - previousFrameNow) / 1000));
      previousFrameNow = nowMs;
      tickMotion(deltaSeconds);
      if (nowMs - lastLayoutAt >= LAYOUT_INTERVAL_MS) {
        lastLayoutAt = nowMs;
        relayout(deltaSeconds);
      }
    },
    resize: (width, height) => {
      containerSize = { height, width };
      css2dRenderer.setSize(width, height);
      // 尺寸变化后必须立刻重排：否则标签会按旧边界摆放（缩放窗口后标签跑到画布外）
      lastLayoutAt = Number.NEGATIVE_INFINITY;
    },
    setHovered,
    setMotionMode: (mode) => {
      motionMode = mode;
      // 档位变化立即重放一次状态：让「关闭脉冲」马上生效（不等下一次 update）
      applyStates();
    },
    update,
  };
}

/**
 * 生成图标贴图（圆底 + 内圈）。
 *
 * 用 canvas 现画而不是加载图片：图标要按状态着色，贴图本身用白色、由 sprite 材质的
 * `color` 相乘染色 ⇒ 一张贴图可以表现全部状态色，不需要为每种状态准备一张图。
 *
 * @param THREE three 命名空间
 * @returns 贴图
 */
function createIconTexture(THREE: typeof THREE_NS): THREE_NS.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_TEXTURE_SIZE;
  canvas.height = ICON_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (context) {
    context.clearRect(0, 0, ICON_TEXTURE_SIZE, ICON_TEXTURE_SIZE);
    // 圆底（白色，由 sprite 材质 color 染色）
    context.fillStyle = TWIN_COLOR_ICON_BASE;
    context.beginPath();
    context.arc(
      ICON_TEXTURE_SIZE / 2,
      ICON_TEXTURE_SIZE / 2,
      ICON_TEXTURE_SIZE * 0.36,
      0,
      Math.PI * 2,
    );
    context.fill();
    // 内圈深色，形成「环 + 心」的视觉，缩小后仍可辨认
    context.fillStyle = TWIN_COLOR_ICON_INNER;
    context.beginPath();
    context.arc(
      ICON_TEXTURE_SIZE / 2,
      ICON_TEXTURE_SIZE / 2,
      ICON_TEXTURE_SIZE * 0.22,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * 从命中对象上取点位 ID（拾取层的公共工具）。
 *
 * @param object 命中对象
 * @returns 点位 ID；非锚点对象返回 undefined
 */
export function readPointIdFromObject(
  object: THREE_NS.Object3D,
): string | undefined {
  const { pointId } = object.userData as { pointId?: string };
  return typeof pointId === 'string' ? pointId : undefined;
}

/** 扩散环颜色（供 UI 层图例使用，避免两处色值漂移）。 */
export const TWIN_ANCHOR_RIPPLE_COLOR = TWIN_COLOR_ALERT_RIPPLE;

/** 中性圆点色（供 UI 层图例使用）。 */
export const TWIN_ANCHOR_DOT_NEUTRAL_COLOR = TWIN_COLOR_DOT_NEUTRAL;
