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
  TWIN_COLOR_DOT_RING_LIGHT,
  TWIN_COLOR_ICON_BASE,
  TWIN_COLOR_ICON_INNER,
  TWIN_COLOR_LABEL_BG,
  TWIN_COLOR_LABEL_BG_LIGHT,
  TWIN_COLOR_LABEL_BORDER,
  TWIN_COLOR_LABEL_BORDER_ALERT,
  TWIN_COLOR_LABEL_BORDER_LIGHT,
  TWIN_COLOR_LABEL_CAPSULE_BORDER,
  TWIN_COLOR_LABEL_CAPSULE_BORDER_HOVER,
  TWIN_COLOR_LABEL_GLOW,
  TWIN_COLOR_LABEL_SHADOW,
  TWIN_COLOR_LABEL_SHADOW_LIGHT,
  TWIN_COLOR_LABEL_TEXT,
  TWIN_COLOR_LABEL_TEXT_LIGHT,
  TWIN_COLOR_LABEL_TEXT_MUTED,
  TWIN_COLOR_LABEL_TEXT_MUTED_LIGHT,
  TWIN_COLOR_OFFLINE,
  TWIN_COLOR_ONLINE,
  TWIN_COLOR_UNKNOWN,
} from './colors';
import { colorForRatio, toRenderMode } from './display';
import { clampLabelRect, layoutLabels, smoothOffset } from './label-layout';
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
  /**
   * 胶囊的屏幕矩形（相对容器左上角；仅在 ~10Hz 的重排那一轮刷新）。
   *
   * 为什么不在每帧读 `getBoundingClientRect()`：那是**强制同步布局**（layout thrash），
   * 6~64 个标签 × 60fps 会把主线程拖住。10Hz 刷新对 hover 判定完全够用
   * （相机运动时标签最多滞后 100ms，而鼠标本身也在动）。
   */
  lastCapsuleRect?: { height: number; width: number; x: number; y: number };
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

/**
 * 胶囊矩形的命中容差（像素）。
 *
 * 胶囊本身就是可见热区，容差只需一点点（防「贴着边缘差 1px」的手抖）；
 * 给太大会让相邻标签的热区在视觉空隙里重叠，出现「指到空白处却是上一个点」的错觉。
 */
export const HOVER_RECT_TOLERANCE_PX = 4;

/**
 * hover 粘滞时长（毫秒）。
 *
 * 为什么需要：`hitTestAnchor` 的两条依据**不同源**——胶囊矩形来自 DOM 实测
 * （`getBoundingClientRect`），圆点圆来自 3D 投影（`lastScreen`）。相机移动或标签刚
 * 重排的那一帧两者可能差几十像素，表现为 `setHovered(pid)` → 下一帧几何判不中 →
 * `setHovered(undefined)` → **卡片刚出现就消失**（dev 实测命中序列 true→false→false）。
 * 粘滞期内即使几何暂时不命中也不清空，直到鼠标真正移出胶囊矩形外扩
 * {@link HOVER_STICKY_EXIT_MARGIN_PX}px 或触发 `pointerleave`。
 */
export const HOVER_STICKY_MS = 260;

/**
 * 「待定关闭」延时（毫秒）。
 *
 * 几何判定未命中时**不再立即清空 hover**，而是排一个延时清除：
 * 期间任何 DOM 命中（胶囊 pointerover/pointermove）或几何命中都会取消它。
 *
 * 为什么必须这样（线上实测的最后一个缺陷）：指针一直在胶囊内时
 * `pointerenter` **只触发一次**，之后再也不会触发。一旦几何判定在节流后那次误判失败
 * 而硬清空 hover，就再没有任何事件能把它恢复 ⇒「首次能出、之后大概率不出」。
 * **DOM 事件才是权威，几何只作补充**。
 */
export const HOVER_PENDING_CLEAR_MS = 300;

/**
 * 粘滞期内判定「真正离开」的外扩距离（像素）。
 *
 * 取值要明显大于用户的「手抖/微移」幅度：16px 约等于一个中文字符宽度，
 * 鼠标在标签边缘轻晃不会导致卡片消失；真正移开（去点别的设备）必然超过它。
 */
