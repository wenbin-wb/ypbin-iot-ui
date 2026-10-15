/**
 * 告警规则「历史试算」纯函数（零 vue / 零请求，可单测）。
 *
 * 判定口径刻意与后端 `AlertRules.verdict` 对齐（同一份语义的前端再实现，
 * 避免「预览说会触发、线上不触发」的口径漂移）：
 * - 只有 `quality === GOOD`（忽略大小写/空白）的样本可判定；null/非 GOOD 跳过，
 *   **不当作未命中**（后端语义：坏质量是不可判定，不得伪装成恢复）；
 * - NUMERIC 严格十进制解析：拒绝 NaN / Infinity / 0x / 空串 / 文本；
 * - BOOLEAN 只认 `true/false/1/0`，且只允许 EQ/NE（把 true 当 1 做大小比较会静默产生怪告警）；
 * - 比较严格按 operator（GT 读 30 且阈值 30 不触发，边界值由用例钉住）；
 * - `deadband` 只作用于**恢复侧**，触发侧不受影响（`recoverThreshold` 仅用于 UI 说明）。
 *
 * ## 多条件 = **同一设备上的合取条件组（AND）**（2026-10-15 起）
 *
 * 后端 `AlertTenantEvaluator#evaluateGroup`：一条规则落在同一台设备上的**全部**点位条件构成
 * **一个**条件组，只有**组内每条**条件对同一轮最新值都越界才触发；任一条未越界即不触发；
 * 任一条不可判定且无「未越界」⇒ 整组本轮不可判定（不触发也不恢复）。因此试算也必须**按组**做，
 * 而不能逐行各自算一遍（旧实现逐行算，是旧「逐条件独立判定」语义下的产物）。
 *
 * ## 时间对齐口径（**显式定义；UI 展示与这里的注释是同一套口径**）
 *
 * 组内各条件可能在不同 propertyId 上，各序列的采样时刻**不会天然重合**；而线上的「同一轮」
 * 是「每个点位各自的最新值」（评估周期内各点位独立刷新，**不是同一个物理时刻的同步采样**）。
 * 试算无法复现线上缓存，故定义如下（这是本模块**唯一的**近似来源）：
 *
 * 1. 组内每个点位先各取自己窗口内的最近 `limit` 条（限流裁剪与旧版逐条件试算一致，
 *    裁剪发生在**对齐之前**，即各点位各看自己最近多少条）；
 * 2. 以**组内全部序列时间戳的并集**为「对齐时刻」候选，严格**升序**逐时刻判定；
 * 3. 每个对齐时刻 t，对**每一条**条件取它所在序列中 `|ts − t| ≤ 容差` 的**最近邻**样本
 *    （并列时取更早的那条——与「轮询读最新值」的因果方向一致）；
 * 4. **容差 = 组内各序列采样间隔中位数中的最大值 × {@link ALIGN_TOLERANCE_RATIO}**，
 *    再夹到 [`MIN_ALIGN_TOLERANCE_MS`, `MAX_ALIGN_TOLERANCE_MS`]（见 {@link computeAlignTolerance}）；
 * 5. 某条件在容差内**取不到可判定样本**（没有样本 / 最近邻质量非 GOOD / 值不可解析）时，
 *    该条件在该时刻为**不可判定**（**不伪装成未命中**）：整个条件组该时刻不可判定，
 *    既不计命中也不计未命中，与后端「不可判定时计数与状态都不动」同口径；
 * 6. **两次取值的最大不同步量就是容差**：每次判定把该时刻实际用到的最大偏移
 *    `maxOffsetMs` 一并返回，UI 必须把「容差多少毫秒」与「本次最大偏移」都显示出来
 *    （见 {@link RulePreviewResult.alignToleranceMs} 与 {@link RulePreviewGroupSample.maxOffsetMs}），
 *    **不得只说「已对齐」**。
 *
 * 与线上评估的差异（如实注明，不美化）：线上按评估周期读取每个点位的最新值，并叠加
 * triggerMode（连续 N 次 / 持续 T 秒）、pendingTtl 与陈旧判定；本试算按对齐时刻逐点判定、
 * 连续命中合并为一段，不可判定样本不打断连续段。因此「触发段数」是近似值，不代表一定会告警。
 */
