import type { RuleSummary, SummaryArg } from './summary';

import { buildRuleSummary, operatorSymbol } from './summary';

/**
 * 多行点位条件的人话摘要（纯逻辑，可单测）。
 *
 * ## 三条不可动摇的口径
 *
 * 1. **与保存请求同源**：摘要只读同一份条件行数组（`toConditionRequests(rows)` 的输入），
 *    不做任何二次解析或默认值补充；
 * 2. **必须如实宣称 AND**：一条规则的多条点位条件是**同一设备上的合取条件组**
 *    （真 AND，2026-10-15 起；证据见 `condition-rows.ts` 模块头注释）。因此多行摘要必须说清
 *    「组内**全部**条件同时满足才告警」，并由 {@link CONDITION_CLAUSE_JOIN_KEY} 把各行连成
 *    「A 且 B 且 C」；**禁止**出现「各自独立判定 / 满足任一条即告警」这类旧口径（那会让用户按
 *    错误语义配规则——把 OR 当 AND 或反之，都会造成漏报或误报）；
 * 3. **单行时行为与改造前逐字一致**：单条件规则直接委托 {@link buildRuleSummary}，
 *    既有的句式和参数顺序（含 `summary.test.ts` 钉住的那些）保持不变。
 *
 * ## 为什么把「行级问题」也纳进来
 *
 * 校验在 `condition-rows.validateConditionRows` 已做（与后端 `buildPoint` 同口径），
 * 但用户需要看到的是**同一处**的「还差什么」。把首个问题行原样搬进摘要，可以让
 * 「预览即唯一失败提示」这条既有设计继续成立（不再出现「按钮灰着但不知道缺什么」）。
 */
export interface ConditionSummaryRow {
  /** 行级问题：i18n 键 + 参数（由 validateConditionRows 产生；无问题为 undefined）。 */
  issueArgs?: (number | string)[];
  issueKey?: string;
  propertyLabel?: string;
  operator?: string;
  /** 阈值（字符串形态，与保存请求同一个值）。 */
  threshold?: number | string;
  unit?: string;
  valueType?: string;
}

export interface ConditionsSummaryInput {
  channels?: string;
  deviceLabel?: string;
  enabled?: boolean;
  notifyTargets?: string;
  productLabel?: string;
  repeatIntervalSec?: null | number | string;
  rows: ConditionSummaryRow[];
  scopeType: string;
  severity?: string;
  triggerMode?: string;
  triggerThreshold?: null | number | string;
}

/**
 * 多条件行的**连接词** i18n 键（与 {@link ConditionsSummaryInput} 的 `conditionClauses` 配对）。
 *
 * 单独导出而不是写死在模板里：调用方（rule-form）与用例都要用同一个键把「A 且 B 且 C」拼出来，
 * 写死两处就会在改文案时漏掉一处（zh/en 口径漂移的经典来源）。
 */
export const CONDITION_CLAUSE_JOIN_KEY =
  'page.iot.alert.rule.condition.clauseJoin';

/** 「还差什么」的统一返回（句子永远非空：空句子会让用户不知道下一步做什么）。 */
function blocked(
  sentenceKey: string,
  sentenceArgs: SummaryArg[],
  warnings: { args?: SummaryArg[]; key: string }[],
): RuleSummary {
  return {
    expectations: ['page.iot.alert.expect.evaluateEvery15s'],
    ready: false,
    sentenceArgs,
    sentenceKey,
    warnings,
  };
}

/**
 * 组装多行条件摘要。
 *
 * @param input 条件行（含行级问题）+ 规则级字段
 * @returns 单行时等价于 `buildRuleSummary`；多行时给出「N 条条件全部满足才告警」句式 +
 *          `conditionClauses`（调用方按 {@link CONDITION_CLAUSE_JOIN_KEY} 连成「A 且 B 且 C」）
 */
