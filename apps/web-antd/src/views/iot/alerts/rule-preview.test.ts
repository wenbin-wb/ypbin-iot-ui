import { describe, expect, it } from 'vitest';

import {
  conditionHolds,
  evaluateRulePreview,
  evaluateRulePreviewPerCondition,
  RULE_PREVIEW_WINDOWS,
  toPreviewConditionViews,
} from './rule-preview';

/** 告警规则历史试算纯函数用例（口径与后端 AlertRules.verdict 对齐）。 */

function point(
  ts: number,
  value: null | string,
  quality: null | string = 'GOOD',
) {
  return { quality, ts, value };
}

function num(
  operator: string,
  threshold: number | string,
  deadband?: number | string,
) {
  return {
    deadband,
    operator,
    propertyId: 'temp',
    threshold,
    valueType: 'NUMERIC',
  };
}

describe('conditionHolds：各比较符边界值（与后端口径一致）', () => {
  it('gt 读 30 不触发、读 30.0001 触发', () => {
    expect(conditionHolds('GT', 30, 30)).toBe(false);
    expect(conditionHolds('GT', 30, 30.0001)).toBe(true);
  });

  it('比较符 GTE / LT / LTE 的等号归属', () => {
    expect(conditionHolds('GTE', 30, 30)).toBe(true);
    expect(conditionHolds('LT', 30, 30)).toBe(false);
    expect(conditionHolds('LT', 30, 29.9999)).toBe(true);
    expect(conditionHolds('LTE', 30, 30)).toBe(true);
  });

  it('比较符 EQ / NE 对十进制等价形态也成立（1.10 = 1.1）', () => {
    expect(conditionHolds('EQ', 1.1, Number('1.10'))).toBe(true);
    expect(conditionHolds('NE', 1.1, Number('1.10'))).toBe(false);
  });
});

describe('toPreviewConditionViews：条件归一化与合法性', () => {
  it('合法条件给出符号、比较域与恢复侧回差门槛', () => {
    const views = toPreviewConditionViews([
      num('GT', 30, 5),
      num('LT', 10, 2),
      num('EQ', 7, 1),
    ]);
    expect(views).not.toBeNull();
    expect(views?.[0]).toMatchObject({
      deadband: 5,
      operator: 'GT',
      recoverThreshold: 25,
      symbol: '>',
      threshold: 30,
      valueType: 'NUMERIC',
    });
    expect(views?.[1]).toMatchObject({
      operator: 'LT',
      recoverThreshold: 12,
      symbol: '<',
    });
    // EQ 的恢复是「偏离超过回差」的区间，不在单一门槛里表达
    expect(views?.[2]?.recoverThreshold).toBeNull();
  });

  it('非法条件返回 null：未知比较符 / 缺点位 / 阈值不可解析 / 负回差', () => {
    expect(toPreviewConditionViews([num('BOGUS', 1)])).toBeNull();
    expect(
      toPreviewConditionViews([
        { operator: 'GT', propertyId: '', threshold: 1, valueType: 'NUMERIC' },
      ]),
    ).toBeNull();
    expect(toPreviewConditionViews([num('GT', 'abc')])).toBeNull();
    expect(toPreviewConditionViews([num('GT', 1, -1)])).toBeNull();
  });

  it('布尔点位只允许 EQ/NE；非布尔比较符判非法（不许把 true 当 1 比大小）', () => {
    expect(
      toPreviewConditionViews([
        {
          operator: 'GT',
          propertyId: 'switch',
          threshold: '1',
          valueType: 'BOOLEAN',
        },
      ]),
    ).toBeNull();
    const views = toPreviewConditionViews([
      {
        operator: 'EQ',
        propertyId: 'switch',
        threshold: 'true',
        valueType: 'BOOLEAN',
      },
    ]);
    expect(views?.[0]).toMatchObject({ threshold: 1, valueType: 'BOOLEAN' });
  });
});

