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
 * ## ⚠️ 多条件 = **逐条件独立判定**（引擎真实语义，**不是 AND**）
 *
 * 输入的 `conditions` 即使有多条，本模块**单条**调用的语义仍是「一个点位、一条条件」。
 * 后端候选是「规则 × 单个点位条件 × 设备」（`AlertCandidateResolver` 逐条件建 Candidate，
 * `AlertTenantEvaluator` 逐候选独立判定），每条条件**各自产生告警实例**；
 * 去重键 `AlertRules.dedupKey(ruleId, deviceId, propertyId)` 不含条件行身份。
 * 因此 {@link evaluateRulePreview} 把多条条件合并成一个值序列去判定的用法**只对「同一点位的多条件」**
 * 有意义，且**不代表引擎行为**；规则表单的多条件试算一律走
 * {@link evaluateRulePreviewPerCondition}（逐行、逐点位，与引擎一致）。
 * 任何 UI 文案都**不得**把多条件描述成「且 / AND / 同时满足」。
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

/**
 * 对一个点的原始值判定：返回 `true`=命中 / `false`=明确未命中 / `null`=不可判定。
 *
 * `views` **必须只有一条**（一个点位、一条条件）——与引擎的候选粒度一致。
 * 传多条会被当成「同一点位的多条件合并判定」，那**不对应任何线上行为**，
 * 仅供 {@link evaluateRulePreview} 的兼容路径使用；规则表单不得走这条路径。
 */
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

/**
 * 一条条件的试算结果（逐条件试算的输出单元）。
 *
 * `propertyId` 是**条件自己的点位**（引擎按候选的点位取值，不是外部代入的试算点位）。
 */
export interface RulePreviewConditionEvaluation {
  /** 原始条件在列表中的序号（0 起；用于与表单行一一对应）。 */
  index: number;
  /** 该条件的原点位标识。 */
  propertyId: string;
  /** 归一化后的条件视图（非法时为 `null`）。 */
  view: null | RulePreviewConditionView;
  /** 单条件判定结果（空条件行/非法条件/缺序列时为 unsupported）。 */
  result: RulePreviewResult;
}

/**
 * 逐条件试算（**与引擎逐条件独立判定同口径**）。
 *
 * 后端对一条规则的每个点位条件**各自建立候选、各自判定、各自产生告警实例**
 * （`AlertCandidateResolver` 逐条件建 Candidate），因此试算也必须**逐行、按该行的点位**
 * 判历史序列，而**不能**把多行合并成一个判定（合并是「同一点位的 AND」，不对应任何线上行为）。
 *
 * `seriesByPropertyId`：行点位 → 已加载的历史样本。表单对每个**有合法点位**的行各查一次
 * （两个行共用同一点位时只查一次，由调用方复用结果），缺失即该行 `unsupported`
 * （**不伪造 0 命中**：没有序列 ≠ 都没命中）。
 *
 * @param conditions 条件行（字段与后端 `AlertRulePointResp` 同名）
 * @param seriesByPropertyId 行点位 → 历史样本
 * @param options `limit` 参与判定的样本上限；其余字段透传给单条件试算
 */
export function evaluateRulePreviewPerCondition(
  conditions: RulePreviewCondition[],
  seriesByPropertyId: Record<string, IotSeriesApi.TimeSeriesPointResp[]>,
  options: { from?: number; limit?: number; to?: number } = {},
): RulePreviewConditionEvaluation[] {
  return (conditions ?? []).map((condition, index) => {
    const propertyId = (condition.propertyId ?? '').trim();
    const views = toPreviewConditionViews([condition]);
    const view = views?.[0] ?? null;
    const points =
      propertyId === '' ? undefined : seriesByPropertyId[propertyId];
    if (!view || !points) {
      return {
        index,
        propertyId,
        result: evaluateRulePreview({
          conditions: points ? [condition] : [],
          from: options.from,
          limit: options.limit,
          points: [],
          to: options.to,
        }),
        view,
      };
    }
    return {
      index,
      propertyId,
      result: evaluateRulePreview({
        // 单条件：与引擎的候选粒度一致
        conditions: [condition],
        from: options.from,
        limit: options.limit,
        points,
        to: options.to,
      }),
      view,
    };
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