export function buildConditionsSummary(
  input: ConditionsSummaryInput,
): RuleSummary {
  const rows = input.rows ?? [];

  // ① 作用域 / 渠道这类与条件行无关的阻断：委托既有实现，保证判据只有一处来源。
  // 传 `operator: undefined` 让它走「断档类」分支——它的作用域与渠道校验仍在最前面生效，
  // 命中时直接返回既有的 needDevice / needProduct / needChannel 句式。
  const scopeGuard = buildRuleSummary({
    channels: input.channels,
    deviceLabel: input.deviceLabel,
    enabled: input.enabled,
    notifyTargets: input.notifyTargets,
    productLabel: input.productLabel,
    repeatIntervalSec: input.repeatIntervalSec,
    scopeType: input.scopeType,
    severity: input.severity,
    triggerMode: input.triggerMode,
    triggerThreshold: input.triggerThreshold,
  });
  if (!scopeGuard.ready) {
    return scopeGuard;
  }

  // ② 无条件的规则（断档/离线类）：既有句式原样返回
  if (rows.length === 0) {
    if (input.scopeType === 'POINT') {
      // 后端 validate()：点位级规则必须至少一个点位条件（否则会按「断档类」静默落成另一种规则）
      return blocked(
        'page.iot.alert.rule.condition.needOne',
        [],
        [{ key: 'page.iot.alert.rule.condition.needOne' }],
      );
    }
    return scopeGuard;
  }

  // ③ 任一行有问题 ⇒ 摘要变成「还差什么」（预览即唯一失败提示）
  const invalid = rows.find((row) => Boolean(row.issueKey));
  if (invalid?.issueKey) {
    return blocked(invalid.issueKey, invalid.issueArgs ?? [], [
      { args: invalid.issueArgs, key: invalid.issueKey },
    ]);
  }

  // ④ 单条件：与改造前**逐字一致**（委托既有实现，避免句式/参数顺序漂移）
  const [baseRow] = rows;
  if (baseRow && rows.length === 1) {
    return buildRuleSummary({
      channels: input.channels,
      deviceLabel: input.deviceLabel,
      enabled: input.enabled,
      notifyTargets: input.notifyTargets,
      operator: baseRow.operator,
      productLabel: input.productLabel,
      propertyLabel: baseRow.propertyLabel,
      repeatIntervalSec: input.repeatIntervalSec,
      scopeType: input.scopeType,
      severity: input.severity,
      threshold: baseRow.threshold,
      triggerMode: input.triggerMode,
      triggerThreshold: input.triggerThreshold,
      unit: baseRow.unit,
      valueType: baseRow.valueType,
    });
  }

  // ⑤ 多条件：如实陈述「组内全部条件同时满足才告警」（真 AND，2026-10-15 起）
  const conditionClauses = rows.map((row) => ({
    args: [
      row.propertyLabel ?? '',
      // 与单条件句子（buildRuleSummary）用同一个操作符显示函数：'GT' 是契约码，不是人话
      operatorSymbol(row.operator),
      row.threshold ?? '',
    ] as SummaryArg[],
    key: 'page.iot.alert.rule.condition.clause',
  }));
  // ⚠️ **不能**直接继承 scopeGuard.expectations：上面那次委托为了让作用域/渠道校验生效，
  // 是按「断档类」调用的，它的 expectations 里有 offlineReuseOutage / offlineNoThreshold ——
  // 对多条件阈值规则是**误导**（这条规则并不走断档链路）。故此处按真实形态重建。
  const warnings = scopeGuard.warnings;
  const expectations = [
    'page.iot.alert.expect.evaluateEvery15s',
    'page.iot.alert.expect.restoreByCondition',
    'page.iot.alert.expect.ackStopsRepeat',
    input.triggerMode === 'DURATION'
      ? 'page.iot.alert.expect.durationNeedsSeries'
      : 'page.iot.alert.expect.countNoSeries',
    'page.iot.alert.rule.condition.expectAllMustHold',
  ];
  return {
    conditionClauses,
    expectations,
    ready: true,
    sentenceArgs: [
      rows.length,
      Number(input.triggerThreshold ?? 0),
      input.repeatIntervalSec ?? 0,
    ],
    sentenceKey: 'page.iot.alert.rule.condition.summaryMultiple',
    warnings,
  };
}