import type { IotSeriesApi } from '#/api/iot';

/** 与后端 `AlertRules.QUALITY_GOOD` 对齐。 */
export const RULE_PREVIEW_QUALITY_GOOD = 'GOOD';

/** 单次试算最多参与判定的样本数（与后端 `TimeSeriesQueryReq.MAX_LIMIT` 对齐）。 */
export const RULE_PREVIEW_MAX_SERIES_LIMIT = 5000;

/** 对齐容差相对采样间隔的倍率（模块头第 4 条）：取 1 个采样间隔。 */
export const ALIGN_TOLERANCE_RATIO = 1;

/** 采样间隔的兜底估计（毫秒）：某序列样本不足 2 条、算不出间隔时用它（不是硬编码魔数）。 */
export const DEFAULT_ALIGN_INTERVAL_MS = 60_000;

/** 对齐容差下限（毫秒）：高频采集时不至于退化成 0 而几乎全部不可判定。 */
export const MIN_ALIGN_TOLERANCE_MS = 1000;

/** 对齐容差上限（毫秒）：稀疏点位不得把「同一时刻」放宽到跨小时级。 */
export const MAX_ALIGN_TOLERANCE_MS = 300_000;

export type PreviewOperator = 'EQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'NE';

/** 规则里的一个点位条件（字段与后端 `IotAlertRulePoint` 同名）。 */
export interface RulePreviewCondition {
  deadband?: null | number | string;
  operator?: null | string;
  propertyId?: null | string;
  threshold?: null | number | string;
  valueType?: null | string;
}

/** 试算输入（单序列兼容入口）。 */
export interface RulePreviewInput {
  conditions: RulePreviewCondition[];
  from?: number;
  limit?: number;
  points: IotSeriesApi.TimeSeriesPointResp[];
  to?: number;
}

/** 条件组试算输入（组内每个点位各自的序列）。 */
export interface RulePreviewGroupInput {
  conditions: RulePreviewCondition[];
  from?: number;
  limit?: number;
  /**
   * 行点位 → 该点位的历史样本。
   *
   * 缺失（`undefined`）表示**没有查到该点位的序列**；空数组表示「查到了但没有样本」。
   * 两者都不伪装成未命中（该条件在所有对齐时刻都不可判定）。
   */
  seriesByPropertyId: Record<string, IotSeriesApi.TimeSeriesPointResp[]>;
  to?: number;
}

/** 归一化后的条件（UI 展示与计算共用）。 */
export interface RulePreviewConditionView {
  deadband: number;
  operator: PreviewOperator;
  propertyId: string;
  /** 恢复侧门槛（无回差/方向不适用时为 null）。 */
  recoverThreshold: null | number;
  symbol: string;
  threshold: number;
  valueType: 'BOOLEAN' | 'NUMERIC';
}

/** 参与判定的样本（不可判定样本被跳过，不在此列表）。 */
export interface RulePreviewSample {
  matched: boolean;
  ts: number;
  value: string;
}

/** 组内某条件在某对齐时刻的取值（**逐条件**证据，UI 明细与「读到多少」都用它）。 */
export interface RulePreviewGroupConditionValue {
  /** 该条件在条件数组里的序号（0 起），与表单行一一对应。 */
  index: number;
  /** 该时刻的实际判定：true 越界 / false 未越界 / null 不可判定。 */
  matched: boolean | null;
  /** 该样本相对对齐时刻的偏移（毫秒）；无法判定时为 null。 */
  offsetMs: null | number;
  propertyId: string;
  /** 取到的样本时刻；无法判定时为 null。 */
  sampleTs: null | number;
  /** 该时刻实际取到的值（取不到时为空串，**不伪造**）。 */
  value: string;
}

/** 一个对齐时刻的组判定结果。 */
export interface RulePreviewGroupSample {
  /** 组内**全部**条件都越界 ⇒ true；任一条明确未越界 ⇒ false；含不可判定 ⇒ null。 */
  matched: boolean | null;
  /** 该时刻实际用到的最大偏移（毫秒）；无任何可判定样本时为 null。 */
  maxOffsetMs: null | number;
  /** 对齐时刻（组内全部序列时间戳的并集元素）。 */
  ts: number;
  values: RulePreviewGroupConditionValue[];
}

