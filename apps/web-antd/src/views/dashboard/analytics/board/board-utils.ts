import type { IotDeviceApi, IotPointApi, IotSeriesApi } from '#/api/iot';

import { $t } from '#/locales';

/**
 * 组态看板的**纯逻辑层**（零 vue、零网络；localStorage 通过参数注入便于单测）。
 *
 * 为什么单独一层：看板配置来自**两处不可信输入**——浏览器本地存储（用户手动改过/旧版本残留/
 * 其他标签页写坏）与后端按租户存储的配置（别的客户端/老版本前端写入）。sanitize 必须能挡住
 * 所有脏数据且永不抛异常；实时事件匹配、折线追加裁剪、排序重排这些规则也必须有对错、可回归。
 */
export const IOT_BOARD_STORAGE_KEY = 'ypbin-iot.board.v1';

/** 配置版本：升级结构时递增，旧版本一律判为不兼容并重置（不做隐式字段猜测）。 */
export const IOT_BOARD_VERSION = 1;

/** 看板最多组件数：避免一屏塞入过多图表把浏览器拖死（后端单请求上限 50，本地更严）。 */
export const IOT_BOARD_MAX_WIDGETS = 24;

/** 一条折线在内存里保留的最大点数（实时追加用；更早历史走刷新重查）。 */
export const IOT_BOARD_LINE_MAX_POINTS = 200;

/** 多序列折线 / 表格卡最多关注的点位数（防一次拉爆接口与图例）。 */
export const IOT_BOARD_MAX_SERIES = 12;

/** 折线默认窗口（分钟）：最近 24 小时，与设备详情「历史曲线」默认档一致。 */
export const IOT_BOARD_DEFAULT_WINDOW_MINUTES = 24 * 60;

/** 窗口分钟上限（7 天）：再长就该去历史曲线页，不占用看板实时通道。 */
export const IOT_BOARD_MAX_WINDOW_MINUTES = 7 * 24 * 60;

/** 小数位上限：再多的位数对现场读数没有意义，只会在窄卡片里溢出。 */
export const IOT_BOARD_MAX_DECIMALS = 6;

export type BoardWidgetType =
  | 'boolean'
  | 'gauge'
  | 'line'
  | 'multi-line'
  | 'status'
  | 'table'
  | 'value';

export const BOARD_WIDGET_TYPES: BoardWidgetType[] = [
  'value',
  'gauge',
  'line',
  'status',
  'boolean',
  'multi-line',
  'table',
];

/** 需要「多个点位」输入的组件类型（propertyIds）；其余用单个 propertyId。 */
export const BOARD_MULTI_POINT_TYPES: BoardWidgetType[] = [
  'multi-line',
  'table',
];

/** 布尔开关卡的归一状态：on/off 为已识别，unknown 表示值不在真值表里（不猜）。 */
export type BoardBooleanState = 'off' | 'on' | 'unknown';

export interface BoardWidget {
  deviceId: string;
  id: string;
  propertyId: string;
  title: string;
  type: BoardWidgetType;
  /** 展示用小数位（0~6）；缺省 = 原样展示后端字符串。 */
  decimals?: number;
  /** 仪表盘量程上限；缺省或 ≤ min 时用 map 自适应量程。 */
  max?: number;
  /** 仪表盘量程下限（默认 0；负数量程场景可显式给负值）。 */
  min?: number;
  /** 多序列折线 / 表格卡关注的多个点位（同设备），表格卡按此顺序展示。 */
  propertyIds?: string[];
  /** 展示单位（如 ℃），只拼接展示，不参与任何换算。 */
  unit?: string;
  /** 折线初始窗口（分钟）；缺省 1440（24 小时）。 */
  windowMinutes?: number;
}

export interface BoardConfig {
  version: number;
  widgets: BoardWidget[];
}

/** 新增组件时 id 可缺省，由 addBoardWidget 生成。 */
export type NewBoardWidget = Omit<BoardWidget, 'id'> & { id?: string };

/** 一条折线序列：点位标识 + 该点位的历史点。 */
export interface BoardSeriesPoints {
  points: IotSeriesApi.TimeSeriesPointResp[];
  propertyId: string;
}

