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
 * 与线上评估的差异（如实注明，不美化）：
 * 线上按评估周期读取最新值，并叠加 triggerMode（连续 N 次 / 持续 T 秒）、
 * pendingTtl 与陈旧判定；本试算按采样点逐点判定，连续命中合并为一段，
 * 不可判定样本不打断连续段（与后端「不可判定保持计数不变」一致）。
 * 因此结果中的「触发段数」是近似值，不代表一定会告警。
 */
import type { IotSeriesApi } from '#/api/iot';

/** 与后端 `AlertRules.QUALITY_GOOD` 对齐。 */
export const RULE_PREVIEW_QUALITY_GOOD = 'GOOD';

/** 单次试算最多参与判定的样本数（与后端 `TimeSeriesQueryReq.MAX_LIMIT` 对齐）。 */
export const RULE_PREVIEW_MAX_SERIES_LIMIT = 5000;

export type PreviewOperator = 'EQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'NE';

/** 规则里的一个点位条件（字段与后端 `IotAlertRulePoint` 同名）。 */
export interface RulePreviewCondition {
  deadband?: null | number | string;
  operator?: null | string;
  propertyId?: null | string;
  threshold?: null | number | string;
  valueType?: null | string;
}

/** 试算输入：条件 + 历史样本 + 时间窗/上限。 */
export interface RulePreviewInput {
  conditions: RulePreviewCondition[];
  from?: number;
  limit?: number;
  points: IotSeriesApi.TimeSeriesPointResp[];
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

export type RulePreviewUnsupportedReason =
  | 'empty-conditions'
  | 'invalid-condition';

export interface RulePreviewResult {
  conditions: RulePreviewConditionView[];
  firstTriggerTs: null | number;
  kind: 'ok' | 'unsupported';
  lastTriggerTs: null | number;
  matchedCount: number;
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

function unsupportedResult(
  reason: RulePreviewUnsupportedReason,
): RulePreviewResult {
  return {
    conditions: [],
    firstTriggerTs: null,
    kind: 'unsupported',
    lastTriggerTs: null,
    matchedCount: 0,
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

/** 对一个点的原始值判定：返回 `true`=命中 / `false`=明确未命中 / `null`=不可判定。 */
function evaluateSample(
  value: null | string,
  quality: null | string | undefined,
  views: RulePreviewConditionView[],
): boolean | null {
  if (
    typeof quality !== 'string' ||
    quality.trim().toUpperCase() !== RULE_PREVIEW_QUALITY_GOOD
  ) {
    return null;
  }
  let matched = true;
  for (const view of views) {
    const parsed = parseByType(value, view.valueType);
    if (parsed === null) {
      // 任一条件不可解析 ⇒ 整条规则本轮不可判定（同后端 NON_NUMERIC）
      return null;
    }
    if (!conditionHolds(view.operator, view.threshold, parsed)) {
      matched = false;
      break;
    }
  }
  return matched;
}

/**
 * 试算：对窗口内样本逐点判定，输出命中样本 / 触发段数 / 首末命中时间。
 *
 * 时间轴按真实 `ts` 升序；结果保留最近 `limit` 条（限流裁剪）；
 * 不可判定样本计入 `skippedSamples`，且**不打断**连续命中段。
 */
export function evaluateRulePreview(
  input: RulePreviewInput,
): RulePreviewResult {
  const conditions = input.conditions ?? [];
  const points = input.points ?? [];
  if (conditions.length === 0) {
    return unsupportedResult('empty-conditions');
  }
  const views = toPreviewConditionViews(conditions);
  if (!views) {
    return unsupportedResult('invalid-condition');
  }

  const limit = normalizeLimit(input.limit);
  const { from, to } = input;
  let outsideWindowSamples = 0;
  let skippedSamples = 0;
  const usable: { point: IotSeriesApi.TimeSeriesPointResp; ts: number }[] = [];

  for (const point of points) {
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
  usable.sort((a, b) => a.ts - b.ts);

  const windowed =
    limit === null ? usable : usable.slice(Math.max(0, usable.length - limit));
  const truncatedSamples = usable.length - windowed.length;

  const samples: RulePreviewSample[] = [];
  let matchedCount = 0;
  let triggerCount = 0;
  let inRun = false;
  let firstTriggerTs: null | number = null;
  let lastTriggerTs: null | number = null;

  for (const item of windowed) {
    const matched = evaluateSample(item.point.value, item.point.quality, views);
    if (matched === null) {
      // 不可判定：不计命中/未命中，也不打断连续段（同后端“计数保持不变”）
      skippedSamples += 1;
      continue;
    }
    samples.push({ matched, ts: item.ts, value: item.point.value ?? '' });
    if (matched) {
      matchedCount += 1;
      if (!inRun) {
        triggerCount += 1;
        inRun = true;
        if (firstTriggerTs === null) {
          firstTriggerTs = item.ts;
        }
      }
      lastTriggerTs = item.ts;
    } else {
      inRun = false;
    }
  }

  return {
    conditions: views,
    firstTriggerTs,
    kind: 'ok',
    lastTriggerTs,
    matchedCount,
    outsideWindowSamples,
    samples,
    skippedSamples,
    totalSamples: points.length,
    triggerCount,
    truncatedSamples,
    usedSamples: samples.length,
  };
}

/** 时间窗选项 → 毫秒（供 rule-form 试算区使用）。 */
export const RULE_PREVIEW_WINDOWS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
} as const;

export type RulePreviewWindowKey = keyof typeof RULE_PREVIEW_WINDOWS;
