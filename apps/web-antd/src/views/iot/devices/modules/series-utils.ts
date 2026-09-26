import type { IotPointApi, IotSeriesApi, IotThingModelApi } from '#/api/iot';

import dayjs from 'dayjs';

/**
 * 历史曲线的**纯计算部分**（点位候选、时间范围、图表模型、明细与 CSV 行）。
 *
 * 抽出来的理由有两个，都不是为了好看：
 * 1. 这些规则（点位标识怎么从「点位映射 + 物模型」拼出来、快捷时间范围算成哪两个时刻、
 *    空时间范围对应后端的哪种语义、非数值点怎么处理）是**有对错**的，必须能单测；
 * 2. 组件里只剩「拉数据 + 渲染」，出了问题一眼能分清是取数错还是画错。
 */

/** 单次查询最多同时叠加的点位条数。 */
export const IOT_SERIES_MAX_SELECTED_POINTS = 5;

/**
 * 自动刷新间隔（毫秒）。
 *
 * 默认**关闭**，只有用户显式打开才按此周期重查：历史曲线背后是 IoTDB 全表扫（无预聚合），
 * 默认自动刷新会把「打开抽屉不动」变成持续压库。
 */
export const IOT_SERIES_AUTO_REFRESH_MS = 30_000;

/**
 * 明细表最多渲染的行数。
 *
 * 多选叠加时行数可达「点位数 × limit」（最多 5 × 5000）⇒ 全量塞进 DOM 会明显卡顿。
 * 明细只展示前 N 行并**显式提示被截断**，完整数据仍由 CSV 导出（导出不受此限）。
 */
export const IOT_SERIES_TABLE_MAX_ROWS = 500;

/** 曲线配色（与主色系一致，第一条沿用既有的 `#0066f5`）。 */
export const IOT_SERIES_COLORS = [
  '#0066f5',
  '#00b42a',
  '#ff7d00',
  '#f53f3f',
  '#722ed1',
] as const;

/**
 * 点位标识白名单：与后端 `PropertyIdRules.PATTERN` 逐字一致
 * （`[A-Za-z0-9_.:-]{1,128}`）。前端先拦一道，免得把注定报错的请求发出去。
 */
export const IOT_PROPERTY_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** 点位标识是否合法（与后端同一口径）。 */
export function isValidPropertyId(value: string): boolean {
  return IOT_PROPERTY_ID_PATTERN.test(value);
}

// ---------- 时间范围 ----------

/** 时间范围的取值方式：4 个快捷区间 + 自定义。 */
export type SeriesRangeMode = '1h' | '24h' | '6h' | '7d' | 'custom';

/** 默认时间范围 = 最近 24 小时（不再让后端拿「最早的 N 个点」当默认）。 */
export const IOT_SERIES_DEFAULT_RANGE_MODE: SeriesRangeMode = '24h';

/** 快捷区间（`mode` 与 i18n 键、与 `hours` 一一对应，新增档位只需加一行）。 */
export const IOT_SERIES_RANGE_PRESETS: {
  hours: number;
  mode: Exclude<SeriesRangeMode, 'custom'>;
}[] = [
  { hours: 1, mode: '1h' },
  { hours: 6, mode: '6h' },
  { hours: 24, mode: '24h' },
  { hours: 168, mode: '7d' },
];

/** 一个时间范围（epoch 毫秒；`undefined` 表示该侧不限制）。 */
export interface SeriesResolvedRange {
  from?: number;
  to?: number;
  /** 两侧都没有：后端按 `time >= 0 AND time <= MAX` 升序取 **最早的** limit 个点。 */
  unbounded: boolean;
}

/**
 * 把「快捷档位 / 自定义」解析成要发给后端的 `from`/`to`。
 *
 * ⚠️ 语义要点（与后端 `IotDbTimeSeriesStore` 一致）：**空范围不是「最近 limit 个点」**，
 * 而是 `AND time >= 0` 的升序前 limit 条 = 该点位**最早的** limit 个点。
 * 所以默认值必须是显式的最近 24 小时，`unbounded` 只出现在用户主动清空时间时，并由界面提示。
 */