/** 某一轮（对齐时刻）按后端同口径归出的组判定三态。 */
export type RulePreviewGroupVerdict =
  | 'IN_RANGE'
  | 'NOT_DECIDABLE'
  | 'OUT_OF_RANGE';

/** 组内一条条件在某时刻的判定（供 {@link decideGroupVerdict} 使用）。 */
export interface RulePreviewConditionEvaluation {
  /** 条件在数组里的序号（0 起）。 */
  index: number;
  /** 命中（越界）；不可判定为 null。 */
  matched: boolean | null;
  propertyId: string;
}

export type RulePreviewUnsupportedReason =
  | 'empty-conditions'
  | 'invalid-condition';

export interface RulePreviewResult {
  /** 本次试算用的对齐容差（毫秒）——UI 必须展示，见模块头「时间对齐口径」。 */
  alignToleranceMs: number;
  conditions: RulePreviewConditionView[];
  firstTriggerTs: null | number;
  /** 每个对齐时刻的判定明细（含逐条件取值；不可判定时刻也保留，供 UI 如实展示）。 */
  groupSamples: RulePreviewGroupSample[];
  kind: 'ok' | 'unsupported';
  lastTriggerTs: null | number;
  matchedCount: number;
  /** 组判定为不可判定的对齐时刻数（**不伪装成未命中**）。 */
  notDecidableCount: number;
  outsideWindowSamples: number;
  reason?: RulePreviewUnsupportedReason;
  samples: RulePreviewSample[];
  skippedSamples: number;
  totalSamples: number;
  triggerCount: number;
  truncatedSamples: number;
  usedSamples: number;
}

const OPERATOR_SYMBOLS: Record<PreviewOperator, string> = {
  EQ: '=',
  GT: '>',
  GTE: '>=',
  LT: '<',
  LTE: '<=',
  NE: '!=',
};

function normalizeOperator(value?: null | string): null | PreviewOperator {
  const token = (value ?? '').trim().toUpperCase();
  return token in OPERATOR_SYMBOLS ? (token as PreviewOperator) : null;
}

function normalizeValueType(value?: null | string): 'BOOLEAN' | 'NUMERIC' {
  return (value ?? '').trim().toUpperCase() === 'BOOLEAN'
    ? 'BOOLEAN'
    : 'NUMERIC';
}

