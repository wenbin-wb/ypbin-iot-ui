import type { IotAlertApi } from '#/api/iot';

/**
 * 「人话预览」的**纯逻辑**（用户口径 ②：填写时实时显示一句话总结，并在保存前给出「这样配会发生什么」）。
 *
 * 为什么把它抽成不依赖 Vue 的纯函数：
 * 1. 它是「傻瓜式」的核心——选哪一句句式、什么时候说「还差一个数字」、有哪些注意事项，都必须能被
 *    用例逐条钉住，而不是埋在模板里靠肉眼检查；
 * 2. 文案全部走 **i18n 键 + 参数**，本模块不出现任何中文/英文句子 —— zh/en 两份语言包由既有门禁
 *    （键存在性 + 文案编译）统一守，包括「裸 `{`/`}` 让 vue-i18n 渲染期抛 SyntaxError」那条事故的防线。
 *
 * ⚠️ 参数里如果出现**另一个 i18n 键**（例如单位「分钟/秒」），一律用 {@link argKey} 包一层，
 * 由 {@link resolveArgs} 在渲染前翻译。直接把键当字符串塞进句子会渲染出 `page.iot.alert.unit.minute`
 * 这种原始键——那是「看起来像配置项泄漏」的典型事故。
 */
export interface RuleSummaryInput {
  /** 作用域码。 */
  scopeType: string;
  /** 设备展示名（设备级/点位级必填）。 */
  deviceLabel?: string;
  /** 产品展示名（产品级/点位级必填）。 */
  productLabel?: string;
  /** 点位展示名（**前端从物模型取**：属性名，取不到就退化成标识）。 */
  propertyLabel?: string;
  /** 单位（物模型里有就用，没有就空）。 */
  unit?: string;
  operator?: string;
  threshold?: number | string;
  valueType?: string;
  triggerMode?: string;
  triggerThreshold?: number | string | null;
  repeatIntervalSec?: number | string | null;
  severity?: string;
  channels?: string;
  notifyTargets?: string;
  enabled?: boolean;
}

/** 句子参数：字面量，或「另一个需要翻译的 i18n 键」。 */
export type SummaryArg = number | string | { key: string };

/** 把 i18n 键包成参数（渲染前由 `resolveArgs` 翻译）。 */
export function argKey(key: string): { key: string } {
  return { key };
}

/** 渲染前把「键参数」翻译成文案（`t` 即 `$t`）。 */
export function resolveArgs(
  args: SummaryArg[],
  t: (key: string) => string,
): (number | string)[] {
  return args.map((item) =>
    typeof item === 'object' && item !== null ? t(item.key) : item,
  );
}

export interface SummaryWarning {
  /** i18n 键。 */
  key: string;
  /** 模板参数。 */
  args?: SummaryArg[];
}

export interface RuleSummary {
  /** 一句话总结的 i18n 键。 */
  sentenceKey: string;
  /** 模板参数（顺序即 `{0}`、`{1}`… 的顺序）。 */
  sentenceArgs: SummaryArg[];
  /** 配置是否已完整到可以保存（不完整时 `sentenceKey` 指向「还差什么」）。 */
  ready: boolean;
  /** 「这样配会发生什么」（随模式变化的固定几条）。 */
  expectations: string[];
  /** 需要注意/修正的点（人话；后端返回的 message 也走同一条展示链路）。 */
  warnings: SummaryWarning[];
}

/** 操作符码 → 数学符号（后端契约是码，展示时才转符号；这里是唯一的转换点）。 */
const OPERATOR_SYMBOLS: Record<string, string> = {
  EQ: '=',
  GT: '>',
  GTE: '>=',
  LT: '<',
  LTE: '<=',
  NE: '!=',
};

/** 操作符显示（未知码原样返回，不静默变成别的符号）。 */
export function operatorSymbol(operator?: string): string {
  if (!operator) {
    return '';
  }
  return OPERATOR_SYMBOLS[operator] ?? operator;
}