export const HOVER_STICKY_EXIT_MARGIN_PX = 16;

/**
 * 坐标同源检查的告警阈值（像素）。
 *
 * `lastScreen`（投影）与胶囊矩形（DOM 实测）在同一个标签上正常应相差「圆点半径 + 抬升量」
 * 左右（约 21px，这是两者的定义差）；超过该阈值说明投影与 DOM 的坐标系真的不同源了，
 * 需要排查（限流 `console.warn` 一次）。
 */
export const COORDINATE_DRIFT_THRESHOLD_PX = 140;

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
  /**
   * 按主题切换标签配色（亮色底 ⇒ 白底深字，避免一排深色药丸压在浅色画布上）。
   *
   * 只改 CSS 变量、不重建标签：重建会丢 hover/避让状态，还会闪一帧。
   *
   * @param light 是否浅色底
   */
  setLightTheme: (light: boolean) => void;
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
  /**
   * 锚点获得键盘焦点（与 hover 同语义：展开卡片；引擎侧据此把该标签排除出避让）。
   *
   * 为什么与 hover 分开：焦点是**持久**的（失焦前一直持有），hover 是瞬时的；
   * 引擎侧对两者的处理不同（焦点标签不应再被避让挤走）。
   */
  onFocusAnchor?: (pointId: string) => void;
  /**
   * 请求取消当前钉住的卡片（Esc 键）。
   *
   * 与 `onClickAnchor` 的方向相反，由页面决定「取消钉住」的落点（清 URL / 清选中态）。
   */
  onDismissAnchor?: () => void;
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
  /** hover 粘滞截止时间（毫秒时间戳；期间不清空 hover，防 true→false 抖动）。 */
  let hoverStickyUntil = 0;
  /**
   * 当前 hover 是否由 **DOM 事件**建立/维持（权威标记）。
   *
   * 为 true 时，几何判定（`hitTestAnchor`）的未命中结果**一律忽略**：
   * 几何坐标来自 3D 投影，与 DOM 实测的胶囊位置可能不同源（实测差 170px+），
   * 用它去「否决」DOM 事实会把刚建立的 hover 立刻清掉 —— 这正是线上反复出现的
   * 「悬停能出卡片、稍后就消失」的根因。只有 DOM 的 `pointerleave`（真正离开胶囊）
   * 才允许清除这个标记。
   */
  let hoverFromDom = false;

  /** 上一个 hover 的点位（其标签保持「立即到位」，避免刚移开就漂走）。 */
  let lastHoveredId: string | undefined;
  /** 「待定关闭」定时器（几何未命中时排的延时清除；任何命中都会取消它）。 */
  let pendingClearTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  /** 坐标漂移告警是否已打过（限流：只报一次）。 */
  let coordinateDriftWarned = false;
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
     子元素只有自己设 auto 才能重新成为命中目标（否则鼠标事件穿透到底下的 canvas）。
     ⚠️ **绝不能再写 left/top**：CSS2DRenderer 每帧已经把元素摆到投影位置
     （translate(-50%,-50%) translate(tx,ty)），它是 absolute 定位、left/top 默认 auto；
     一旦我们写 left/top，它会**叠加**在 CSS2D 的位移之上 —— 线上实测：整排标签被
     推到画布下方、屏幕只剩圆点。避让位移只能通过本元素自身的 translate 叠加。 */
  position: absolute;
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  transition: opacity 160ms ease-out;
}
/* 外层自身只做「相对投影点的偏移」：偏移量由 JS 写进 --twin-dx/--twin-dy（CSS 像素）。 */
.twin-anchor-label {
  translate: var(--twin-dx, 0px) var(--twin-dy, 0px);
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
  background: var(--twin-label-bg, ${TWIN_COLOR_LABEL_BG});
  border: 1px solid var(--twin-label-border, ${TWIN_COLOR_LABEL_CAPSULE_BORDER});
  box-shadow: 0 2px 8px var(--twin-label-shadow, ${TWIN_COLOR_LABEL_SHADOW});
  color: var(--twin-label-text, ${TWIN_COLOR_LABEL_TEXT});
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
  border: 2px solid var(--twin-dot-ring, ${TWIN_COLOR_DOT_RING_LIGHT});
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
  color: var(--twin-label-text, ${TWIN_COLOR_LABEL_TEXT});
}
.twin-anchor-value {
  color: var(--twin-label-value, ${TWIN_COLOR_LABEL_TEXT});
  font-variant-numeric: tabular-nums;
  transition: color 160ms ease-out, text-shadow 160ms ease-out;
}
.twin-anchor-value[data-muted='true'] {
  color: var(--twin-label-muted, ${TWIN_COLOR_LABEL_TEXT_MUTED});
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

      // ---- 键盘可达（a11y） ----
      //
      // 改造前锚点只响应鼠标（hover / click），键盘与读屏用户**完全够不到**卡片：
      // Tab 跳不到、Enter 无反应、读屏也读不到设备名与状态（内容在 canvas 上的 CSS2D 标签里）。
      // 这里把胶囊变成标准的可聚焦按钮：
      // - `tabindex=0` + `role=button` + `aria-label`（设备名 + 主展示值，读屏能念出来）；
      // - Enter / Space 等同点击（钉住卡片）；Esc 等同「点空白」（取消钉住）；
      // - `focus`/`blur` 同步 hover 语义（聚焦即展开卡片，失焦即收起）。
      // 为什么加在**胶囊**而不是外层 `.twin-anchor-label`：外层是 CSS2D 的定位挂点，
      // 尺寸恒为 0 —— 焦点框会是一个 0×0 的点，聚焦位置也随避让位移漂移。
      capsule.tabIndex = 0;
      capsule.setAttribute('aria-label', anchor.deviceName);
      capsule.setAttribute('role', 'button');
      capsule.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          // Space 默认会滚动容器，必须阻止
          event.preventDefault();
          event.stopPropagation();
          callbacks.onClickAnchor(anchor.pointId);
          return;
        }
        if (event.key === 'Escape') {
          event.stopPropagation();
          callbacks.onDismissAnchor?.();
        }
      });
      capsule.addEventListener('focus', () => {
        setHovered(anchor.pointId);
        callbacks.onFocusAnchor?.(anchor.pointId);
      });
      capsule.addEventListener('blur', () => {
        if (hoveredPointId === anchor.pointId) {
          setHovered(undefined);
        }
      });

      capsule.addEventListener('click', (event) => {
        event.stopPropagation();
        callbacks.onClickAnchor(anchor.pointId);
      });
      // ---- DOM 命中是**权威**：只要指针在胶囊上，hover 就永不丢失 ----
      // `pointerenter` 只在首次进入时触发一次（指针一直在胶囊内不会重复触发），
      // 因此必须再用 `pointermove` 续期；两者都取消「待定关闭」。
      const onCapsuleHover = (): void => {
        cancelPendingClear();
        hoverFromDom = true;
        hoverStickyUntil =
          (typeof performance === 'undefined'
            ? Date.now()
            : performance.now()) + HOVER_STICKY_MS;
        setHovered(anchor.pointId);
      };
      capsule.addEventListener('pointerover', onCapsuleHover, listenerOptions);
      capsule.addEventListener('pointermove', onCapsuleHover, listenerOptions);
      capsule.addEventListener('pointerenter', onCapsuleHover, listenerOptions);
      capsule.addEventListener('pointerleave', () => {
        // 明确离开胶囊：解除 DOM 权威，并进入「待定关闭」
        // （不硬清空：可能只是移到相邻元素上，或用户正把指针移向卡片本身）
        if (hoveredPointId === anchor.pointId) {
          hoverFromDom = false;
          hoverStickyUntil = 0;
          schedulePendingClear();
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
    cancelPendingClear();
    pointer.active = false;
    hoveredPointId = undefined;
    hoverStickyUntil = 0;
    hoverFromDom = false;
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
      // 读屏文案：设备名 + 主展示值（无数据时用 --，与视觉标签口径一致）。
      // 只写**结构化**内容，不写中文/英文说明词：文案由页面经 i18n 提供（引擎层不做 i18n）。
      const spokenValue = state?.primaryText?.trim() ?? '';
      const spokenAlertCount = state?.alertCount ?? 0;
      node.capsule.setAttribute(
        'aria-label',
        spokenAlertCount > 0
          ? `${node.descriptor.deviceName} ${spokenValue || '--'} · ${spokenAlertCount}`
          : `${node.descriptor.deviceName} ${spokenValue || '--'}`,
      );
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
    const smoothEnabled = motionSwitches(motionMode).smoothLabels;
    for (const [index, entry] of entries.entries()) {
      const layout = layouts[index];
      if (!layout) {
        continue;
      }
      const { node } = entry;
      // **夹回画布**：避让只保证「互不重叠」，不保证「整条都在可视区内」。
      // 演示场景的锚点纵向跨度大，避让会把首尾标签推出画布（线上实测：6 个胶囊的
      // y 全在画布底边之外，屏幕上只剩圆点）。夹紧后把「修正量」并入 offset，
      // 这样平滑过渡与胶囊矩形缓存都基于同一套坐标。
      const clamped = clampLabelRect(layout.rect, bounds);
      const clampedOffset = {
        x: layout.offset.x + (clamped.x - layout.rect.x),
        y: layout.offset.y + (clamped.y - layout.rect.y),
      };
      node.layoutRect = clamped;
      node.labelElement.dataset.collapsed = String(layout.collapsed);
      node.collapsed = layout.collapsed;
      // hover / 刚移开的标签**立即到位**：若让它们平滑跟随，标签会在指针下方继续漂移，
      // 用户「瞄准」一个正在滑走的标签 ⇒ hover 频繁落空（真实鼠标缓慢移动时实测复现）。
      // 平滑只用于「非交互目标」的轻微避让位移。
      const smooth =
        smoothEnabled &&
        !node.hovered &&
        node.descriptor.pointId !== lastHoveredId;
      node.currentOffset = smooth
        ? smoothOffset(node.currentOffset, clampedOffset, deltaSeconds)
        : { ...clampedOffset };
      applyLabelTransform(node, clampedOffset);
    }
    // 写完样式后统一读一次胶囊矩形（**所有写操作都已结束**，只触发一次布局重算）。
    // 这一步是 hover 命中的依据：标签是 200~300px 宽的胶囊，热区必须与之一致，
    // 不能只有圆点周围十几像素（线上实测：真实鼠标几乎点不中）。
    refreshCapsuleRects();
  }

  /**
   * 刷新每个标签胶囊的屏幕矩形（相对容器左上角）。
   *
   * ⚠️ 必须用 `.twin-anchor-capsule` 而不是外层 `.twin-anchor-label`：外层只是定位挂点，
   * 尺寸恒为 0；真实可见区域在胶囊上。
   * ⚠️ 折叠（只剩圆点）的标签不读胶囊矩形，命中时回退为圆点圆。
   */
  function refreshCapsuleRects(): void {
    const containerRect = container.getBoundingClientRect();
    for (const node of nodes.values()) {
      if (!node.descriptor.labelVisible) {
        node.lastCapsuleRect = undefined;
        continue;
      }
      if (node.collapsed) {
        // 折叠态胶囊的背景/边框都被隐藏，只剩圆点 ⇒ 用圆点圆判定
        node.lastCapsuleRect = undefined;
        continue;
      }
      const rect = node.capsule.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        node.lastCapsuleRect = undefined;
        continue;
      }
      node.lastCapsuleRect = {
        height: rect.height,
        width: rect.width,
        x: rect.left - containerRect.left,
        y: rect.top - containerRect.top,
      };
    }
  }

  /**
   * 点是否落在矩形内（带容差）。
   *
   * @param rect 矩形（容器坐标）
   * @param x 指针 X
   * @param y 指针 Y
   * @param tolerance 容差（像素，向外扩）
   * @returns 是否命中
   */
  function pointInRect(
    rect: { height: number; width: number; x: number; y: number },
    x: number,
    y: number,
    tolerance: number,
  ): boolean {
    return (
      x >= rect.x - tolerance &&
      x <= rect.x + rect.width + tolerance &&
      y >= rect.y - tolerance &&
      y <= rect.y + rect.height + tolerance
    );
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
    offset: { x: number; y: number },
  ): void {
    const element = node.labelElement;
    // CSS2DRenderer 已把元素摆到投影点、并做了 `translate(-50%,-50%)` ⇒ 元素**中心**落在
    // (screen.x, screen.y)。我们只叠加「相对投影点」的偏移（CSS 像素）：
    //   - 水平：圆点中心对齐投影点 ⇒ 整体右移半个圆点（胶囊从圆点右侧展开）；
    //   - 垂直：胶囊挂在圆点正上方 ⇒ 上移 LABEL_LIFT_PX + 半径。
    // ⚠️ 偏移必须用 `translate`（本元素自身），**不能写 left/top**：那会与 CSS2D 的位移
    //    叠加，把标签推到画布外（线上实测的缺陷）。
    const dx = offset.x + DOT_DIAMETER_PX / 2;
    const dy = offset.y - LABEL_LIFT_PX - DOT_DIAMETER_PX / 2;
    element.style.setProperty('--twin-dx', `${dx}px`);
    element.style.setProperty('--twin-dy', `${dy}px`);
    // hover 放大：用 CSS 变量变换叠加（**不能写 transform**：CSS2DRenderer 每帧重写它，
    // 会把缩放覆盖掉，表现为「hover 没反应」）
    element.style.setProperty(
      '--twin-hover-scale',
      String(node.hovered && !node.collapsed ? HOVER_SCALE : 1),
    );
  }

  /**
   * 由鼠标位置找最近的锚点（**纯几何，不依赖 DOM 命中测试**）。
   *
   * 为什么必须有这条路径（线上实测）：CSS2DRenderer 每帧重写标签的 `transform`，
   * 而它的 domElement 是 `pointer-events:none`；一旦有任何父级（标签外层/胶囊）
   * 忘记恢复 `pointer-events:auto`，鼠标事件就整条穿透到 canvas 上 ——
   * 于是「悬停标签出卡片」静默失效，且 DOM 层面完全看不出来。
   * 用屏幕坐标做命中与 DOM 布局无关，最稳。
   *
   * ## 判定顺序（两条，缺一不可）
   *
   * 1. **胶囊矩形**：标签是 200~300px 宽的胶囊，热区必须与可见区域一致。
   *    只判圆点周围 13px 时，真实鼠标几乎永远点不中（线上实测：指针落在文字区域、
   *    距圆点 50~100px ⇒ `hitTestAnchor` 恒不命中）。
   * 2. **圆点圆**：折叠成「只剩圆点」的标签没有可见胶囊，命中回退为圆点周围 13px。
   *
   * 多个胶囊重叠时取「中心离指针最近」的那个（重叠本不该发生——避让保证不重叠，
   * 但 hover 放大 1.12 倍时边缘可能轻微重叠）。
   *
   * @param screenX 相对容器左上角的 X
   * @param screenY 相对容器左上角的 Y
   * @returns 命中的点位；未命中 undefined
   */
  function hitTestAnchor(
    screenX: number,
    screenY: number,
  ): undefined | { pointId: string } {
    const dotRadius = DOT_DIAMETER_PX / 2 + HOVER_HIT_TOLERANCE_PX;
    let best: undefined | { distance: number; pointId: string };
    for (const node of nodes.values()) {
      if (!node.descriptor.labelVisible) {
        continue;
      }
      const rect = node.lastCapsuleRect;
      const screen = node.lastScreen;
      let distance: number | undefined;
      if (
        rect &&
        pointInRect(rect, screenX, screenY, HOVER_RECT_TOLERANCE_PX)
      ) {
        distance = Math.hypot(
          rect.x + rect.width / 2 - screenX,
          rect.y + rect.height / 2 - screenY,
        );
      } else if (screen) {
        const dotDistance = Math.hypot(screen.x - screenX, screen.y - screenY);
        distance = dotDistance <= dotRadius ? dotDistance : undefined;
      }
      if (distance === undefined) {
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
    if (hit) {
      // 几何命中：进入 hover、刷新粘滞窗口、取消待定关闭。
      // 注意：几何建立的 hover 不设 DOM 权威标记（否则指针移开后几何误判会一直粘住）。
      cancelPendingClear();
      setHovered(hit.pointId);
      hoverStickyUntil = nowMs + HOVER_STICKY_MS;
      warnCoordinateDriftOnce();
      return;
    }
    // **DOM 权威优先**：hover 由胶囊上的真实指针事件建立时，几何未命中一律忽略。
    if (hoverFromDom) {
      return;
    }
    // 几何未命中 ⇒ **不再硬清空**：
    //   - 指针仍在本标签附近（粘滞窗口内）⇒ 保持；
    //   - 否则只排一个「待定关闭」，期间 DOM 的 pointerover/pointermove 会把它取消。
    //
    // 为什么不能硬清空（线上实测）：指针一直在胶囊内时 `pointerenter` 只触发一次，
    // 一旦这里清空就再没有任何事件能恢复 ⇒ hover 永久丢失，直到指针离开再进入。
    // 也就是说：几何坐标不同源时（投影 vs DOM 实测），硬清空会**吞掉** DOM 的权威事实。
    const sticky = hoveredPointId ? nodes.get(hoveredPointId) : undefined;
    if (
      sticky &&
      nowMs < hoverStickyUntil &&
      isPointerNearNode(sticky, pointer.x, pointer.y)
    ) {
      return;
    }
    schedulePendingClear();
  }

  /** 取消「待定关闭」（任何一次真实命中都会调用）。 */
  function cancelPendingClear(): void {
    if (pendingClearTimer !== undefined) {
      globalThis.clearTimeout(pendingClearTimer);
      pendingClearTimer = undefined;
    }
  }

  /**
   * 排一个「待定关闭」：{@link HOVER_PENDING_CLEAR_MS} 内没有任何命中才真正清空。
   *
   * 幂等：已有待定关闭时不重复排（否则高频 pointermove 会把关闭时间无限推后，
   * 鼠标移到画布空白处后卡片永远不消失）。
   */
  function schedulePendingClear(): void {
    if (pendingClearTimer !== undefined) {
      return;
    }
    pendingClearTimer = globalThis.setTimeout(() => {
      pendingClearTimer = undefined;
      hoverStickyUntil = 0;
      setHovered(undefined);
    }, HOVER_PENDING_CLEAR_MS);
  }

  /**
   * 指针是否仍在某个节点的「胶囊矩形（外扩）+ 圆点圆」范围内。
   *
   * 与 `hitTestAnchor` 的区别：这里**只用来维持已有的 hover**，因此外扩更大、更宽容
   * （宁可多保持 260ms，也不要让卡片闪一下就没）。
   *
   * @param node 当前 hover 的节点
   * @param x 指针 X（容器坐标）
   * @param y 指针 Y（容器坐标）
   * @returns 是否仍在附近
   */
  function isPointerNearNode(node: AnchorNode, x: number, y: number): boolean {
    const rect = node.lastCapsuleRect;
    if (rect && pointInRect(rect, x, y, HOVER_STICKY_EXIT_MARGIN_PX)) {
      return true;
    }
    const screen = node.lastScreen;
    if (!screen) {
      return false;
    }
    return (
      Math.hypot(screen.x - x, screen.y - y) <=
      DOT_DIAMETER_PX / 2 + HOVER_HIT_TOLERANCE_PX + HOVER_STICKY_EXIT_MARGIN_PX
    );
  }

  /**
   * 坐标同源自检：`lastScreen`（3D 投影）与胶囊矩形（DOM 实测）应保持固定关系
   * （胶囊挂在圆点正上方：水平差 ≈ 圆点半径、垂直差 ≈ 抬升量 + 高度）。
   *
   * 两者如果大幅漂移，说明投影与 DOM 的坐标系不同源（例如容器尺寸、devicePixelRatio、
   * camera 更新时序），hover 会出现「命中后立刻被清」的抖动。这里只在**首次**超阈值时
   * `console.warn` 一次，供集成方核对（不刷屏、不影响功能）。
   */
  function warnCoordinateDriftOnce(): void {
    if (coordinateDriftWarned) {
      return;
    }
    for (const node of nodes.values()) {
      const rect = node.lastCapsuleRect;
      const screen = node.lastScreen;
      if (!rect || !screen) {
        continue;
      }
      const expectedX = screen.x - DOT_DIAMETER_PX / 2;
      const expectedY = screen.y - DOT_DIAMETER_PX / 2;
      const drift = Math.hypot(rect.x - expectedX, rect.y - expectedY);
      if (drift > COORDINATE_DRIFT_THRESHOLD_PX) {
        coordinateDriftWarned = true;
        console.warn(
          `[iot/twin] 标签坐标不同源：pointId=${node.descriptor.pointId} 的投影坐标 ` +
            `(${screen.x.toFixed(1)},${screen.y.toFixed(1)}) 与 DOM 实测胶囊 ` +
            `(${rect.x.toFixed(1)},${rect.y.toFixed(1)}) 相差 ${drift.toFixed(1)}px ` +
            `（阈值 ${COORDINATE_DRIFT_THRESHOLD_PX}px）。这会让 hover 出现抖动，请核对容器尺寸与 devicePixelRatio`,
        );
        return;
      }
    }
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
    // 明确离开画布：粘滞窗口作废（否则卡片会挂着不消失）
    hoverStickyUntil = 0;
    setHovered(undefined);
  }

  /** 设置 hover 点位（内部与外部共用）。 */
  function setHovered(pointId?: string): void {
    if (hoveredPointId === pointId) {
      return;
    }
    // 记录上一个 hover（其标签保持「立即到位」一帧，避免刚移开就平滑漂走）
    lastHoveredId = hoveredPointId;
    const previous = hoveredPointId ? nodes.get(hoveredPointId) : undefined;
    if (previous) {
      previous.hovered = false;
      previous.labelElement.dataset.hovered = 'false';
      previous.labelElement.style.setProperty('--twin-hover-scale', '1');
    }
    hoveredPointId = pointId;
    if (pointId) {
      // 命中即开粘滞窗口：避免「命中 → 下一帧几何没判中 → 立刻清空」的抖动
      hoverStickyUntil =
        (typeof performance === 'undefined' ? Date.now() : performance.now()) +
        HOVER_STICKY_MS;
    }
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

  /**
   * 按主题切换标签配色（改 CSS 变量，不重建节点）。
   *
   * @param light 是否浅色底
   */
  function setLightTheme(light: boolean): void {
    const style = css2dRenderer.domElement.style;
    if (light) {
      style.setProperty('--twin-label-bg', TWIN_COLOR_LABEL_BG_LIGHT);
      style.setProperty('--twin-label-border', TWIN_COLOR_LABEL_BORDER_LIGHT);
      style.setProperty('--twin-label-shadow', TWIN_COLOR_LABEL_SHADOW_LIGHT);
      style.setProperty('--twin-label-text', TWIN_COLOR_LABEL_TEXT_LIGHT);
      style.setProperty('--twin-label-value', TWIN_COLOR_LABEL_TEXT_LIGHT);
      style.setProperty(
        '--twin-label-muted',
        TWIN_COLOR_LABEL_TEXT_MUTED_LIGHT,
      );
      return;
    }
    // 暗色：清掉变量 ⇒ 回落到 <style> 里编译期的暗色调色板
    for (const name of [
      '--twin-label-bg',
      '--twin-label-border',
      '--twin-label-shadow',
      '--twin-label-text',
      '--twin-label-value',
      '--twin-label-muted',
    ]) {
      style.removeProperty(name);
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

  // 初始按暗色（与 <style> 编译期默认一致）；切场景后由 scene-manager 重新下发
  return {
    attach,
    detach,
    dispose,
    setLightTheme,
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