describe('evaluateRulePreview：断档类与非法条件不伪造结论', () => {
  it('无 thresholds（断档/离线类）⇒ unsupported/empty-conditions，不消费样本', () => {
    const result = evaluateRulePreview({
      conditions: [],
      points: [point(1000, '80')],
    });
    expect(result.kind).toBe('unsupported');
    expect(result.reason).toBe('empty-conditions');
    expect(result.usedSamples).toBe(0);
  });

  it('非法条件 ⇒ unsupported/invalid-condition（不猜一个默认阈值）', () => {
    const result = evaluateRulePreview({
      conditions: [num('BOGUS', 1)],
      points: [point(1000, '80')],
    });
    expect(result.kind).toBe('unsupported');
    expect(result.reason).toBe('invalid-condition');
  });

  it('空样本 ⇒ ok + 全零（页面按“无可用样本”提示，不编造触发）', () => {
    const result = evaluateRulePreview({
      conditions: [num('GT', 30)],
      points: [],
    });
    expect(result.kind).toBe('ok');
    expect(result.usedSamples).toBe(0);
    expect(result.matchedCount).toBe(0);
    expect(result.triggerCount).toBe(0);
    expect(result.samples).toEqual([]);
  });
});

describe('evaluateRulePreview：触发段数 / 首末命中 / 不可判定样本', () => {
  it('连续命中合并为一段；明确未命中会断开；不可判定样本不打断', () => {
    const result = evaluateRulePreview({
      conditions: [num('GT', 30)],
      points: [
        point(1000, '31'), // 命中
        point(2000, '35'), // 命中（同一段）
        point(3000, '10'), // 未命中 ⇒ 断段
        point(4000, null, 'BAD'), // 不可判定：不打断
        point(5000, 'abc'), // 非数值：不打断
        point(6000, '31'), // 命中（第二段）
        point(7000, '32'), // 命中（同一段）
      ],
    });
    expect(result.kind).toBe('ok');
    expect(result.triggerCount).toBe(2);
    expect(result.matchedCount).toBe(4);
    expect(result.skippedSamples).toBe(2);
    expect(result.usedSamples).toBe(5); // 不可判定样本不进入明细
    expect(result.firstTriggerTs).toBe(1000);
    expect(result.lastTriggerTs).toBe(7000);
    expect(result.samples.map((item) => item.matched)).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
  });

  it('质量非 GOOD（null/BAD）一律不可判定，不算未命中', () => {
    const result = evaluateRulePreview({
      conditions: [num('GT', 30)],
      points: [
        point(1000, '31', null),
        point(2000, '31', 'BAD'),
        point(3000, '31', 'good'),
      ],
    });
    expect(result.skippedSamples).toBe(2);
    expect(result.matchedCount).toBe(1);
    expect(result.triggerCount).toBe(1);
  });

  it('多条件按 AND：全满足才命中', () => {
    const conditions = [num('GT', 30), num('LT', 50)];
    const result = evaluateRulePreview({
      conditions,
      points: [
        point(1000, '40'), // 同时满足
        point(2000, '60'), // 超上限
        point(3000, '20'), // 低于下限
      ],
    });
    expect(result.matchedCount).toBe(1);
    expect(result.triggerCount).toBe(1);
    expect(result.firstTriggerTs).toBe(1000);
  });

  it('任一条件值不可解析 ⇒ 该样本不可判定（不因为另一条件满足就算触发）', () => {
    const conditions = [num('GT', 30), num('GT', 10)];
    const result = evaluateRulePreview({
      conditions,
      points: [point(1000, 'abc')],
    });
    expect(result.kind).toBe('ok');
    expect(result.skippedSamples).toBe(1);
    expect(result.usedSamples).toBe(0);
  });
});

