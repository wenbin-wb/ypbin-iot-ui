import type { RuleSummary, SummaryArg } from './summary';

import { buildRuleSummary } from './summary';

/**
 * 多行点位条件的人话摘要（纯逻辑，可单测）。
 *
 * ## 三条不可动摇的口径
 *
 * 1. **与保存请求同源**：摘要只读同一份条件行数组（`toConditionRequests(rows)` 的输入），
 *    不做任何二次解析或默认值补充；
 * 2. **不宣称 AND**：引擎对每个点位条件**各自独立判定、各自产生告警实例**
 *    （见 `condition-rows.ts` 模块头注释的证据）。因此多行摘要只陈述「N 条条件、各自独立判定」，
 *    **禁止**出现「且 / AND / 同时满足」；
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
 * @returns 单行时等价于 `buildRuleSummary`；多行时给出「N 条条件各自独立判定」句式
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

  // ⑤ 多条件：如实陈述「N 条条件、逐条独立判定」（**不是 AND**）
  const conditionClauses = rows.map((row) => ({
    args: [
      row.propertyLabel ?? '',
      row.operator ?? '',
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
    'page.iot.alert.rule.condition.expectPerPoint',
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
