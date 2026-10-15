import type { RuleSummary } from './summary';

import { createApp } from 'vue';

import { beforeAll, describe, expect, it } from 'vitest';

import { $t } from '#/locales';
import enUsPage from '#/locales/langs/en-US/page.json';

import {
  buildConditionsSummary,
  CONDITION_CLAUSE_JOIN_KEY,
} from './condition-summary';
import { argKey, resolveArgs } from './summary';

/**
 * 从**已提交语言包**读取一条文案（CI 里没有仓外的 temp/ 请求文件，禁止依赖它）。
 *
 * 与 $t 的分工：zh-CN 走真实 i18n 实例（顺带证明能编译）；en-US 这里直接读语言包，
 * 免去在用例里切换全局 locale（会污染其它用例的运行期状态）。
 */
function readLocaleMessage(_locale: 'en-US', dotted: string): string {
  const parts = dotted.split('.');
  // page.json 是 `page` 命名空间 ⇒ 丢掉首个 `page` 段
  let node: unknown = enUsPage;
  for (const part of parts.slice(1)) {
    if (typeof node !== 'object' || node === null) {
      return '';
    }
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : '';
}

/**
 * 真实 i18n 实例：只初始化一次（`$t` 即 i18n.global.t）。
 *
 * **绝不 mock `#/locales`**：mock 掉它会结构性地漏掉「文案编译不过 ⇒ 整块渲染成空白」
 * 这类事故（SYNC.md 记载过一次线上实例）。这里用真实语言包初始化，断言的就是随包发布的文案。
 */
beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

/**
 * 多条件摘要用例（task-4 建，task-7 按真 AND 语义**翻转**）。
 *
 * 两条硬纪律：
 * 1. **必须宣称 AND**：一条规则的多条件构成同一设备上的合取条件组
 *    （后端 `AlertTenantEvaluator#evaluateGroup`：组内全部条件同时越界才触发）。
 *    摘要不写明 AND，用户就会按 OR 配规则——把 AND 当 OR 会漏报、把 OR 当 AND 会误报。
 * 2. **单行行为逐字不变**：单条件规则必须与改造前 `buildRuleSummary` 完全一致
 *    （句式、参数顺序、warnings），否则会把既有页面文案改坏。
 */

/** 条件行摘要输入（模拟 rule-form 里 conditionRows → summary rows 的映射）。 */
function row(init: {
  issueArgs?: (number | string)[];
  issueKey?: string;
  operator?: string;
  propertyLabel?: string;
  threshold?: number | string;
  unit?: string;
  valueType?: string;
}) {
  return {
    operator: 'GT',
    propertyLabel: '温度',
    threshold: '80',
    unit: '℃',
    valueType: 'NUMERIC',
    ...init,
  };
}

const base = {
  channels: 'INBOX,EMAIL',
  deviceLabel: '演示设备',
  notifyTargets: '1001,ops@example.com',
  productLabel: '演示产品',
  repeatIntervalSec: 1800,
  scopeType: 'POINT',
  triggerMode: 'CONSECUTIVE_COUNT',
  triggerThreshold: 3,
};

describe('buildConditionsSummary：单条件与改造前逐字一致', () => {
  it('单行 ⇒ 委托 buildRuleSummary 的既有句式与参数顺序', () => {
    const summary = buildConditionsSummary({ ...base, rows: [row({})] });
    expect(summary.ready).toBe(true);
    expect(summary.sentenceKey).toBe('page.iot.alert.summary.pointCount');
    expect(summary.sentenceArgs).toEqual([
      '温度',
      3,
      '>',
      '80 ℃',
      '30',
      argKey('page.iot.alert.unit.minute'),
    ]);
    // 单行不给逐条陈述（避免与主句重复）
    expect(summary.conditionClauses).toBeUndefined();
  });

  it('单行布尔点位同样保留「开启/关闭」的键参数写法', () => {
    const summary = buildConditionsSummary({
      ...base,
      rows: [
        row({
          operator: 'EQ',
          propertyLabel: '开关',
          threshold: '1',
          unit: undefined,
          valueType: 'BOOLEAN',
        }),
      ],
    });
    expect(summary.sentenceArgs[3]).toEqual(
      argKey('page.iot.alert.boolean.true'),
    );
  });

  it('无条件的断档类 ⇒ 既有 offline 句式（不因改造而变）', () => {
    const device = buildConditionsSummary({
      ...base,
      rows: [],
      scopeType: 'DEVICE',
    });
    expect(device.sentenceKey).toBe('page.iot.alert.summary.offlineDevice');
    expect(device.ready).toBe(true);
  });

  it('缺渠道/缺设备等阻断仍来自既有实现（同一份判据）', () => {
    expect(
      buildConditionsSummary({ ...base, channels: '', rows: [row({})] })
        .sentenceKey,
    ).toBe('page.iot.alert.summary.needChannel');
    expect(
      buildConditionsSummary({ ...base, deviceLabel: '', rows: [row({})] })
        .sentenceKey,
    ).toBe('page.iot.alert.summary.needDevice');
  });
});

describe('buildConditionsSummary：多条件如实陈述「全部满足才告警」', () => {
  it('🔴 多行句子带「全部满足」口径 + 组级说明，且逐条列出条件', () => {
    const summary = buildConditionsSummary({
      ...base,
      rows: [
        row({}),
        row({
          operator: 'LT',
          propertyLabel: '湿度',
          threshold: '10',
          unit: '%',
        }),
      ],
    });
    expect(summary.ready).toBe(true);
    expect(summary.sentenceKey).toBe(
      'page.iot.alert.rule.condition.summaryMultiple',
    );
    expect(summary.expectations).toContain(
      'page.iot.alert.rule.condition.expectAllMustHold',
    );
    // 多条件阈值规则**不得**继承「断档类」的 expectations（那会误导用户以为走断档链路）
    expect(summary.expectations).not.toContain(
      'page.iot.alert.expect.offlineReuseOutage',
    );
    expect(summary.expectations).not.toContain(
      'page.iot.alert.expect.offlineNoThreshold',
    );
    expect(summary.expectations).toContain(
      'page.iot.alert.expect.restoreByCondition',
    );
    // 参数：条数、连续次数、重复间隔数值
    expect(summary.sentenceArgs).toEqual([2, 3, 1800]);
    // 逐条陈述：每行一句「点位 比较符 阈值」；比较符必须是**人话符号**（与单条件句子同一函数）
    expect(summary.conditionClauses).toHaveLength(2);
    expect(summary.conditionClauses?.[0]).toEqual({
      args: ['温度', '>', '80'],
      key: 'page.iot.alert.rule.condition.clause',
    });
    expect(summary.conditionClauses?.[1]?.args).toEqual(['湿度', '<', '10']);
  });

  it('🔴 三行时逐条数量与顺序与条件行一致（不得静默丢行）', () => {
    const summary = buildConditionsSummary({
      ...base,
      rows: [
        row({ propertyLabel: 'A' }),
        row({ propertyLabel: 'B' }),
        row({ propertyLabel: 'C' }),
      ],
    });
    expect(summary.conditionClauses?.map((clause) => clause.args[0])).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('任一行有问题 ⇒ 摘要变成「还差什么」并带行号（预览即唯一失败提示）', () => {
    const summary = buildConditionsSummary({
      ...base,
      rows: [
        row({}),
        row({
          issueArgs: [2],
          issueKey: 'page.iot.alert.rule.condition.thresholdNotNumber',
        }),
      ],
    });
    expect(summary.ready).toBe(false);
    expect(summary.sentenceKey).toBe(
      'page.iot.alert.rule.condition.thresholdNotNumber',
    );
    expect(summary.sentenceArgs).toEqual([2]);
    expect(summary.warnings[0]).toEqual({
      args: [2],
      key: 'page.iot.alert.rule.condition.thresholdNotNumber',
    });
  });

  it('点位级 0 行 ⇒ 明确「至少一个条件」，不静默变成断档类', () => {
    const summary = buildConditionsSummary({ ...base, rows: [] });
    expect(summary.ready).toBe(false);
    expect(summary.sentenceKey).toBe('page.iot.alert.rule.condition.needOne');
  });

  it('空句子绝不允许：任何输入下 sentenceKey 都非空', () => {
    const cases: RuleSummary[] = [
      buildConditionsSummary({ ...base, rows: [] }),
      buildConditionsSummary({ ...base, channels: '', rows: [row({})] }),
      buildConditionsSummary({
        ...base,
        rows: [
          row({}),
          row({ issueKey: 'page.iot.alert.rule.condition.needProperty' }),
        ],
      }),
    ];
    for (const item of cases) {
      expect(item.sentenceKey).not.toBe('');
    }
  });
});

describe('condition 文案语义守门（真 AND 口径）', () => {
  it('🔴 多条件文案**必须**体现「全部满足 / AND」，且**不得**再出现旧逐条件措辞', () => {
    // 🔴 文案的事实源是**已提交进本仓**的 page.json（zh-CN/en-US 两个语言包），
    // 不是仓外的 temp/i18n-requests-*.json —— 那只是合并前的请求文件，CI 检出里并不存在
    // （曾因此把「校验与构建」打红：ENOENT temp/…）。用**真实 i18n 实例**取文案，
    // 既能守住语义，又顺带证明这条文案在运行期能编译出来。
    const multiple = $t('page.iot.alert.rule.condition.summaryMultiple', [
      2,
      3,
      '30 分钟',
    ]);
    const hint = $t('page.iot.alert.rule.condition.perPointHint');
    const clauseJoin = $t(CONDITION_CLAUSE_JOIN_KEY);
    // ① 新口径必须在场（缺了就等于把真 AND 说成 OR ⇒ 用户按错误语义配规则）
    expect(multiple).toContain('全部满足');
    expect(hint).toContain('全部条件');
    expect(hint).toContain('AND');
    for (const text of [multiple, hint]) {
      expect(text).not.toMatch(/各自独立|独立判定|逐个独立/);
      expect(text).not.toMatch(/满足任一条/);
      expect(text).not.toMatch(/不是 ?AND|不是「必须同时满足」/);
    }
    // ② 连接词必须是「且」（多行摘要据此拼成「A 且 B 且 C」）
    expect(clauseJoin).toContain('且');
    // en-US：直接从**已提交的语言包**读（CI 无仓外请求文件），保证断言的是随包发布的真实文案。
    const enHint = readLocaleMessage(
      'en-US',
      'page.iot.alert.rule.condition.perPointHint',
    );
    const enMultiple = readLocaleMessage(
      'en-US',
      'page.iot.alert.rule.condition.summaryMultiple',
    );
    const enJoin = readLocaleMessage('en-US', CONDITION_CLAUSE_JOIN_KEY);
    expect(enHint).toContain('ALL');
    expect(enHint).toContain('AND');
    expect(enMultiple).toContain('ALL');
    expect(enJoin).toContain(' and ');
    for (const text of [enHint, enMultiple]) {
      expect(text).not.toMatch(/independently/);
      expect(text).not.toMatch(/NOT an/);
    }
  });

  it('🔴 多行摘要按连接词拼出来就是「A 且 B」（与 rule-form 同一份渲染逻辑）', () => {
    const summary = buildConditionsSummary({
      ...base,
      rows: [
        row({ propertyLabel: '温度' }),
        row({
          operator: 'LT',
          propertyLabel: '湿度',
          threshold: '10',
          unit: '%',
        }),
      ],
    });
    const clauses = (summary.conditionClauses ?? []).map((clause) =>
      $t(clause.key, resolveArgs(clause.args, $t)),
    );
    expect(clauses.join($t(CONDITION_CLAUSE_JOIN_KEY))).toContain('且');
    expect(clauses).toHaveLength(2);
  });
});