describe('evaluateRulePreview：BOOLEAN 比较域', () => {
  it('布尔字面量 1/true/0/false 都可判定（EQ/NE）', () => {
    const eq = evaluateRulePreview({
      conditions: [
        {
          operator: 'EQ',
          propertyId: 'switch',
          threshold: 'true',
          valueType: 'BOOLEAN',
        },
      ],
      points: [point(1000, '1'), point(2000, 'false')],
    });
    expect(eq.matchedCount).toBe(1);
    expect(eq.firstTriggerTs).toBe(1000);

    const ne = evaluateRulePreview({
      conditions: [
        {
          operator: 'NE',
          propertyId: 'switch',
          threshold: 'true',
          valueType: 'BOOLEAN',
        },
      ],
      points: [point(1000, 'true'), point(2000, '0')],
    });
    expect(ne.matchedCount).toBe(1);
    expect(ne.firstTriggerTs).toBe(2000);
  });

  it('布尔点位读到既非 true/false/1/0 的值 ⇒ 不可判定，不误报', () => {
    const result = evaluateRulePreview({
      conditions: [
        {
          operator: 'EQ',
          propertyId: 'switch',
          threshold: 'true',
          valueType: 'BOOLEAN',
        },
      ],
      points: [point(1000, 'ON')],
    });
    expect(result.skippedSamples).toBe(1);
    expect(result.matchedCount).toBe(0);
    expect(result.triggerCount).toBe(0);
  });
});

describe('evaluateRulePreview：时间排序 / 时间窗 / 限流裁剪', () => {
  it('乱序样本按真实 ts 升序判定，首末命中取正确', () => {
    const result = evaluateRulePreview({
      conditions: [num('GT', 30)],
      points: [point(3000, '31'), point(1000, '10'), point(2000, '31')],
    });
    expect(result.samples.map((item) => item.ts)).toEqual([1000, 2000, 3000]);
    // 2000 命中，随后 3000 命中（同一段）；1000 未命中
    expect(result.triggerCount).toBe(1);
    expect(result.firstTriggerTs).toBe(2000);
    expect(result.lastTriggerTs).toBe(3000);
  });

  it('时间窗外的样本被剔除并计数，不参与判定', () => {
    const result = evaluateRulePreview({
      conditions: [num('GT', 30)],
      from: 2000,
      points: [point(1000, '31'), point(2000, '31'), point(3000, '31')],
      to: 3000,
    });
    expect(result.outsideWindowSamples).toBe(1);
    expect(result.usedSamples).toBe(2);
    expect(result.firstTriggerTs).toBe(2000);
  });

  it('超过 limit ⇒ 只保留最近 limit 条参与判定，并报告截断数', () => {
    const result = evaluateRulePreview({
      conditions: [num('GT', 30)],
      limit: 2,
      points: [
        point(1000, '31'),
        point(2000, '10'),
        point(3000, '10'),
        point(4000, '31'),
        point(5000, '31'),
      ],
    });
    expect(result.totalSamples).toBe(5);
    expect(result.truncatedSamples).toBe(3);
    expect(result.usedSamples).toBe(2);
    expect(result.samples.map((item) => item.ts)).toEqual([4000, 5000]);
    expect(result.matchedCount).toBe(2);
    expect(result.triggerCount).toBe(1);
  });

  it('limit 非法（0/负/NaN）按不裁剪处理，不抛异常', () => {
    const input = {
      conditions: [num('GT', 30)],
      points: [point(1000, '31'), point(2000, '31')],
    };
    for (const limit of [0, -5, Number.NaN]) {
      const result = evaluateRulePreview({ ...input, limit });
      expect(result.usedSamples).toBe(2);
      expect(result.truncatedSamples).toBe(0);
    }
  });

  it('时间窗常量覆盖 1h/6h/24h/7d', () => {
    expect(RULE_PREVIEW_WINDOWS['1h']).toBe(3_600_000);
    expect(RULE_PREVIEW_WINDOWS['7d']).toBe(7 * 24 * 3_600_000);
  });
});

/**
 * 逐条件试算（task-4 的存量口径修正）。
 *
 * 引擎对**每个点位条件各自建候选、各自判定、各自产生告警实例**，因此多条件规则**不能**
 * 把多行合并成一个判定：那等价于宣称「同一点位的 AND」，不对应任何线上行为
 * （旧实现正是把「试算点位」代入所有条件后再合并判定，属错误口径）。
 */
