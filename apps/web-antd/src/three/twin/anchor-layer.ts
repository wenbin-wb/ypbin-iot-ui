import type * as THREE_NS from 'three';

import type { AnchorLayer } from './scene-manager';
import type { AnchorDescriptor, AnchorRuntimeState } from './types';

import {
  TWIN_COLOR_ALERT,
  TWIN_COLOR_ALERT_DIM,
  TWIN_COLOR_DISABLED,
  TWIN_COLOR_ICON_BASE,
  TWIN_COLOR_ICON_INNER,
  TWIN_COLOR_LABEL_BG,
  TWIN_COLOR_LABEL_BORDER,
  TWIN_COLOR_LABEL_BORDER_ALERT,
  TWIN_COLOR_LABEL_TEXT,
  TWIN_COLOR_LABEL_TEXT_MUTED,
  TWIN_COLOR_OFFLINE,
  TWIN_COLOR_ONLINE,
  TWIN_COLOR_UNKNOWN,
} from './colors';
import { colorForRatio, toRenderMode } from './display';

/**
 * 锚点渲染层：设备图标 + 数值标签 + 状态着色 + 告警闪烁。
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
 */

/** 单个锚点在场景中的节点集合。 */
interface AnchorNode {
  descriptor: AnchorDescriptor;
  /** CSS2D 标签的 DOM 元素（数值 + 设备名）。 */
  labelElement: HTMLDivElement;
  /** Sprite 图标。 */
  sprite: THREE_NS.Sprite;
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
const ALERT_BLINK_HALF_PERIOD_MS = 600;

/** 图标在屏幕上的缩放（`sizeAttenuation=false` 时的屏幕比例）。 */
const ICON_SCREEN_SCALE = 0.045;

/** 图标贴图的画布边长（像素）。 */
const ICON_TEXTURE_SIZE = 64;

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

/** 锚点层实例（在 `AnchorLayer` 契约之上追加释放能力）。 */
export interface AnchorLayerInstance extends AnchorLayer {
  /** 释放 DOM 与贴图（页面卸载时调用）。 */
  dispose: () => void;
}

/** 锚点层交互回调。 */
export interface AnchorLayerCallbacks {
  /** 点击锚点标签/图标。 */
  onClickAnchor: (pointId: string) => void;
  /** 悬停锚点标签（可选）。 */
  onHoverAnchor?: (pointId: string) => void;
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

  const css2dRenderer = new CSS2D.CSS2DRenderer();
  css2dRenderer.domElement.style.cssText = [
    'position:absolute',
    'inset:0',
    'pointer-events:none',
    'overflow:hidden',
  ].join(';');
  container.append(css2dRenderer.domElement);

  // 图标贴图：canvas 现画圆底 + 内圈，按状态由材质 color 染色（一张贴图表现全部状态色）
  const iconTexture = createIconTexture(THREE);

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

      const labelElement = document.createElement('div');
      labelElement.className = 'twin-anchor-label';
      labelElement.style.cssText = [
        'position:absolute',
        'transform:translate(-50%,-140%)',
        'padding:2px 6px',
        'border-radius:4px',
        `background:${TWIN_COLOR_LABEL_BG}`,
        `border:1px solid ${TWIN_COLOR_LABEL_BORDER}`,
        `color:${TWIN_COLOR_LABEL_TEXT}`,
        'font-size:12px',
        'line-height:16px',
        'white-space:nowrap',
        'pointer-events:auto',
        'cursor:pointer',
        'user-select:none',
      ].join(';');
      labelElement.dataset.pointId = anchor.pointId;
      labelElement.addEventListener('click', (event) => {
        event.stopPropagation();
        callbacks.onClickAnchor(anchor.pointId);
      });
      if (callbacks.onHoverAnchor) {
        labelElement.addEventListener('mouseenter', () => {
          callbacks.onHoverAnchor?.(anchor.pointId);
        });
      }

      const labelObject = new CSS2D.CSS2DObject(labelElement);
      labelObject.position.set(anchor.local.x, anchor.local.y, anchor.local.z);
      // 标签默认显隐由配置项 labelVisible 决定
      labelElement.style.display = anchor.labelVisible ? '' : 'none';

      modelRoot.add(sprite);
      modelRoot.add(labelObject);
      nodes.set(anchor.pointId, { descriptor: anchor, labelElement, sprite });
    }
  }

  function detach(): void {
    for (const node of nodes.values()) {
      node.sprite.removeFromParent();
      node.sprite.material.dispose();
      node.labelElement.remove();
    }
    nodes.clear();
    currentStates = new Map();
  }

  function update(states: Map<string, AnchorRuntimeState>): void {
    currentStates = states;
    applyStates();
    ensureBlinkTimer();
  }

  /** 把 `currentStates` 应用到 DOM 与 sprite 材质。 */
  function applyStates(): void {
    for (const [pointId, node] of nodes) {
      const state = currentStates.get(pointId);
      // color 形态：图标按数值色阶染色（越界变红），比状态色更能反映「值有多糟」
      const color =
        state?.renderMode === 'color' && state.colorRatio !== undefined
          ? colorForRatio(state.colorRatio)
          : resolveColor(state);
      node.sprite.material.color.set(color);

      if (!node.descriptor.labelVisible) {
        node.labelElement.style.display = 'none';
        continue;
      }
      node.labelElement.style.display = '';
      const name = node.descriptor.deviceName;
      // **按 displayType 分形态渲染**（工单 #126）。
      // 修复前五种形态渲染完全一样，等于「配置项说谎」；现在 switch/color 有真实差异，
      // 未实现的 gauge/sparkline 由 toRenderMode 回落为 label，并在 UI 上标注「暂不支持」。
      const mode = state?.renderMode ?? toRenderMode('value');
      if (mode === 'switch') {
        node.labelElement.textContent = `${name} ${switchGlyph(state)}`;
      } else if (mode === 'color' && state?.colorRatio !== undefined) {
        // 数值着色：用一个色块 + 数值，直观看出越界程度
        const text = state?.primaryText?.trim() ? state.primaryText : '--';
        node.labelElement.textContent = `${name} ${text}`;
        node.labelElement.style.borderColor = colorForRatio(state.colorRatio);
        node.labelElement.style.borderWidth = '2px';
      } else {
        const text = state?.primaryText?.trim() ? state.primaryText : '--';
        node.labelElement.textContent = `${name} ${text}`;
      }
      // 无数据（hasValue=false）时标签用弱化色，明确告诉用户「这是没有数据，不是 0」
      node.labelElement.style.color =
        state?.hasValue === false
          ? TWIN_COLOR_LABEL_TEXT_MUTED
          : TWIN_COLOR_LABEL_TEXT;
      if (mode !== 'color') {
        node.labelElement.style.borderColor =
          (state?.alertCount ?? 0) > 0
            ? TWIN_COLOR_LABEL_BORDER_ALERT
            : TWIN_COLOR_LABEL_BORDER;
      }
    }
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
    return state.switchState ? '● 开' : '○ 关';
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

  function dispose(): void {
    detach();
    if (blinkTimer !== undefined) {
      globalThis.clearInterval(blinkTimer);
      blinkTimer = undefined;
    }
    iconTexture.dispose();
    css2dRenderer.domElement.remove();
  }

  return {
    attach,
    detach,
    dispose,
    render: (scene, camera) => {
      css2dRenderer.render(scene, camera);
    },
    resize: (width, height) => {
      css2dRenderer.setSize(width, height);
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
