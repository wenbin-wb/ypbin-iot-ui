import type { IotDeviceApi, IotPointApi, IotSeriesApi } from '#/api/iot';

import { $t } from '#/locales';

/**
 * 组态看板的**纯逻辑层**（零 vue、零网络；localStorage 通过参数注入便于单测）。
 *
 * 为什么单独一层：看板配置来自浏览器本地存储，是**不可信输入**（用户手动改过/旧版本残留/
 * 其他标签页写坏），sanitize 必须能挡住所有脏数据且永不抛异常；实时事件匹配、折线追加裁剪
 * 这些规则也必须有对错、可回归。
 */
export const IOT_BOARD_STORAGE_KEY = 'ypbin-iot.board.v1';

/** 配置版本：升级结构时递增，旧版本一律判为不兼容并重置（不做隐式字段猜测）。 */
export const IOT_BOARD_VERSION = 1;

/** 看板最多组件数：避免一屏塞入过多图表把浏览器拖死。 */
export const IOT_BOARD_MAX_WIDGETS = 24;

/** 折线组件在内存里保留的最大点数（实时追加用；更早历史走刷新重查）。 */
export const IOT_BOARD_LINE_MAX_POINTS = 200;

export type BoardWidgetType = 'gauge' | 'line' | 'status' | 'value';

export const BOARD_WIDGET_TYPES: BoardWidgetType[] = [
  'value',
  'gauge',
  'line',
  'status',
];

export interface BoardWidget {
  deviceId: string;
  id: string;
  propertyId: string;
  title: string;
  type: BoardWidgetType;
}

export interface BoardConfig {
  version: number;
  widgets: BoardWidget[];
}

/** 新增组件时 id 可缺省，由 {@link addBoardWidget} 生成。 */
export type NewBoardWidget = Omit<BoardWidget, 'id'> & { id?: string };

/** 单个组件的运行期状态（不持久化；来自接口与 SSE）。 */
export interface BoardWidgetRuntime {
  /** 加载失败原因（后端 message 原样）；非空时卡片只显示错误态。 */
  error: string;
  /** 仪表盘自适应量程（只增不减，避免指针随数值抖动）。 */
  gaugeMax: number;
  latest: IotDeviceApi.LatestValueResp | null;
  /** 初始数据（最新值）是否已加载完成。 */
  loaded: boolean;
  /** 实时跟随的追加次数（用于「实时」小标与调试）。 */
  liveCount: number;
  points: IotSeriesApi.TimeSeriesPointResp[];
  /** 折线的历史序列是否已加载完成。 */
  seriesLoaded: boolean;
}

export function createBoardWidgetRuntime(): BoardWidgetRuntime {
  return {
    error: '',
    gaugeMax: 100,
    latest: null,
    loaded: false,
    liveCount: 0,
    points: [],
    seriesLoaded: false,
  };
}

export function createEmptyBoardConfig(): BoardConfig {
  return { version: IOT_BOARD_VERSION, widgets: [] };
}

/** 只读存储接口：window.localStorage 的子集，便于测试注入假实现。 */
export interface BoardStorage {
  getItem: (key: string) => null | string;
  setItem: (key: string, value: string) => void;
}

function defaultStorage(): BoardStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

export function isBoardWidgetType(value: unknown): value is BoardWidgetType {
  return (
    typeof value === 'string' &&
    (BOARD_WIDGET_TYPES as string[]).includes(value)
  );
}

/** 配置对象是否是「本版本」的结构（脏数据/旧版本都不算）。 */
function isBoardConfigShape(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === IOT_BOARD_VERSION &&
    Array.isArray((value as { widgets?: unknown }).widgets)
  );
}

/**
 * 把任意输入洗成合法配置：非对象/版本不符 → 空看板；组件逐条校验，坏条目丢弃而不是猜测修复。
 * 永不抛异常（这是本地存储读路径的硬要求）。
 */