describe('evaluateRulePreviewPerCondition：逐条件独立试算（与引擎同口径）', () => {
  it('两条件、各自不同点位 ⇒ 各自用**自己点位**的序列判定，互不影响', () => {
    const results = evaluateRulePreviewPerCondition(
      [num('GT', 30), num('LT', 10)],
      {
        temp: [point(1000, '40'), point(2000, '5')],
        humidity: [point(1000, '40'), point(2000, '5')],
      },
    );

    expect(results).toHaveLength(2);
    // 条件 1（GT 30）：40 命中、5 未命中 ⇒ 1 次
    expect(results[0]?.propertyId).toBe('temp');
    expect(results[0]?.result.matchedCount).toBe(1);
    expect(results[0]?.result.firstTriggerTs).toBe(1000);
    // 条件 2（LT 10）：40 未命中、5 命中 ⇒ 1 次（若被错误地合并成 AND，结果会是 0）
    expect(results[1]?.propertyId).toBe('temp');
    expect(results[1]?.result.matchedCount).toBe(1);
    expect(results[1]?.result.firstTriggerTs).toBe(2000);
  });

  it('🔴 多条件**不得**被合并成 AND 判定（旧口径会给出 0 命中）', () => {
    // 同一点位、GT 30 与 LT 10：没有任何值能同时满足
    const results = evaluateRulePreviewPerCondition(
      [num('GT', 30), num('LT', 10)],
      { temp: [point(1000, '40'), point(2000, '5')] },
    );
    // 逐条件：GT30 命中 1 条；LT10 命中 1 条 ⇒ 各 1 条，且**不是** 0
    expect(results.map((item) => item.result.matchedCount)).toEqual([1, 1]);
  });

  it('某个点位没有序列 ⇒ 该条件 unsupported（不伪造 0 命中）', () => {
    const results = evaluateRulePreviewPerCondition(
      [num('GT', 30), { ...num('GT', 30), propertyId: 'missing' }],
      { temp: [point(1000, '40')] },
    );
    expect(results[0]?.result.kind).toBe('ok');
    expect(results[1]?.propertyId).toBe('missing');
    expect(results[1]?.result.kind).toBe('unsupported');
    expect(results[1]?.result.reason).toBe('empty-conditions');
  });

  it('非法条件行 ⇒ 该行 unsupported/invalid-condition，其余行照常判定', () => {
    const results = evaluateRulePreviewPerCondition(
      [num('GT', 30), num('BOGUS', 1)],
      { temp: [point(1000, '40')] },
    );
    expect(results[0]?.result.kind).toBe('ok');
    expect(results[1]?.result.kind).toBe('unsupported');
    expect(results[1]?.result.reason).toBe('invalid-condition');
    expect(results[1]?.view).toBeNull();
  });

  it('无条件行 ⇒ 空数组（断档类没有可试算的东西，页面据此如实提示）', () => {
    expect(evaluateRulePreviewPerCondition([], {})).toEqual([]);
  });

  it('行顺序与条件顺序一一对应（结果不得重排）', () => {
    const results = evaluateRulePreviewPerCondition(
      [
        { ...num('GT', 1), propertyId: 'a' },
        { ...num('GT', 2), propertyId: 'b' },
        { ...num('GT', 3), propertyId: 'c' },
      ],
      { a: [], b: [], c: [] },
    );
    expect(results.map((item) => item.propertyId)).toEqual(['a', 'b', 'c']);
    expect(results.map((item) => item.index)).toEqual([0, 1, 2]);
  });

  it('时间窗与 limit 透传到每个条件', () => {
    const results = evaluateRulePreviewPerCondition(
      [num('GT', 30)],
      {
        temp: [point(1000, '40'), point(2000, '40'), point(3000, '40')],
      },
      { limit: 2 },
    );
    expect(results[0]?.result.usedSamples).toBe(2);
    expect(results[0]?.result.truncatedSamples).toBe(1);
  });
});