/** 单个组件的运行期状态（不持久化；来自接口与 SSE）。 */
export interface BoardWidgetRuntime {
  /** 加载失败原因（后端 message 原样）；非空时卡片只显示错误态。 */
  error: string;
  /** 仪表盘自适应量程（只增不减，避免指针随数值抖动）。 */
  gaugeMax: number;
  latest: IotDeviceApi.LatestValueResp | null;
  /** 表格卡用的整设备最新值快照（按点位取行）。 */
  latestList: IotDeviceApi.LatestValueResp[];
  /** 初始数据（最新值）是否已加载完成。 */
  loaded: boolean;
  /** 实时跟随的追加次数（用于「实时」小标与调试）。 */
  liveCount: number;
  /** 多序列折线的每条序列历史（顺序与 widget.propertyIds 一致）。 */
  multiSeries: BoardSeriesPoints[];
  points: IotSeriesApi.TimeSeriesPointResp[];
  /** 折线的历史序列是否已加载完成。 */
  seriesLoaded: boolean;
}

export function createBoardWidgetRuntime(): BoardWidgetRuntime {
  return {
    error: '',
    gaugeMax: 100,
    latest: null,
    latestList: [],
    loaded: false,
    liveCount: 0,
    multiSeries: [],
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

/** 可选数值字段清洗：非有限数/超范围一律丢弃（不写坏值进配置）。 */
function asOptionalNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === '' || value === null || value === undefined) {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return undefined;
  }
  return parsed;
}

/** 可选整数字段清洗（小数位/窗口分钟）。 */
function asOptionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  const parsed = asOptionalNumber(value, minimum, maximum);
  return parsed === undefined ? undefined : Math.round(parsed);
}

/** 多点位列表清洗：去空白、去重、保序、截断到上限。 */
export function sanitizeBoardPropertyIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const text = asText(item);
    if (text === '' || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
    if (result.length >= IOT_BOARD_MAX_SERIES) {
      break;
    }
  }
  return result;
}

export function isBoardWidgetType(value: unknown): value is BoardWidgetType {
  return (
    typeof value === 'string' &&
    (BOARD_WIDGET_TYPES as string[]).includes(value)
  );
}