export function sanitizeBoardConfig(raw: unknown): BoardConfig {
  if (!isBoardConfigShape(raw)) {
    return createEmptyBoardConfig();
  }
  const widgetsRaw = (raw as { widgets: unknown[] }).widgets;
  const widgets: BoardWidget[] = [];
  const seenIds = new Set<string>();
  for (const item of widgetsRaw) {
    if (widgets.length >= IOT_BOARD_MAX_WIDGETS) {
      break;
    }
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const deviceId = asText(record.deviceId);
    const id = asText(record.id);
    const propertyId = asText(record.propertyId);
    const title = asText(record.title);
    if (
      deviceId === '' ||
      id === '' ||
      propertyId === '' ||
      title === '' ||
      seenIds.has(id) ||
      !isBoardWidgetType(record.type)
    ) {
      continue;
    }
    seenIds.add(id);
    widgets.push({ deviceId, id, propertyId, title, type: record.type });
  }
  return { version: IOT_BOARD_VERSION, widgets };
}

export interface BoardConfigLoadResult {
  config: BoardConfig;
  /** 存储里有内容但不可用（JSON 坏 / 版本不符）⇒ 已重置，调用方应给可见提示。 */
  reset: boolean;
}

/**
 * 读取配置。存储不可用（隐私模式/沙箱）时静默回落空看板——但这只是**读取能力**问题；
 * 真正「有内容却读坏」的情况用 `reset=true` 让调用方提示用户。
 */
export function loadBoardConfig(
  storage: BoardStorage | undefined = defaultStorage(),
): BoardConfigLoadResult {
  if (!storage) {
    return { config: createEmptyBoardConfig(), reset: false };
  }
  let rawText: null | string;
  try {
    rawText = storage.getItem(IOT_BOARD_STORAGE_KEY);
  } catch (error) {
    console.warn('[iot/board] 读取看板配置失败（存储不可用）', error);
    return { config: createEmptyBoardConfig(), reset: false };
  }
  if (!rawText) {
    return { config: createEmptyBoardConfig(), reset: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    console.warn('[iot/board] 看板配置不是合法 JSON，已重置为空看板', error);
    return { config: createEmptyBoardConfig(), reset: true };
  }
  if (!isBoardConfigShape(parsed)) {
    console.warn('[iot/board] 看板配置版本/结构不兼容，已重置为空看板');
    return { config: createEmptyBoardConfig(), reset: true };
  }
  return { config: sanitizeBoardConfig(parsed), reset: false };
}

/** 保存配置；返回是否成功（存储满/不可用时调用方要给可见提示）。 */
export function saveBoardConfig(
  config: BoardConfig,
  storage: BoardStorage | undefined = defaultStorage(),
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(
      IOT_BOARD_STORAGE_KEY,
      JSON.stringify(sanitizeBoardConfig(config)),
    );
    return true;
  } catch (error) {
    console.warn('[iot/board] 保存看板配置失败（存储不可用或已满）', error);
    return false;
  }
}