/** 严格十进制解析：与后端 BigDecimal 口径一致，拒绝 NaN/Infinity/0x/空串。 */
function parseNumericStrict(value: null | number | string | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const text = value.trim();
  if (text === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 布尔解析：只认 true/false/1/0，归一成 1/0 参与比较。 */
function parseBooleanStrict(value: null | number | string | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  const token = String(value).trim().toLowerCase();
  if (token === 'true' || token === '1') {
    return 1;
  }
  if (token === 'false' || token === '0') {
    return 0;
  }
  return null;
}

function parseByType(
  value: null | number | string | undefined,
  valueType: 'BOOLEAN' | 'NUMERIC',
) {
  return valueType === 'BOOLEAN'
    ? parseBooleanStrict(value)
    : parseNumericStrict(value);
}

/** 触发条件是否成立（严格按比较符，边界值与后端逐条一致）。 */
export function conditionHolds(
  operator: PreviewOperator,
  threshold: number,
  value: number,
): boolean {
  switch (operator) {
    case 'EQ': {
      return value === threshold;
    }
    case 'GT': {
      return value > threshold;
    }
    case 'GTE': {
      return value >= threshold;
    }
    case 'LT': {
      return value < threshold;
    }
    case 'LTE': {
      return value <= threshold;
    }
    case 'NE': {
      return value !== threshold;
    }
    default: {
      return false;
    }
  }
}

/** 恢复侧门槛（deadband ≤ 0 或方向不适用时返回 null）。 */
function recoveryThreshold(
  operator: PreviewOperator,
  threshold: number,
  deadband: number,
): null | number {
  if (deadband <= 0) {
    return null;
  }
  switch (operator) {
    case 'GT':
    case 'GTE': {
      return threshold - deadband;
    }
    case 'LT':
    case 'LTE': {
      return threshold + deadband;
    }
    default: {
      // EQ 的恢复是「偏离超过回差」（区间），NE 无方向可退 ⇒ 不在单一门槛里表达
      return null;
    }
  }
}

/**
 * 条件归一化/合法性校验。
 *
 * @returns 全部合法时返回视图数组（空数组表示「无阈值条件」由调用方判定为断档类）；
 *          任一条件非法（比较符/比较域/阈值/回差/点位标识）返回 null。
 */
export function toPreviewConditionViews(
  conditions: RulePreviewCondition[],
): null | RulePreviewConditionView[] {
  const views: RulePreviewConditionView[] = [];
  for (const condition of conditions ?? []) {
    const operator = normalizeOperator(condition.operator);
    if (!operator) {
      return null;
    }
    const propertyId = (condition.propertyId ?? '').trim();
    if (propertyId === '') {
      return null;
    }
    const valueType = normalizeValueType(condition.valueType);
    if (valueType === 'BOOLEAN' && operator !== 'EQ' && operator !== 'NE') {
      return null;
    }
    const threshold = parseByType(condition.threshold, valueType);
    if (threshold === null) {
      return null;
    }
    const deadbandText = condition.deadband;
    const deadband =
      deadbandText === null || deadbandText === undefined || deadbandText === ''
        ? 0
        : parseNumericStrict(deadbandText);
    if (deadband === null || deadband < 0) {
      return null;
    }
    views.push({
      deadband,
      operator,
      propertyId,
      recoverThreshold: recoveryThreshold(operator, threshold, deadband),
      symbol: OPERATOR_SYMBOLS[operator],
      threshold,
      valueType,
    });
  }
  return views;
}

function normalizeLimit(limit?: number): null | number {
  if (limit === undefined || limit === null || !Number.isFinite(limit)) {
    return null;
  }
  const floored = Math.floor(limit);
  if (floored <= 0) {
    return null;
  }
  return Math.min(floored, RULE_PREVIEW_MAX_SERIES_LIMIT);
}

/** 一条序列的采样间隔中位数（毫秒）；样本不足 2 条或间隔不可算时返回 null。 */
export function medianSampleInterval(
  points: IotSeriesApi.TimeSeriesPointResp[],
): null | number {
  // toSorted 而不是 sort：不得就地改动入参数组（该数组可能被调用方复用）
  const stamps = (points ?? [])
    .map((point) => parseNumericStrict(point.ts))
    .filter((ts): ts is number => ts !== null)
    .toSorted((a, b) => a - b);
  if (stamps.length < 2) {
    return null;
  }
  const gaps: number[] = [];
  for (let index = 1; index < stamps.length; index += 1) {
    const gap = (stamps[index] as number) - (stamps[index - 1] as number);
    if (gap > 0) {
      gaps.push(gap);
    }
  }
  if (gaps.length === 0) {
    return null;
  }
  gaps.sort((a, b) => a - b); // 局部数组（本函数自建）⇒ 就地排序即可
  const middle = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1
    ? (gaps[middle] as number)
    : ((gaps[middle - 1] as number) + (gaps[middle] as number)) / 2;
}

/**
 * 对齐容差（毫秒）：组内各序列采样间隔中位数**之中取最大**，乘 {@link ALIGN_TOLERANCE_RATIO}，
 * 再夹到 [`MIN_ALIGN_TOLERANCE_MS`, `MAX_ALIGN_TOLERANCE_MS`]。
 *
 * 为什么取最大而不是最小：容差至少要覆盖采样最慢那个点位的一个间隔，否则该点位的值永远
 * 找不到邻居、整组永远不可判定（试算退化成「什么都算不出来」）。为什么夹上限：稀疏点位
 * 的间隔可能是小时级，不夹就会把「同一时刻」放宽到无意义的程度。
 */
export function computeAlignTolerance(
  seriesByPropertyId: Record<string, IotSeriesApi.TimeSeriesPointResp[]>,
  usedPropertyIds: string[] = [],
): number {
  const intervals: number[] = [];
  for (const propertyId of usedPropertyIds) {
    intervals.push(
      medianSampleInterval(seriesByPropertyId[propertyId] ?? []) ??
        DEFAULT_ALIGN_INTERVAL_MS,
    );
  }
  const base =
    intervals.length === 0 ? DEFAULT_ALIGN_INTERVAL_MS : Math.max(...intervals);
  return Math.min(
    Math.max(base * ALIGN_TOLERANCE_RATIO, MIN_ALIGN_TOLERANCE_MS),
    MAX_ALIGN_TOLERANCE_MS,
  );
}

/**
 * 组判定：与后端 `AlertTenantEvaluator#groupVerdict` 同一套三态（见模块头）。
 *
 * ① 任一条明确未越界 ⇒ `IN_RANGE`（合取被证伪，**不得**因其它条件越界而触发）；
 * ② 否则必须「存在可判定的越界项」且「没有残留的不可判定项」才是 `OUT_OF_RANGE`
 *    （「部分越界 + 部分不可判定」是不可判定，不是越界）；
 * ③ 其余（全不可判定，或越界与不可判定混合）⇒ `NOT_DECIDABLE`。
 */
export function decideGroupVerdict(
  evaluations: RulePreviewConditionEvaluation[],
): RulePreviewGroupVerdict {
  if (evaluations.some((item) => item.matched === false)) {
    return 'IN_RANGE';
  }
  const anyOutOfRange = evaluations.some((item) => item.matched === true);
  const anyNotDecidable = evaluations.some((item) => item.matched === null);
  if (anyOutOfRange && !anyNotDecidable) {
    return 'OUT_OF_RANGE';
  }
  return 'NOT_DECIDABLE';
}

function unsupportedResult(
  reason: RulePreviewUnsupportedReason,
): RulePreviewResult {
  return {
    alignToleranceMs: 0,
    conditions: [],
    firstTriggerTs: null,
    groupSamples: [],
    kind: 'unsupported',
    lastTriggerTs: null,
    matchedCount: 0,
    notDecidableCount: 0,
    outsideWindowSamples: 0,
    reason,
    samples: [],
    skippedSamples: 0,
    totalSamples: 0,
    triggerCount: 0,
    truncatedSamples: 0,
    usedSamples: 0,
  };
}

/** 裁剪后的一条序列（ts 严格升序）。 */
interface PreparedSeries {
  points: { point: IotSeriesApi.TimeSeriesPointResp; ts: number }[];
}

/** 把某点位的原始样本按时间窗/limit/可解析性裁剪成升序序列，并累计各统计量。 */
function prepareSeries(
  points: IotSeriesApi.TimeSeriesPointResp[],
  from: number | undefined,
  to: number | undefined,
  limit: null | number,
): PreparedSeries & {
  outsideWindowSamples: number;
  skippedSamples: number;
  totalSamples: number;
  truncatedSamples: number;
} {
  let outsideWindowSamples = 0;
  let skippedSamples = 0;
  const usable: { point: IotSeriesApi.TimeSeriesPointResp; ts: number }[] = [];
  for (const point of points ?? []) {
    const ts = parseNumericStrict(point.ts);
    if (ts === null) {
      skippedSamples += 1;
      continue;
    }
    if ((from !== undefined && ts < from) || (to !== undefined && ts > to)) {
      outsideWindowSamples += 1;
      continue;
    }
    usable.push({ point, ts });
  }
  usable.sort((a, b) => a.ts - b.ts); // 局部数组（本函数自建）⇒ 就地排序即可
  const windowed =
    limit === null ? usable : usable.slice(Math.max(0, usable.length - limit));
  return {
    outsideWindowSamples,
    points: windowed,
    skippedSamples,
    totalSamples: (points ?? []).length,
    truncatedSamples: usable.length - windowed.length,
  };
}

/** 按升序插入去重（组内序列逐个合并时，逆序冲突只可能来自本序列的首个 ts）。 */
function pushSortedUnique(target: number[], value: number) {
  const last = target.at(-1);
  if (last === undefined || last < value) {
    target.push(value);
    return;
  }
  if (last === value) {
    return;
  }
  let low = 0;
  let high = target.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((target[middle] as number) < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (target[low] !== value) {
    target.splice(low, 0, value);
  }
}

/**
 * 在一条升序序列里取 `|ts − target|` 最小的样本（**并列取更早的那条**）。
 *
 * @returns 命中的下标；超出容差或无样本时返回 null
 */
function nearestIndex(
  points: { point: IotSeriesApi.TimeSeriesPointResp; ts: number }[],
  target: number,
  tolerance: number,
): null | number {
  if (points.length === 0) {
    return null;
  }
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((points[middle]?.ts as number) < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  let best: null | number = null;
  for (const index of [low, low - 1]) {
    const item = points[index];
    if (!item) {
      continue;
    }
    const offset = Math.abs(item.ts - target);
    if (offset > tolerance) {
      continue;
    }
    if (best === null) {
      best = index;
      continue;
    }
    const bestItem = points[best];
    if (!bestItem) {
      continue;
    }
    const bestOffset = Math.abs(bestItem.ts - target);
    // 并列（含完全等距）取更早的那条：与「轮询读最新值」的因果方向一致
    if (
      offset < bestOffset ||
      (offset === bestOffset && item.ts < bestItem.ts)
    ) {
      best = index;
    }
  }
  return best;
}

/** 样本质量是否为 GOOD（值与可解析性由调用方按比较域再判一次）。 */
function isGoodQuality(point: IotSeriesApi.TimeSeriesPointResp): boolean {
  return (
    typeof point.quality === 'string' &&
    point.quality.trim().toUpperCase() === RULE_PREVIEW_QUALITY_GOOD
  );
}

/**
 * **条件组整体试算**（真 AND；与后端 `AlertTenantEvaluator#evaluateGroup` 同口径的前端再实现）。
 *
 * 步骤：① 归一化整组条件（任一非法 ⇒ unsupported，不猜默认阈值）；② 组内每个点位各自裁剪；
 * ③ 算对齐容差；④ 以全部序列时间戳并集为对齐时刻，逐时刻取最近邻 → 组判定三态；
 * ⑤ 连续 `OUT_OF_RANGE` 合并为一段；`NOT_DECIDABLE` 不打断连续段（与后端「计数与状态都不动」
 * 同口径）；`IN_RANGE` 断段。
 */
export function evaluateRulePreviewGroup(
  input: RulePreviewGroupInput,
): RulePreviewResult {
  const conditions = input.conditions ?? [];
  if (conditions.length === 0) {
    return unsupportedResult('empty-conditions');
  }
  const views = toPreviewConditionViews(conditions);
  if (!views) {
    return unsupportedResult('invalid-condition');
  }

  const limit = normalizeLimit(input.limit);
  const seriesByPropertyId = input.seriesByPropertyId ?? {};
  const propertyIds = [...new Set(views.map((view) => view.propertyId))];
  const series = new Map<string, ReturnType<typeof prepareSeries>>();
  for (const propertyId of propertyIds) {
    series.set(
      propertyId,
      prepareSeries(
        seriesByPropertyId[propertyId] ?? [],
        input.from,
        input.to,
        limit,
      ),
    );
  }
  const alignToleranceMs = computeAlignTolerance(
    seriesByPropertyId,
    propertyIds,
  );

  // ④ 对齐时刻 = 组内全部序列时间戳的并集（升序、去重）
  const axis: number[] = [];
  let totalSamples = 0;
  let outsideWindowSamples = 0;
  let skippedSamples = 0;
  let truncatedSamples = 0;
  for (const item of series.values()) {
    totalSamples += item.totalSamples;
    outsideWindowSamples += item.outsideWindowSamples;
    skippedSamples += item.skippedSamples;
    truncatedSamples += item.truncatedSamples;
    for (const point of item.points) {
      pushSortedUnique(axis, point.ts);
    }
  }

  const samples: RulePreviewSample[] = [];
  const groupSamples: RulePreviewGroupSample[] = [];
  let matchedCount = 0;
  let triggerCount = 0;
  let notDecidableCount = 0;
  let inRun = false;
  let firstTriggerTs: null | number = null;
  let lastTriggerTs: null | number = null;

  for (const ts of axis) {
    const evaluations: RulePreviewConditionEvaluation[] = [];
    const values: RulePreviewGroupConditionValue[] = [];
    let maxOffsetMs: null | number = null;
    for (const [index, view] of views.entries()) {
      const aligned = series.get(view.propertyId);
      const hit = nearestIndex(aligned?.points ?? [], ts, alignToleranceMs);
      let matched: boolean | null = null;
      let sampleTs: null | number = null;
      let offsetMs: null | number = null;
      let value = '';
      const candidate = hit === null ? undefined : aligned?.points[hit];
      if (candidate) {
        const parsed = parseByType(candidate.point.value, view.valueType);
        // 最近邻的**质量与可解析性**同样决定它能否参与判定：不可判定样本等价于「没取到」
        // （不伪装成未命中，也不拿它当越界证据）
        if (isGoodQuality(candidate.point) && parsed !== null) {
          matched = conditionHolds(view.operator, view.threshold, parsed);
          sampleTs = candidate.ts;
          offsetMs = Math.abs(candidate.ts - ts);
          value = candidate.point.value ?? '';
          maxOffsetMs =
            maxOffsetMs === null ? offsetMs : Math.max(maxOffsetMs, offsetMs);
        }
      }
      evaluations.push({ index, matched, propertyId: view.propertyId });
      values.push({
        index,
        matched,
        offsetMs,
        propertyId: view.propertyId,
        sampleTs,
        value,
      });
    }

    const verdict = decideGroupVerdict(evaluations);
    const matched =
      verdict === 'NOT_DECIDABLE' ? null : verdict === 'OUT_OF_RANGE';
    groupSamples.push({ matched, maxOffsetMs, ts, values });

    if (matched === null) {
      // 不可判定：不计命中/未命中，也不打断连续段（同后端「计数保持不变」）
      notDecidableCount += 1;
      continue;
    }
    samples.push({
      matched,
      ts,
      // 组样本的展示值取第一条可判定条件的读数；逐条件取值见 groupSamples.values
      value: values.find((item) => item.sampleTs !== null)?.value ?? '',
    });
    if (matched) {
      matchedCount += 1;
      if (!inRun) {
        triggerCount += 1;
        inRun = true;
        if (firstTriggerTs === null) {
          firstTriggerTs = ts;
        }
      }
      lastTriggerTs = ts;
    } else {
      inRun = false;
    }
  }

  return {
    alignToleranceMs,
    conditions: views,
    firstTriggerTs,
    groupSamples,
    kind: 'ok',
    lastTriggerTs,
    matchedCount,
    notDecidableCount,
    outsideWindowSamples,
    samples,
    skippedSamples,
    totalSamples,
    triggerCount,
    truncatedSamples,
    usedSamples: samples.length,
  };
}

/**
 * 单序列兼容入口（调用方只有一份序列时用）。
 *
 * **注意**：它把同一份 `points` 挂到组内**每个** propertyId 上——只有当调用方确实只查了一个
 * 点位、或各条件共用同一份序列时才正确。组内多点位一律用 {@link evaluateRulePreviewGroup}。
 */
export function evaluateRulePreview(
  input: RulePreviewInput,
): RulePreviewResult {
  const conditions = input.conditions ?? [];
  const views = toPreviewConditionViews(conditions);
  if (conditions.length === 0) {
    return unsupportedResult('empty-conditions');
  }
  if (!views) {
    return unsupportedResult('invalid-condition');
  }
  const seriesByPropertyId: Record<string, IotSeriesApi.TimeSeriesPointResp[]> =
    {};
  for (const propertyId of new Set(views.map((view) => view.propertyId))) {
    seriesByPropertyId[propertyId] = input.points ?? [];
  }
  return evaluateRulePreviewGroup({
    conditions,
    from: input.from,
    limit: input.limit,
    seriesByPropertyId,
    to: input.to,
  });
}

/** 时间窗选项 → 毫秒（供 rule-form 试算区使用）。 */
export const RULE_PREVIEW_WINDOWS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
} as const;

export type RulePreviewWindowKey = keyof typeof RULE_PREVIEW_WINDOWS;
