/**
 * three 引擎层的公共类型（零 Vue 依赖，可被单测直接 import）。
 */

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