export function createBoardWidgetId(seed: number = Date.now()): string {
  return `board-${seed.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 追加组件；超过上限或 id 冲突时原样返回（调用方负责提示上限）。 */
export function addBoardWidget(
  config: BoardConfig,
  widget: NewBoardWidget,
): BoardConfig {
  if (config.widgets.length >= IOT_BOARD_MAX_WIDGETS) {
    return config;
  }
  const id = asText(widget.id) || createBoardWidgetId();
  if (config.widgets.some((item) => item.id === id)) {
    return config;
  }
  return {
    version: config.version,
    widgets: [...config.widgets, { ...widget, id }],
  };
}

/** 编辑组件：只接受合法类型与非空字符串，非法字段忽略（不把坏值写进配置）。 */
export function updateBoardWidget(
  config: BoardConfig,
  id: string,
  patch: Partial<Omit<BoardWidget, 'id'>>,
): BoardConfig {
  return {
    version: config.version,
    widgets: config.widgets.map((widget) => {
      if (widget.id !== id) {
        return widget;
      }
      return {
        ...widget,
        ...(isBoardWidgetType(patch.type) ? { type: patch.type } : {}),
        ...(asText(patch.title) === '' ? {} : { title: asText(patch.title) }),
        ...(asText(patch.deviceId) === ''
          ? {}
          : { deviceId: asText(patch.deviceId) }),
        ...(asText(patch.propertyId) === ''
          ? {}
          : { propertyId: asText(patch.propertyId) }),
      };
    }),
  };
}

export function removeBoardWidget(
  config: BoardConfig,
  id: string,
): BoardConfig {
  return {
    version: config.version,
    widgets: config.widgets.filter((widget) => widget.id !== id),
  };
}

/**
 * 实时事件是否命中该组件：设备与点位都要一致（`deviceId` 可能是 Long 字符串或 number）。
 * 不命中静默忽略——看板里可能有多个设备的组件，事件不属于它们。
 */
export function boardLatestMatches(
  widget: BoardWidget,
  payload: { deviceId?: unknown; propertyId?: unknown },
): boolean {
  const deviceId = payload?.deviceId;
  const propertyId = payload?.propertyId;
  if (
    deviceId === null ||
    deviceId === undefined ||
    propertyId === null ||
    propertyId === undefined
  ) {
    return false;
  }
  return (
    String(deviceId).trim() === widget.deviceId &&
    String(propertyId).trim() === widget.propertyId
  );
}

export type BoardPointDropReason = '' | 'duplicate-ts' | 'invalid-ts';

/** 追加输入：`ts` 允许空（SSE 字段可空），由 {@link appendBoardPoint} 统一校验。 */
export interface BoardPointInput {
  quality: null | string;
  ts: null | number | string;
  value: null | string;
}

export interface BoardPointAppendResult {
  appended: boolean;
  points: IotSeriesApi.TimeSeriesPointResp[];
  reason: BoardPointDropReason;
}

/**
 * 折线尾部追加：ts 必须可解析且严格大于最后一点；超过上限保留最近 max 点。
 * 不追加时原样返回入参数组（引用不变，调用方据此跳过重渲染）。
 */
export function appendBoardPoint(
  points: IotSeriesApi.TimeSeriesPointResp[],
  point: BoardPointInput,
  max: number = IOT_BOARD_LINE_MAX_POINTS,
): BoardPointAppendResult {
  const ts = Number(point.ts);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { appended: false, points, reason: 'invalid-ts' };
  }
  const lastTs = points.at(-1)?.ts;
  const lastMillis = lastTs === undefined ? Number.NaN : Number(lastTs);
  if (Number.isFinite(lastMillis) && ts <= lastMillis) {
    return { appended: false, points, reason: 'duplicate-ts' };
  }
  const cap = Number.isFinite(max)
    ? Math.max(1, Math.floor(max))
    : IOT_BOARD_LINE_MAX_POINTS;
  const next = [...points, { ...point, ts }];
  return {
    appended: true,
    points: next.length > cap ? next.slice(next.length - cap) : next,
    reason: '',
  };
}

export interface BoardPropertyOption {
  label: string;
  value: string;
}

/**
 * 点位候选：设备点位映射里的 property 引用（启用的）+ 最新值里出现过的 propertyId。
 * 命令引用（refType=command）与停用映射不进候选；按标识符排序，便于搜索。
 */
export function buildPropertyOptions(
  points?: IotPointApi.PointMappingResp[] | null,
  latest?: IotDeviceApi.LatestValueResp[] | null,
): BoardPropertyOption[] {
  const seen = new Set<string>();
  const options: BoardPropertyOption[] = [];
  for (const point of points ?? []) {
    if (point.refType !== 'property' || point.enabled === false) {
      continue;
    }
    const value = (point.propertyId ?? '').trim();
    if (value === '' || seen.has(value)) {
      continue;
    }
    seen.add(value);
    options.push({ label: value, value });
  }
  for (const item of latest ?? []) {
    const value = (item.propertyId ?? '').trim();
    if (value === '' || seen.has(value)) {
      continue;
    }
    seen.add(value);
    options.push({
      label: `${value} · ${$t('page.iot.device.latestValues')}`,
      value,
    });
  }
  return options.toSorted((left, right) =>
    left.value.localeCompare(right.value),
  );
}

/** 字符串数值解析：不能解析时返回 null（文本点不画进折线/仪表盘）。 */
export function toBoardNumeric(
  value: null | string | undefined,
): null | number {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