export function resolveSeriesRange(
  mode: SeriesRangeMode,
  custom: undefined | { from?: number; to?: number },
  now: number,
): SeriesResolvedRange {
  if (mode === 'custom') {
    const from = custom?.from;
    const to = custom?.to;
    return { from, to, unbounded: from === undefined && to === undefined };
  }
  const preset = IOT_SERIES_RANGE_PRESETS.find((item) => item.mode === mode);
  // 档位写错时退回默认档而不是发给后端一个空范围（空范围语义完全不同，静默退回最危险）
  const hours = preset?.hours ?? 24;
  return { from: now - hours * 3_600_000, to: now, unbounded: false };
}

/** 时间范围的可读标签（自定义档给「起始 ~ 结束」，空范围给「未限定」文案由调用方拼）。 */
export function formatRangeLabel(
  from: undefined | number,
  to: undefined | number,
): string {
  if (from === undefined && to === undefined) {
    return '';
  }
  const fmt = (value?: number) =>
    value === undefined ? '—' : dayjs(value).format('YYYY-MM-DD HH:mm:ss');
  return `${fmt(from)} ~ ${fmt(to)}`;
}

// ---------- 点位候选 ----------

/**
 * 一个可选点位（`value` 是要发给后端的 `propertyId`，即**属性标识符**）。
 *
 * 三来源合一，`mapped`/`orphan` 只是标签，不改 `value` 的语义：
 * 1. 已在设备上配了点位映射、且能在物模型里找到属性 ⇒ `mapped=true`（正常点位）；
 * 2. 属性存在但该设备没配映射 ⇒ `mapped=false`（查出来多半是空，但**必须列出来**：
 *    否则「设备一个点位都没配」时下拉是空的，用户连查都查不了）；
 * 3. 映射引用的属性已被删（TSL 重导入是物理删）⇒ `orphan=true`，`value` 退回属性主键字符串
 *    —— 后端对「查不到的形态」按原样查 `property_id = '<主键>'`，正好命中坐标统一之前的存量行。
 */
export interface SeriesPointOption {
  dataType?: string;
  enabled?: boolean;
  identifier: string;
  mapped: boolean;
  orphan: boolean;
  propertyId: string;
  propertyName?: string;
  rawAddress?: string;
  unit?: string;
  /** 发给后端的 `propertyId` 参数（属性标识符，或孤儿点的属性主键字符串）。 */
  value: string;
}

/**
 * 点位候选 = 设备点位映射（`GET /devices/{id}/points`）与产品物模型属性的连接结果。
 *
 * 连接键是**属性主键**（`point.propertyId === property.id`）：点位映射接口只给主键，
 * 而历史曲线接口要的是**标识符**（后端 `PointMappingIndex` 的规范坐标）⇒ 必须经物模型翻译一次。
 *
 * 同一标识符只保留第一条：后端明确记录「同产品多 service 可有同名标识，两条映射共享同一规范坐标」
 * （`PointMappingIndex` 的 `duplicateIdentifiers`），前端重复列出只会让用户选出两条一模一样的曲线。
 */
export function buildPointOptions(
  points: IotPointApi.PointMappingResp[],
  properties: IotThingModelApi.PropertyResp[],
): SeriesPointOption[] {
  const propertyById = new Map(properties.map((item) => [item.id, item]));
  const mapped: SeriesPointOption[] = [];
  const orphans: SeriesPointOption[] = [];
  const seen = new Set<string>();

  for (const point of points) {
    // 命令不是时序点位（access 只对属性点位写时序）
    if (point.refType !== 'property') {
      continue;
    }
    const property = propertyById.get(point.propertyId);
    if (!property) {
      orphans.push({
        identifier: '',
        mapped: true,
        orphan: true,
        propertyId: String(point.propertyId),
        rawAddress: point.rawAddress,
        enabled: point.enabled,
        value: String(point.propertyId),
      });
      continue;
    }
    if (seen.has(property.identifier)) {
      continue;
    }
    seen.add(property.identifier);
    mapped.push({
      dataType: property.dataType,
      enabled: point.enabled,
      identifier: property.identifier,
      mapped: true,
      orphan: false,
      propertyId: property.id,
      propertyName: property.propertyName,
      rawAddress: point.rawAddress,
      unit: property.unit,
      value: property.identifier,
    });
  }

  // 未映射的属性排在已映射之后：默认选中第一个时命中的是「真的有点位」的那个
  const unmapped: SeriesPointOption[] = [];
  for (const property of properties) {
    if (seen.has(property.identifier)) {
      continue;
    }
    seen.add(property.identifier);
    unmapped.push({
      dataType: property.dataType,
      identifier: property.identifier,
      mapped: false,
      orphan: false,
      propertyId: property.id,
      propertyName: property.propertyName,
      unit: property.unit,
      value: property.identifier,
    });
  }

  return [...mapped, ...unmapped, ...orphans];
}