/** 该组件类型是否使用多点位输入（多序列折线 / 表格卡）。 */
export function isMultiPointWidgetType(type: BoardWidgetType): boolean {
  return BOARD_MULTI_POINT_TYPES.includes(type);
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
 * 把单条**不可信**组件洗成合法组件；坏条目返回 undefined（调用方丢弃而不是猜测修复）。
 *
 * 核心字段（id/type/title/deviceId/propertyId）必须非空字符串——后端保存接口同样要求，
 * 前端若放过就会写出「用户看不到也删不掉的坏卡片」。多点位类型若 propertyIds 为空，
 * 回落成只含 propertyId 的单元素数组：后端只认单个 propertyId，多序列卡至少要有一条序列。
 */
export function sanitizeBoardWidget(
  item: unknown,
  seenIds?: Set<string>,
): BoardWidget | undefined {
  if (typeof item !== 'object' || item === null) {
    return undefined;
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
    (seenIds?.has(id) ?? false) ||
    !isBoardWidgetType(record.type)
  ) {
    return undefined;
  }
  const type = record.type;
  const widget: BoardWidget = { deviceId, id, propertyId, title, type };
  const unit = asText(record.unit);
  if (unit !== '') {
    widget.unit = unit;
  }
  const decimals = asOptionalInteger(
    record.decimals,
    0,
    IOT_BOARD_MAX_DECIMALS,
  );
  if (decimals !== undefined) {
    widget.decimals = decimals;
  }
  const min = asOptionalNumber(record.min, -1e15, 1e15);
  if (min !== undefined) {
    widget.min = min;
  }
  const max = asOptionalNumber(record.max, -1e15, 1e15);
  if (max !== undefined) {
    widget.max = max;
  }
  const windowMinutes = asOptionalInteger(
    record.windowMinutes,
    1,
    IOT_BOARD_MAX_WINDOW_MINUTES,
  );
  if (windowMinutes !== undefined) {
    widget.windowMinutes = windowMinutes;
  }
  const propertyIds = sanitizeBoardPropertyIds(record.propertyIds);
  if (isMultiPointWidgetType(type)) {
    widget.propertyIds = propertyIds.length > 0 ? propertyIds : [propertyId];
  } else if (propertyIds.length > 0) {
    widget.propertyIds = propertyIds;
  }
  return widget;
}

/**
 * 批量清洗组件列表（后端响应没有版本号，只能按列表清洗）。
 * 逐条校验、坏条目丢弃、id 去重、超上限截断；永不抛异常。
 */
export function sanitizeBoardWidgetList(raw: unknown): BoardWidget[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const widgets: BoardWidget[] = [];
  const seenIds = new Set<string>();
  for (const item of raw) {
    if (widgets.length >= IOT_BOARD_MAX_WIDGETS) {
      break;
    }
    const widget = sanitizeBoardWidget(item, seenIds);
    if (!widget) {
      continue;
    }
    seenIds.add(widget.id);
    widgets.push(widget);
  }
  return widgets;
}

/**
 * 把任意输入洗成合法配置：非对象/版本不符 → 空看板；组件逐条校验，坏条目丢弃而不是猜测修复。
 * 永不抛异常（这是本地存储读路径的硬要求）。
 */
export function sanitizeBoardConfig(raw: unknown): BoardConfig {
  if (!isBoardConfigShape(raw)) {
    return createEmptyBoardConfig();
  }
  return {
    version: IOT_BOARD_VERSION,
    widgets: sanitizeBoardWidgetList((raw as { widgets: unknown }).widgets),
  };
}

export interface BoardConfigLoadResult {
  config: BoardConfig;
  /** 本地草稿是否**未同步到平台**（上次 PUT 失败时置位）。 */
  dirty: boolean;
  /** 存储里有内容但不可用（JSON 坏 / 版本不符）⇒ 已重置，调用方应给可见提示。 */
  reset: boolean;
}

interface StoredBoardConfig {
  dirty?: boolean;
  version?: unknown;
  widgets?: unknown;
}

function readStoredDirty(value: unknown): boolean {
  return (value as StoredBoardConfig).dirty === true;
}

/**
 * 读取本地草稿。存储不可用（隐私模式/沙箱）时静默回落空看板——但这只是**读取能力**问题；
 * 真正「有内容却读坏」的情况用 reset=true 让调用方提示用户。
 */
export function loadBoardConfig(
  storage: BoardStorage | undefined = defaultStorage(),
): BoardConfigLoadResult {
  if (!storage) {
    return { config: createEmptyBoardConfig(), dirty: false, reset: false };
  }
  let rawText: null | string;
  try {
    rawText = storage.getItem(IOT_BOARD_STORAGE_KEY);
  } catch (error) {
    console.warn('[iot/board] 读取看板配置失败（存储不可用）', error);
    return { config: createEmptyBoardConfig(), dirty: false, reset: false };
  }
  if (!rawText) {
    return { config: createEmptyBoardConfig(), dirty: false, reset: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    console.warn('[iot/board] 看板配置不是合法 JSON，已重置为空看板', error);
    return { config: createEmptyBoardConfig(), dirty: false, reset: true };
  }
  if (!isBoardConfigShape(parsed)) {
    console.warn('[iot/board] 看板配置版本/结构不兼容，已重置为空看板');
    return { config: createEmptyBoardConfig(), dirty: false, reset: true };
  }
  return {
    config: sanitizeBoardConfig(parsed),
    dirty: readStoredDirty(parsed),
    reset: false,
  };
}

/**
 * 保存本地草稿；返回是否成功（存储满/不可用时调用方要给可见提示）。
 *
 * dirty=true 表示「这份草稿还没同步到平台」（上次 PUT 失败），下次打开看板据此优先展示
 * 本地草稿而不是静默丢弃用户改动。
 */
export function saveBoardConfig(
  config: BoardConfig,
  storage: BoardStorage | undefined = defaultStorage(),
  dirty = false,
): boolean {
  if (!storage) {
    return false;
  }
  try {
    const sanitized = sanitizeBoardConfig(config);
    storage.setItem(
      IOT_BOARD_STORAGE_KEY,
      JSON.stringify({
        dirty,
        version: sanitized.version,
        widgets: sanitized.widgets,
      }),
    );
    return true;
  } catch (error) {
    console.warn('[iot/board] 保存看板配置失败（存储不可用或已满）', error);
    return false;
  }
}

/** 导出后端 PUT 用的**纯对象**：只带已定义字段（undefined 会让 JSON 多出 null 噪声）。 */
export function toBoardPayloadWidget(
  widget: BoardWidget,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    deviceId: widget.deviceId,
    id: widget.id,
    propertyId: widget.propertyId,
    title: widget.title,
    type: widget.type,
  };
  if (widget.unit !== undefined) {
    payload.unit = widget.unit;
  }
  if (widget.decimals !== undefined) {
    payload.decimals = widget.decimals;
  }
  if (widget.max !== undefined) {
    payload.max = widget.max;
  }
  if (widget.min !== undefined) {
    payload.min = widget.min;
  }
  if (widget.windowMinutes !== undefined) {
    payload.windowMinutes = widget.windowMinutes;
  }
  if (widget.propertyIds !== undefined && widget.propertyIds.length > 0) {
    payload.propertyIds = [...widget.propertyIds];
  }
  return payload;
}

export function createBoardWidgetId(seed: number = Date.now()): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `board-${seed.toString(36)}-${random}`;
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

/** 把补丁里**合法**的字段合并进组件；空字符串对 unit/propertyIds 表示「清空」。 */
function mergeBoardWidgetPatch(
  current: BoardWidget,
  patch: Partial<Omit<BoardWidget, 'id'>>,
): BoardWidget {
  const next: BoardWidget = { ...current };
  if (isBoardWidgetType(patch.type)) {
    next.type = patch.type;
  }
  const title = asText(patch.title);
  if (title !== '') {
    next.title = title;
  }
  const deviceId = asText(patch.deviceId);
  if (deviceId !== '') {
    next.deviceId = deviceId;
  }
  const propertyId = asText(patch.propertyId);
  if (propertyId !== '') {
    next.propertyId = propertyId;
  }
  if (Object.hasOwn(patch, 'unit')) {
    const unit = asText(patch.unit);
    if (unit === '') {
      delete next.unit;
    } else {
      next.unit = unit;
    }
  }
  if (Object.hasOwn(patch, 'decimals')) {
    const decimals = asOptionalInteger(
      patch.decimals,
      0,
      IOT_BOARD_MAX_DECIMALS,
    );
    if (decimals === undefined) {
      delete next.decimals;
    } else {
      next.decimals = decimals;
    }
  }
  if (Object.hasOwn(patch, 'min')) {
    const min = asOptionalNumber(patch.min, -1e15, 1e15);
    if (min === undefined) {
      delete next.min;
    } else {
      next.min = min;
    }
  }
  if (Object.hasOwn(patch, 'max')) {
    const max = asOptionalNumber(patch.max, -1e15, 1e15);
    if (max === undefined) {
      delete next.max;
    } else {
      next.max = max;
    }
  }
  if (Object.hasOwn(patch, 'windowMinutes')) {
    const windowMinutes = asOptionalInteger(
      patch.windowMinutes,
      1,
      IOT_BOARD_MAX_WINDOW_MINUTES,
    );
    if (windowMinutes === undefined) {
      delete next.windowMinutes;
    } else {
      next.windowMinutes = windowMinutes;
    }
  }
  if (Object.hasOwn(patch, 'propertyIds')) {
    const propertyIds = sanitizeBoardPropertyIds(patch.propertyIds);
    if (propertyIds.length === 0) {
      delete next.propertyIds;
    } else {
      next.propertyIds = propertyIds;
    }
  }
  if (isMultiPointWidgetType(next.type)) {
    const propertyIds = sanitizeBoardPropertyIds(next.propertyIds);
    next.propertyIds = propertyIds.length > 0 ? propertyIds : [next.propertyId];
  }
  return next;
}

/** 编辑组件：只接受合法类型与非空字符串，非法字段忽略（不把坏值写进配置）。 */
export function updateBoardWidget(
  config: BoardConfig,
  id: string,
  patch: Partial<Omit<BoardWidget, 'id'>>,
): BoardConfig {
  return {
    version: config.version,
    widgets: config.widgets.map((widget) =>
      widget.id === id ? mergeBoardWidgetPatch(widget, patch) : widget,
    ),
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
 * 把 from 处的元素移动到 to（插入语义：其余元素整体让位，不交换两项）。
 *
 * 纯函数、不修改入参：越界/非整数/原地移动一律**返回入参引用**（调用方可据此跳过重渲染与
 * 无意义的 PUT）。拖拽与「上移/下移」按钮共用这一条规则，保证两条交互路径行为一致。
 */
export function moveWidget<T>(list: T[], from: number, to: number): T[] {
  if (!Array.isArray(list) || list.length < 2) {
    return list;
  }
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length ||
    from === to
  ) {
    return list;
  }
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) {
    return list;
  }
  next.splice(to, 0, item);
  return next;
}

/** 按组件 id 上移/下移 offset 位（键盘/触屏兜底按钮用）；找不到或越界时原样返回。 */
export function moveBoardWidget(
  config: BoardConfig,
  id: string,
  offset: number,
): BoardConfig {
  const from = config.widgets.findIndex((widget) => widget.id === id);
  if (from === -1) {
    return config;
  }
  const widgets = moveWidget(config.widgets, from, from + offset);
  return widgets === config.widgets ? config : { ...config, widgets };
}

export type BoardConfigSource = 'empty' | 'local-draft' | 'platform';

/** 后端 GET 的结果（失败时给可展示的 error，绝不吞成空看板）。 */
export interface BoardRemoteResult {
  error?: string;
  ok: boolean;
  widgets?: BoardWidget[];
}

export interface BoardLoadPlan {
  config: BoardConfig;
  /** 平台未配置但本地有草稿 ⇒ 必须提示「是否上传到平台？」。 */
  localDraftAvailable: boolean;
  /** 本地草稿被重置（JSON 坏/版本不符），需要可见提示。 */
  localReset: boolean;
  /** 后端失败原因（原样展示，空串表示 GET 成功）。 */
  remoteError: string;
  /** 展示的配置是否为本地草稿（未同步到平台）。 */
  source: BoardConfigSource;
}

/**
 * 加载决策（纯函数）：**先平台、后本地**，且永不静默丢弃用户的未同步改动。
 *
 * 判定顺序：
 * 1. 本地草稿标记 dirty（上次 PUT 失败）⇒ 展示本地草稿并给「未同步」提示，
 *    即使平台已有配置也不覆盖——否则一次网络抖动就会吞掉用户刚改的看板；
 * 2. 平台 GET 成功且有组件 ⇒ 平台为准（平台是租户共享唯一事实源）；
 * 3. 平台 GET 成功但为空（**空数组 = 无配置，不是配置损坏**）⇒ 本地有草稿则回落本地，
 *    并提示「检测到本地草稿，是否上传到平台？」；
 * 4. 平台 GET 失败 ⇒ 回落本地草稿（有则用，无则空看板）并原样展示失败原因。
 */
export function planBoardLoad(
  remote: BoardRemoteResult,
  local: BoardConfigLoadResult,
): BoardLoadPlan {
  const remoteError = remote.ok ? '' : (remote.error ?? '');
  const localWidgets = local.config.widgets;
  const hasLocalDraft = localWidgets.length > 0;
  if (local.dirty && hasLocalDraft) {
    return {
      config: local.config,
      localDraftAvailable: false,
      localReset: local.reset,
      remoteError,
      source: 'local-draft',
    };
  }
  if (remote.ok) {
    const widgets = remote.widgets ?? [];
    if (widgets.length > 0) {
      return {
        config: { version: IOT_BOARD_VERSION, widgets },
        localDraftAvailable: false,
        localReset: local.reset,
        remoteError: '',
        source: 'platform',
      };
    }
    if (hasLocalDraft) {
      return {
        config: local.config,
        localDraftAvailable: true,
        localReset: local.reset,
        remoteError: '',
        source: 'local-draft',
      };
    }
    return {
      config: createEmptyBoardConfig(),
      localDraftAvailable: false,
      localReset: local.reset,
      remoteError: '',
      source: 'empty',
    };
  }
  return {
    config: hasLocalDraft ? local.config : createEmptyBoardConfig(),
    localDraftAvailable: false,
    localReset: local.reset,
    remoteError,
    source: hasLocalDraft ? 'local-draft' : 'empty',
  };
}

/** 组件关注的点位集合：多点位类型用 propertyIds，单点位类型回落 propertyId（去重保序）。 */
export function boardWidgetPropertyIds(widget: BoardWidget): string[] {
  const ids = (widget.propertyIds ?? []).filter(
    (id) => typeof id === 'string' && id.trim() !== '',
  );
  if (ids.length === 0) {
    return widget.propertyId === '' ? [] : [widget.propertyId];
  }
  return ids.includes(widget.propertyId)
    ? [...ids]
    : [widget.propertyId, ...ids];
}

/**
 * 实时事件是否命中该组件：设备一致，且点位属于该组件关注的点位集合
 * （deviceId/propertyId 可能是 Long 字符串或 number）。不命中静默忽略——看板里可能有
 * 多个设备的组件，事件不属于它们。
 */
export function boardLatestMatchesWidget(
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
  if (String(deviceId).trim() !== widget.deviceId) {
    return false;
  }
  const target = String(propertyId).trim();
  return boardWidgetPropertyIds(widget).includes(target);
}

/**
 * 单点位实时匹配（保留旧签名给单点位组件/既有调用方）；多点位组件请用
 * {@link boardLatestMatchesWidget}，否则只会命中 propertyId 那一条点位。
 */
export function boardLatestMatches(
  widget: BoardWidget,
  payload: { deviceId?: unknown; propertyId?: unknown },
): boolean {
  return boardLatestMatchesWidget(widget, payload);
}

/** 折线窗口（毫秒）：组件配置优先，非法/缺省回落默认 24 小时。 */
export function resolveBoardWindowMs(widget: BoardWidget): number {
  const minutes =
    widget.windowMinutes !== undefined && widget.windowMinutes > 0
      ? widget.windowMinutes
      : IOT_BOARD_DEFAULT_WINDOW_MINUTES;
  return minutes * 60 * 1000;
}

/** 表单字段 → 哪些组件类型需要显示（顺序无关；用于类型条件显示字段）。 */
export const BOARD_WIDGET_FIELD_TYPES: Record<
  | 'decimals'
  | 'gaugeMax'
  | 'gaugeMin'
  | 'propertyId'
  | 'propertyIds'
  | 'unit'
  | 'windowMinutes',
  BoardWidgetType[]
> = {
  decimals: ['boolean', 'gauge', 'line', 'multi-line', 'table', 'value'],
  gaugeMax: ['gauge'],
  gaugeMin: ['gauge'],
  propertyId: ['boolean', 'gauge', 'line', 'status', 'value'],
  propertyIds: ['multi-line', 'table'],
  unit: ['gauge', 'line', 'multi-line', 'table', 'value'],
  windowMinutes: ['line', 'multi-line'],
};

/** 该组件类型是否需要显示某个表单字段。 */
export function isBoardWidgetFieldVisible(
  field: keyof typeof BOARD_WIDGET_FIELD_TYPES,
  type: unknown,
): boolean {
  if (!isBoardWidgetType(type)) {
    return false;
  }
  return BOARD_WIDGET_FIELD_TYPES[field].includes(type);
}

export type BoardPointDropReason = '' | 'duplicate-ts' | 'invalid-ts';

/** 追加输入：ts 允许空（SSE 字段可空），由 appendBoardPoint 统一校验。 */
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

/** 归一化小数位：非法值返回 undefined（表示「原样展示」，而不是假装 0 位）。 */
function normalizeDecimals(decimals?: number): number | undefined {
  if (
    decimals === undefined ||
    decimals === null ||
    !Number.isFinite(decimals)
  ) {
    return undefined;
  }
  const rounded = Math.round(decimals);
  return rounded < 0 || rounded > IOT_BOARD_MAX_DECIMALS ? undefined : rounded;
}

/**
 * 展示用数值格式化：能解析成数字且配了小数位就定点格式化；否则原样返回后端字符串
 * （文本点位不因「格式化」被抹掉）。空值返回空串，由调用方决定占位符。
 */
export function formatBoardValue(
  value: null | number | string | undefined,
  decimals?: number,
): string {
  const text = asText(value);
  if (text === '') {
    return '';
  }
  const digits = normalizeDecimals(decimals);
  if (digits === undefined) {
    return text;
  }
  const numeric = toBoardNumeric(text);
  return numeric === null ? text : numeric.toFixed(digits);
}

/** 布尔真值表：只有明确列出的写法才判定 on/off，其余（含文本/多值）一律 unknown。 */
const BOARD_BOOLEAN_ON = new Set([
  '1',
  'enable',
  'enabled',
  'on',
  'open',
  'opened',
  'start',
  'started',
  'true',
  'yes',
]);

const BOARD_BOOLEAN_OFF = new Set([
  '0',
  'close',
  'closed',
  'disable',
  'disabled',
  'false',
  'no',
  'off',
  'stop',
  'stopped',
]);

/**
 * 布尔开关卡的状态判定：true/1/ON/YES/START 等 → on，false/0/OFF/NO/STOP 等 → off，
 * 其余（空值、2、AUTO 这类非二值文本）→ **unknown**（不猜，不把未知画成「关」）。
 */
export function resolveBoardBoolean(
  value: boolean | null | number | string | undefined,
): BoardBooleanState {
  if (value === null || value === undefined) {
    return 'unknown';
  }
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }
  const text = String(value).trim().toLowerCase();
  if (text === '') {
    return 'unknown';
  }
  if (BOARD_BOOLEAN_ON.has(text)) {
    return 'on';
  }
  if (BOARD_BOOLEAN_OFF.has(text)) {
    return 'off';
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    if (numeric === 1) {
      return 'on';
    }
    if (numeric === 0) {
      return 'off';
    }
  }
  return 'unknown';
}