/** 重复通知间隔 → 数值（秒转分钟；不足一分钟按秒显示，避免「0.5 分钟」这种反直觉表达）。 */
export function repeatIntervalText(seconds?: number | string | null): string {
  const value = Number(seconds ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value < 60) {
    return String(Math.round(value));
  }
  const minutes = value / 60;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
}

/** 重复通知间隔的单位键（与 {@link repeatIntervalText} 配对）。 */
export function repeatIntervalUnitKey(
  seconds?: number | string | null,
): string {
  const value = Number(seconds ?? 0);
  return value > 0 && value < 60
    ? 'page.iot.alert.unit.second'
    : 'page.iot.alert.unit.minute';
}

/** 阈值是否是一个合法数字（前端即时校验：**不弹原始码**，只给「必须是数字」的人话）。 */
export function isNumericText(value?: number | string): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  const text = String(value).trim();
  if (text === '') {
    return false;
  }
  return Number.isFinite(Number(text));
}

/** 阈值 + 单位（单位为空时不追加空格）。 */
export function thresholdText(
  threshold: number | string | undefined,
  unit?: string,
): string {
  const base =
    threshold === undefined || threshold === null ? '' : String(threshold);
  return unit ? `${base} ${unit}` : base;
}

/** 渠道码集合（`INBOX,EMAIL` → `['INBOX','EMAIL']`）。 */
export function channelCodes(channels?: string): string[] {
  if (!channels) {
    return [];
  }
  return channels
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 组装「人话预览」。
 *
 * 判据（与 `summary.test.ts` 一一对应）：
 * - 点位类（有阈值）⇒ 「点位 连续 N 次 > 阈值 就告警，X 分钟内不重复通知」；
 * - 持续类 ⇒ 「点位 持续 T 秒 > 阈值 就告警…」，并额外说明「需要时序库可查」；
 * - 断档类（无阈值）⇒ 「设备/产品/租户 数据中断就告警…」，并说明「判定复用平台断档链路，不另设阈值」；
 * - 缺设备/缺点位/阈值不是数字/没配渠道 ⇒ `ready=false`，句子变成「还差什么」并给出对应提示。
 */
export function buildRuleSummary(input: RuleSummaryInput): RuleSummary {
  const warnings: SummaryWarning[] = [];
  const expectations: string[] = ['page.iot.alert.expect.evaluateEvery15s'];
  const mode = input.triggerMode ?? 'CONSECUTIVE_COUNT';
  const pointLike = Boolean(input.operator);

  // ① 阻断性缺口（决定句子是「描述」还是「还差什么」）
  if (input.scopeType === 'DEVICE' && !input.deviceLabel) {
    return incomplete('page.iot.alert.summary.needDevice', [
      { key: 'page.iot.alert.warn.needDevice' },
    ]);
  }
  if (input.scopeType === 'PRODUCT' && !input.productLabel) {
    return incomplete('page.iot.alert.summary.needProduct', [
      { key: 'page.iot.alert.warn.needProduct' },
    ]);
  }
  if (input.scopeType === 'POINT' && !input.deviceLabel) {
    return incomplete('page.iot.alert.summary.needDevice', [
      { key: 'page.iot.alert.warn.needDevice' },
    ]);
  }
  if (pointLike && !input.propertyLabel) {
    return incomplete('page.iot.alert.summary.needPoint', [
      { key: 'page.iot.alert.warn.needPoint' },
    ]);
  }
  if (
    pointLike &&
    input.valueType !== 'BOOLEAN' &&
    !isNumericText(input.threshold)
  ) {
    return incomplete('page.iot.alert.summary.needNumber', [
      { key: 'page.iot.alert.warn.thresholdNotNumber' },
    ]);
  }
  if (channelCodes(input.channels).length === 0) {
    return incomplete('page.iot.alert.summary.needChannel', [
      { key: 'page.iot.alert.warn.needChannel' },
    ]);
  }

  // ② 非阻断性提醒（照常给句子，但把风险说清楚）
  if (mode === 'DURATION' && Number(input.triggerThreshold ?? 0) < 60) {
    warnings.push({ key: 'page.iot.alert.warn.durationShort' });
  }
  if (
    input.valueType === 'BOOLEAN' &&
    !['EQ', 'NE'].includes(input.operator ?? '')
  ) {
    warnings.push({ key: 'page.iot.alert.warn.booleanOperator' });
  }
  if (!input.notifyTargets) {
    warnings.push({ key: 'page.iot.alert.warn.noTargets' });
  }
  if (input.enabled === false) {
    warnings.push({ key: 'page.iot.alert.warn.disabled' });
  }

  const repeat = repeatIntervalText(input.repeatIntervalSec);
  const repeatUnit = argKey(repeatIntervalUnitKey(input.repeatIntervalSec));

  if (!pointLike) {
    // 断档类：判定复用既有 outage_event + OutageScanner（**不新造判定**）
    expectations.push('page.iot.alert.expect.offlineReuseOutage');
    expectations.push('page.iot.alert.expect.offlineNoThreshold');
    if (input.scopeType === 'PRODUCT') {
      return {
        ready: true,
        sentenceKey: 'page.iot.alert.summary.offlineProduct',
        sentenceArgs: [input.productLabel ?? '', repeat, repeatUnit],
        expectations,
        warnings,
      };
    }
    if (input.scopeType === 'TENANT') {
      return {
        ready: true,
        sentenceKey: 'page.iot.alert.summary.offlineTenant',
        sentenceArgs: [repeat, repeatUnit],
        expectations,
        warnings,
      };
    }
    return {
      ready: true,
      sentenceKey: 'page.iot.alert.summary.offlineDevice',
      sentenceArgs: [input.deviceLabel ?? '', repeat, repeatUnit],
      expectations,
      warnings,
    };
  }

  const symbol = operatorSymbol(input.operator);
  const target = thresholdText(input.threshold, input.unit);
  expectations.push('page.iot.alert.expect.restoreByCondition');
  expectations.push('page.iot.alert.expect.ackStopsRepeat');
  if (mode === 'DURATION') {
    expectations.push('page.iot.alert.expect.durationNeedsSeries');
    return {
      ready: true,
      sentenceKey: 'page.iot.alert.summary.pointDuration',
      sentenceArgs: [
        input.propertyLabel ?? '',
        Number(input.triggerThreshold ?? 0),
        symbol,
        target,
        repeat,
        repeatUnit,
      ],
      expectations,
      warnings,
    };
  }
  if (mode === 'IMMEDIATE') {
    expectations.push('page.iot.alert.expect.countNoSeries');
    return {
      ready: true,
      sentenceKey: 'page.iot.alert.summary.pointImmediate',
      sentenceArgs: [
        input.propertyLabel ?? '',
        symbol,
        target,
        repeat,
        repeatUnit,
      ],
      expectations,
      warnings,
    };
  }
  expectations.push('page.iot.alert.expect.countNoSeries');
  return {
    ready: true,
    sentenceKey: 'page.iot.alert.summary.pointCount',
    sentenceArgs: [
      input.propertyLabel ?? '',
      Number(input.triggerThreshold ?? 0),
      symbol,
      target,
      repeat,
      repeatUnit,
    ],
    expectations,
    warnings,
  };
}

/** 「还差什么」的统一返回（保证句子永远不为空——空句子会让用户不知道下一步做什么）。 */
function incomplete(
  sentenceKey: string,
  warnings: SummaryWarning[],
): RuleSummary {
  return {
    ready: false,
    sentenceKey,
    sentenceArgs: [],
    expectations: ['page.iot.alert.expect.evaluateEvery15s'],
    warnings,
  };
}

/** 规则是否断档类（无点位条件）。 */
export function isOfflineRule(rule: IotAlertApi.RuleResp): boolean {
  return !rule.points || rule.points.length === 0;
}