/** 把物模型的「服务 → 属性」分组打平成属性列表（连接点位映射用）。 */
export function flattenProperties(
  groups: { properties: IotThingModelApi.PropertyResp[] }[],
): IotThingModelApi.PropertyResp[] {
  return groups.flatMap((group) => group.properties);
}

/**
 * 物模型是否**不可用**（拿不到属性 ⇒ 映射里的属性主键翻译不出标识符）。
 *
 * 为什么必须显式区分（2026-09-27 独立复核提出）：设备未绑产品、或产品物模型属性为空时，
 * `buildPointOptions` 会把所有映射降级成「孤儿点」按**属性主键**查询；而坐标统一后写进 IoTDB 的是
 * **标识符**，按主键查会返回 0 条 —— 界面于是显示「该时间范围内无数据」，可数据其实存在。
 * 这是「把查不到演成没有数据」，必须给用户一句明确的降级告警，而不是让他自己猜。
 *
 * @param hasProduct    设备是否绑定了产品（未绑定 ⇒ 无法取物模型）
 * @param propertyCount 取到的物模型属性个数
 * @returns 降级原因；`null` 表示物模型可用
 */
export function resolveModelHint(
  hasProduct: boolean,
  propertyCount: number,
): ModelHint {
  if (!hasProduct) {
    return 'noProduct';
  }
  return propertyCount === 0 ? 'emptyModel' : null;
}

/** 物模型不可用的两种情形（组件据此选文案，纯函数便于单测）。 */
export type ModelHint = 'emptyModel' | 'noProduct' | null;

/**
 * 解析不出标识符的点位个数（`orphan`）。
 *
 * 这个数字与「物模型是否可用」**不是同一件事**：物模型只有部分属性（TSL 重导入物理删了属性、
 * 或产品物模型读取失败）时，未绑产品/空物模型的告警不会出现，但那些点位**同样只能按属性主键查**
 * （坐标统一后存的是标识符 ⇒ 多半 0 条）。故组件按这个数字单独给一条告警，不靠 `ModelHint` 兜。
 *
 * @param options 点位候选
 * @returns 解析不出属性标识符的候选个数
 */
export function countOrphanPoints(options: SeriesPointOption[]): number {
  return options.filter((option) => option.orphan).length;
}

// ---------- 数值与时间格式 ----------

