/**
 * three 引擎层的公共类型（零 Vue 依赖，可被单测直接 import）。
 */

import type { TwinRenderMode } from './display';

/** 场景进入/加载状态机（每一次迁移都必须让 UI 可见）。 */
export type TwinSceneState =
  | 'disposed'
  | 'disposing'
  | 'failed'
  | 'loading'
  | 'ready';

/** 引擎层对外暴露的错误（带可展示文案与阶段）。 */
export interface TwinSceneError {
  /** 可展示的失败原因（已本地化；引擎层不做 i18n，由调用方传入文案）。 */
  message: string;
  /** 失败阶段：下载 / 解析。 */
  stage: 'download' | 'parse';
}

/** 模型下载进度回调。 */
export interface TwinLoadProgress {
  /** 已加载字节。 */
  loaded: number;
  /** 总字节（未知时为 0）。 */
  total: number;
  /** 百分比（0~100；总字节未知时为 -1）。 */
  percent: number;
}

/** 世界坐标变换（与后端 `anchor_*` 列一一对应）。 */
export interface AnchorTransform {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  scale: number;
}

/** 运行态展示状态（渲染层需要的全部信息）。 */
export interface AnchorRuntimeState {
  /** 活动告警数（> 0 ⇒ 闪烁）。 */
  alertCount: number;
  /** 设备在线状态：online | offline | unknown | 空（设备已不存在）。 */
  onlineStatus?: null | string;
  /** 启停位：1 启用 0 停用（0 ⇒ 灰化）。 */
  status?: null | number;
  /** 主展示属性的一句话（如 `26.5 ℃`）；空串表示「暂无数据」。 */
  primaryText: string;
  /** 是否有任何最新值（false ⇒ 标签显示 `--`，不是 0）。 */
  hasValue: boolean;
  /**
   * 主展示属性的渲染模式（由 `displayType` 映射，见 `display.ts`）。
   *
   * 不传时按 `label` 渲染（向后兼容：`runtime-store` 之外的调用方可能不提供）。
   */
  renderMode?: TwinRenderMode;
  /**
   * `color` 模式的染色比例（0~1，由 min/max 线性映射）。
   *
   * 缺 min/max 时为 undefined ⇒ 回落为按在线状态着色（不做无依据猜测）。
   */
  colorRatio?: number;
  /** `switch` 模式的二态（undefined ⇒ 无法判定，显示 `--`）。 */
  switchState?: boolean;
}

/** 锚点描述（由页面从点位响应转换而来，引擎层不依赖 API 类型）。 */
export interface AnchorDescriptor {
  pointId: string;
  deviceId: string;
  deviceName: string;
  /** 场景局部坐标。 */
  local: { x: number; y: number; z: number };
  /** 场景局部法线。 */
  normal: { x: number; y: number; z: number };
  icon?: null | string;
  /**
   * 点位绑定的**模型节点名**（`iot_twin_point.node_name`）。
   *
   * 有它就能「点位 → 模型节点」直接高亮（画布不再依赖圆点/标签表达选中）；
   * 为空时回退到「锚点位置附近的 mesh」兜底。
   *
   * 可选：历史点位可能没绑节点，视图层也可能暂未透传（此时全部走兜底）。
   */
  nodeName?: null | string;
  /**
   * 是否在「列表/图例」里展示（`iot_twin_point.label_visible` 的原语义）。
   *
   * ⚠️ 语义已变更（设备呈现方式重做）：画布**默认不显示圆点与常驻标签**，
   * 这个字段不再决定「画布上是否常驻显示标签」，而是保留给视图层做列表筛选。
   * 画布上的数值只在**选中/悬停**时展示。
   */
  labelVisible: boolean;
  sort: number;
}

/** 相机位姿（`view_json` 的结构，前端拥有语义）。 */
export interface TwinViewConfig {
  camera?: {
    /** 透视相机 fov（度）。 */
    fov?: number;
    /** 相机位置（世界坐标）。 */
    position?: { x: number; y: number; z: number };
    /** 观察目标（世界坐标）。 */
    target?: { x: number; y: number; z: number };
  };
  /** 背景色（CSS 颜色串，如 `#0b1220`）。 */
  background?: string;
  /** 环境光强度（0~3）。 */
  ambientIntensity?: number;
  /** 平行光强度（0~5）。 */
  directionalIntensity?: number;
}