/** 值转数字：空/非数值（文本点位）返回 null —— 折线在这些点断开，而不是被画成 0。 */
export function toNumeric(value: null | string | undefined): null | number {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 明细表与 CSV 的时间格式：**带毫秒**。
 *
 * 时序点在同一秒内可能有多条读数，截到秒会让两行看起来一模一样，导出的 CSV 也就不是无损的。
 */
export function formatSeriesTs(ts: number | string): string {
  const millis = Number(ts);
  return Number.isFinite(millis)
    ? dayjs(millis).format('YYYY-MM-DD HH:mm:ss.SSS')
    : String(ts);
}

/** 图表横轴的时间格式：截到秒（轴标签空间有限，毫秒只会让同一秒的标签挤在一起）。 */
export function formatAxisTs(ts: number | string): string {
  const millis = Number(ts);
  return Number.isFinite(millis)
    ? dayjs(millis).format('MM-DD HH:mm')
    : String(ts);
}

// ---------- 查询结果 ----------

/** 一个点位的查询结果（`error` 非空表示**后端失败**，与「没有数据」严格区分）。 */
export interface SeriesQueryResult {
  error: string;
  name: string;
  points: IotSeriesApi.TimeSeriesPointResp[];
  propertyId: string;
  unit: string;
}

/** 该结果里可绘制的数值点个数。 */
export function numericCount(points: IotSeriesApi.TimeSeriesPointResp[]): number {
  return points.filter((point) => toNumeric(point.value) !== null).length;
}

/** 是否存在可绘制的数值点：全是文本点位时不画空坐标系，只给明细表。 */
export function hasNumericPoints(
  points: IotSeriesApi.TimeSeriesPointResp[],
): boolean {
  return numericCount(points) > 0;
}

/** 有数据可画的结果（失败与空结果都不进图）。 */
export function chartableResults(
  results: SeriesQueryResult[],
): SeriesQueryResult[] {
  return results.filter(
    (item) => item.error === '' && hasNumericPoints(item.points),
  );
}

/** 图的 Y 轴单位列表（去重、按结果顺序稳定）：每个单位一条轴，不同量纲不共轴。 */
export function chartUnits(results: SeriesQueryResult[]): string[] {
  const units: string[] = [];
  for (const item of chartableResults(results)) {
    const unit = item.unit || '';
    if (!units.includes(unit)) {
      units.push(unit);
    }
  }
  return units;
}

/** 一条曲线的绘图模型（与 echarts 解耦，便于单测）。 */
export interface ChartSeriesModel {
  color: string;
  data: (null | number)[];
  name: string;
  propertyId: string;
  showSymbol: boolean;
  timestamps: number[];
  unit: string;
  yAxisIndex: number;
}

/** 单条曲线超过此点数就不画数据点符号（点了密到看不清，只会拖慢渲染）。 */
export const IOT_SERIES_SYMBOL_MAX_POINTS = 200;

/**
 * 图表数据模型：`data[i]` 与 `timestamps[i]` 一一对应，非数值点为 `null`（曲线在此断开）。
 *
 * 用 `timestamps + data` 而不是「等距类别轴」：多个点位的采样时刻各不相同，
 * 类别轴会把它们按索引对齐，画出来的时间关系是假的（两条曲线的峰会被强行对齐到同一 X 位置）。
 */
export function buildChartModel(results: SeriesQueryResult[]): ChartSeriesModel[] {
  const units = chartUnits(results);
  return chartableResults(results).map((item, index) => ({
    color: IOT_SERIES_COLORS[index % IOT_SERIES_COLORS.length] ?? '#0066f5',
    data: item.points.map((point) => toNumeric(point.value)),
    name: item.unit ? `${item.name}（${item.unit}）` : item.name,
    propertyId: item.propertyId,
    showSymbol: item.points.length <= IOT_SERIES_SYMBOL_MAX_POINTS,
    timestamps: item.points.map((point) => Number(point.ts)),
    unit: item.unit,
    yAxisIndex: Math.max(units.indexOf(item.unit || ''), 0),
  }));
}

// ---------- 明细与 CSV ----------

/** 明细表的一行。 */
export interface SeriesDetailRow {
  key: string;
  name: string;
  propertyId: string;
  quality: string;
  ts: string;
  tsMillis: number;
  value: string;
}

function sortPoints(
  results: SeriesQueryResult[],
): { name: string; point: IotSeriesApi.TimeSeriesPointResp; propertyId: string }[] {
  const rows: {
    name: string;
    point: IotSeriesApi.TimeSeriesPointResp;
    propertyId: string;
  }[] = [];
  for (const item of results) {
    if (item.error !== '') {
      continue;
    }
    for (const point of item.points) {
      rows.push({ name: item.name, point, propertyId: item.propertyId });
    }
  }
  // 多个点位混排时按时刻升序（与后端单点位升序一致，导出文件也就可对比）
  return rows.sort((left, right) => {
    const delta = Number(left.point.ts) - Number(right.point.ts);
    return delta === 0
      ? left.propertyId.localeCompare(right.propertyId)
      : delta;
  });
}

/** 明细行（只成功的结果；时间带毫秒）。 */
export function buildDetailRows(
  results: SeriesQueryResult[],
  maxRows: number = Number.POSITIVE_INFINITY,
): { rows: SeriesDetailRow[]; total: number; truncated: boolean } {
  const sorted = sortPoints(results);
  const limited = sorted.slice(0, maxRows);
  return {
    rows: limited.map((item, index) => ({
      key: `${item.propertyId}-${item.point.ts}-${index}`,
      name: item.name,
      propertyId: item.propertyId,
      quality: item.point.quality ?? '',
      ts: formatSeriesTs(item.point.ts),
      tsMillis: Number(item.point.ts),
      value: item.point.value ?? '',
    })),
    total: sorted.length,
    truncated: sorted.length > limited.length,
  };
}

/**
 * CSV 单元格：先做公式注入防护，再做 RFC 4180 转义。
 *
 * 读数原值来自设备上报，属不可信输入：以 `=` 或 `@` 开头的文本会被 Excel/Sheets 当**公式**执行
 * （DDE 一类；参见 CVE-2021-41270 这类 CSV 注入案例），故前置单引号使其按文本处理。
 * `+`/`-` 不处理——它们是合法的数值前缀（负数），一刀切会把数值变成文本。
 */
export function csvCell(cell: string): string {
  const guarded = /^[=@]/.test(cell) ? `'${cell}` : cell;
  return /["\r\n,]/.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}

/** 行 → CSV 文本（CRLF；不含 BOM，BOM 由下载处加）。 */
export function buildCsv(header: string[], rows: string[][]): string {
  return [header, ...rows]
    .map((cells) => cells.map((cell) => csvCell(cell)).join(','))
    .join('\r\n');
}

/**
 * CSV 数据行（**不截断**，与明细表的展示上限无关）。
 *
 * 单点位时列是「时间,数值,质量码」（与本次改造前的导出逐列一致，老用户脚本不受影响）；
 * 多点位叠加时**首列补点位**——否则多行数据混在一起无法区分属于哪个点位。
 */
export function buildCsvRows(
  results: SeriesQueryResult[],
  withPoint: boolean,
): string[][] {
  return sortPoints(results).map((item) =>
    withPoint
      ? [
          item.propertyId,
          formatSeriesTs(item.point.ts),
          item.point.value ?? '',
          item.point.quality ?? '',
        ]
      : [
          formatSeriesTs(item.point.ts),
          item.point.value ?? '',
          item.point.quality ?? '',
        ],
  );
}

/** 导出文件名：设备 + 点位 + 时间戳（点位里的非安全字符统一换成下划线）。 */
export function seriesCsvFileName(
  deviceId: string,
  propertyIds: string[],
  now: number,
): string {
  const safePoints = propertyIds.join('+').replace(/[^\w.-]+/g, '_').slice(
    0,
    80,
  );
  return `iot-series-${deviceId}-${safePoints}-${dayjs(now).format(
    'YYYYMMDD-HHmmss',
  )}.csv`;
}

// ---------- 记住上次选择 ----------

/**
 * 上次使用的查询条件（时间档位 + 返回条数上限）。
 *
 * 存在 localStorage 里而不是每次回到默认值：同一台机器上反复看曲线的人，
 * 每次打开都要重新点一遍时间档位是纯粹的重复劳动。
 */
const PREFERENCES_KEY = 'iot-series-preferences';

export interface SeriesPreferences {
  limit: number;
  rangeMode: SeriesRangeMode;
}

/** 读取上次选择；不可用/损坏/越界时逐项退回默认（localStorage 在部分环境会抛异常）。 */
export function loadSeriesPreferences(): Partial<SeriesPreferences> {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const result: Partial<SeriesPreferences> = {};
    const mode = record.rangeMode;
    if (
      mode === '1h' ||
      mode === '6h' ||
      mode === '24h' ||
      mode === '7d' ||
      mode === 'custom'
    ) {
      result.rangeMode = mode;
    }
    const storedLimit = Number(record.limit);
    if (Number.isInteger(storedLimit) && storedLimit > 0) {
      result.limit = storedLimit;
    }
    return result;
  } catch {
    // 隐私模式/沙箱 iframe 下 localStorage 取值本身就会抛；记忆偏好失败不该影响查询
    return {};
  }
}

/** 写入上次选择（失败静默：这只是便利功能，不影响任何查询语义）。 */
export function saveSeriesPreferences(preferences: SeriesPreferences): void {
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // 同上：写不进去就下次重新选，不打断用户
  }
}
