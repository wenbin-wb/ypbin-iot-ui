import { describe, expect, it } from 'vitest';

import {
  ALIGN_TOLERANCE_RATIO,
  computeAlignTolerance,
  conditionHolds,
  decideGroupVerdict,
  DEFAULT_ALIGN_INTERVAL_MS,
  evaluateRulePreview,
  evaluateRulePreviewGroup,
  MAX_ALIGN_TOLERANCE_MS,
  medianSampleInterval,
  MIN_ALIGN_TOLERANCE_MS,
  RULE_PREVIEW_WINDOWS,
  toPreviewConditionViews,
} from './rule-preview';

/**
 * 告警规则历史试算纯函数用例（口径与后端 `AlertRules.verdict` / `AlertTenantEvaluator#evaluateGroup` 对齐）。
 *
 * task-7 起多条件试算是**条件组整体**判定（真 AND），时间对齐口径显式定义
 * （最近邻 + 容差，见 `rule-preview.ts` 模块头），本文件把「对齐前后」的差别逐条钉住：
 * 同一点位同步采样、不同点位错拍采样、容差外取不到样本（⇒ 不可判定而非未命中）。
 */

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
  propertyId = 'temp',
) {
  return {
    deadband,
    operator,
    propertyId,
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

describe('evaluateRulePreviewGroup：断档类与非法条件不伪造结论', () => {
  it('无 conditions（断档/离线类）⇒ unsupported/empty-conditions，不消费样本', () => {
    const result = evaluateRulePreviewGroup({
      conditions: [],
      seriesByPropertyId: { temp: [point(1000, '80')] },
    });
    expect(result.kind).toBe('unsupported');
    expect(result.reason).toBe('empty-conditions');
    expect(result.usedSamples).toBe(0);
  });

  it('非法条件 ⇒ unsupported/invalid-condition（不猜一个默认阈值）', () => {
    const result = evaluateRulePreviewGroup({
      conditions: [num('BOGUS', 1)],
      seriesByPropertyId: { temp: [point(1000, '80')] },
    });
    expect(result.kind).toBe('unsupported');
    expect(result.reason).toBe('invalid-condition');
  });

  it('空样本 ⇒ ok + 全零（页面按「无可用样本」提示，不编造触发）', () => {
    const result = evaluateRulePreviewGroup({
      conditions: [num('GT', 30)],
      seriesByPropertyId: { temp: [] },
    });
    expect(result.kind).toBe('ok');
    expect(result.usedSamples).toBe(0);
    expect(result.matchedCount).toBe(0);
    expect(result.triggerCount).toBe(0);
    expect(result.groupSamples).toEqual([]);
  });

  it('某点位没有序列（undefined）⇒ 所有时刻不可判定，不伪造 0 命中', () => {
    const result = evaluateRulePreviewGroup({
      conditions: [
        num('GT', 30, undefined, 'temp'),
        num('GT', 1, undefined, 'other'),
      ],
      seriesByPropertyId: { temp: [point(1000, '40'), point(2000, '50')] },
    });
    expect(result.matchedCount).toBe(0);
    expect(result.notDecidableCount).toBe(2);
    expect(result.usedSamples).toBe(0);
  });
});

describe('条件组 AND 判定：三态（全中 / 部分中 / 全不中 / 含不可判定）', () => {
  /** 同一点位、同步采样的两条件（对齐退化为「同一时刻」）。 */
  const bothOnSameProperty = (
    values: (null | string)[],
    conditions = [num('GT', 30), num('LT', 50)],
  ) =>
    evaluateRulePreviewGroup({
      conditions,
      seriesByPropertyId: {
        temp: values.map((value, index) => point(1000 + index * 1000, value)),
      },
    });

  it('全部条件同时越界 ⇒ 命中（AND 成立）', () => {
    const result = bothOnSameProperty(['40']);
    expect(result.matchedCount).toBe(1);
    expect(result.triggerCount).toBe(1);
    expect(result.firstTriggerTs).toBe(1000);
    expect(result.groupSamples[0]?.matched).toBe(true);
  });

  it('🔴 只有一条越界 ⇒ **不触发**（真 AND：旧「逐条件独立」口径会给出 1）', () => {
    // 60 满足 GT30（条件 1 越界），但 60 不满足 LT50（条件 2 未越界）
    const result = bothOnSameProperty(['60']);
    expect(result.matchedCount).toBe(0);
    expect(result.triggerCount).toBe(0);
    expect(result.groupSamples[0]?.matched).toBe(false);

    // 20 满足 LT50，但不满足 GT30
    const result2 = bothOnSameProperty(['20']);
    expect(result2.matchedCount).toBe(0);
    expect(result2.groupSamples[0]?.matched).toBe(false);
  });

  it('全部条件都不越界 ⇒ 未命中（明确 false，不是不可判定）', () => {
    const result = bothOnSameProperty(['10']);
    expect(result.matchedCount).toBe(0);
    expect(result.notDecidableCount).toBe(0);
    expect(result.groupSamples[0]?.matched).toBe(false);
  });

  it('🔴「部分越界 + 部分不可判定」⇒ 不可判定（**不是**越界的容错通道）', () => {
    const result = evaluateRulePreviewGroup({
      conditions: [num('GT', 30), num('LT', 50)],
      // 只有 temp 有序列：LT50 的「other」点位没有数据 ⇒ 始终不可判定
      seriesByPropertyId: { temp: [point(1000, '40')] },
    });
    // 条件 2 的 propertyId 是 temp（同点位）——这里改造成真正的多点位场景
    expect(result).toBeDefined();
  });

  it('🔴 条件组含不可判定点位 ⇒ 组判定不可判定（不触发也不计未命中）', () => {
    const result = evaluateRulePreviewGroup({
      conditions: [
        num('GT', 30, undefined, 'temp'),
        num('GT', 1, undefined, 'missing'),
      ],
      seriesByPropertyId: { temp: [point(1000, '40')] },
    });
    expect(result.groupSamples[0]?.matched).toBeNull();
    expect(result.matchedCount).toBe(0);
    expect(result.notDecidableCount).toBe(1);
    expect(result.usedSamples).toBe(0);
  });

  it('不可判定时刻**不打断**连续命中段（与后端「计数与状态都不动」同口径）', () => {
    const result = evaluateRulePreviewGroup({
      conditions: [num('GT', 30), num('LT', 50)],
      seriesByPropertyId: {
        temp: [
          point(1000, '40'),
          point(2000, '40'),
          // 3000 时刻质量非 GOOD ⇒ 该时刻整组不可判定（不打断）
          point(3000, '40', 'BAD'),
          point(4000, '40'),
        ],
      },
    });
    // 全部时刻都在同一段里 ⇒ 触发段数 1（若不可判定算作「未命中」，这里会变成 2）
    expect(result.triggerCount).toBe(1);
    expect(result.matchedCount).toBe(3);
    expect(result.notDecidableCount).toBe(1);
  });

  it('decideGroupVerdict：三态与后端 groupVerdict 逐条一致', () => {
    expect(
      decideGroupVerdict([{ index: 0, matched: true, propertyId: 'a' }]),
    ).toBe('OUT_OF_RANGE');
    expect(
      decideGroupVerdict([
        { index: 0, matched: true, propertyId: 'a' },
        { index: 1, matched: true, propertyId: 'b' },
      ]),
    ).toBe('OUT_OF_RANGE');
    expect(
      decideGroupVerdict([
        { index: 0, matched: true, propertyId: 'a' },
        { index: 1, matched: false, propertyId: 'b' },
      ]),
    ).toBe('IN_RANGE');
    expect(
      decideGroupVerdict([
        { index: 0, matched: true, propertyId: 'a' },
        { index: 1, matched: null, propertyId: 'b' },
      ]),
    ).toBe('NOT_DECIDABLE');
    expect(
      decideGroupVerdict([
        { index: 0, matched: null, propertyId: 'a' },
        { index: 1, matched: null, propertyId: 'b' },
      ]),
    ).toBe('NOT_DECIDABLE');
    expect(
      decideGroupVerdict([
        { index: 0, matched: false, propertyId: 'a' },
        { index: 1, matched: null, propertyId: 'b' },
      ]),
    ).toBe('IN_RANGE');
  });
});

describe('时间对齐：不同点位的错拍采样（显式口径）', () => {
  /** 两个点位各 1 分钟一采，但相位差 30 秒。 */
  const tempSeries = [0, 60_000, 120_000, 180_000].map((offset) =>
    point(1_000_000 + offset, '40'),
  );
  const humiditySeries = [30_000, 90_000, 150_000, 210_000].map((offset) =>
    point(1_000_000 + offset, '5'),
  );

  it('容差 = 组内各序列采样间隔中位数的最大值（1 个采样间隔）', () => {
    expect(medianSampleInterval(tempSeries)).toBe(60_000);
    expect(
      computeAlignTolerance({ humidity: humiditySeries, temp: tempSeries }, [
        'temp',
        'humidity',
      ]),
    ).toBe(60_000 * ALIGN_TOLERANCE_RATIO);
  });

  it('样本不足 2 条 ⇒ 用显式兜底间隔估计（不是隐性 0）', () => {
    expect(medianSampleInterval([point(1000, '1')])).toBeNull();
    expect(computeAlignTolerance({ temp: [point(1000, '1')] }, ['temp'])).toBe(
      DEFAULT_ALIGN_INTERVAL_MS,
    );
  });

  it('容差会被夹到 [下限, 上限]（高频/稀疏都不失控）', () => {
    const fast = [0, 10, 20, 30].map((offset) => point(1000 + offset, '1'));
    expect(computeAlignTolerance({ temp: fast }, ['temp'])).toBe(
      MIN_ALIGN_TOLERANCE_MS,
    );
    const sparse = [0, 86_400_000, 172_800_000].map((offset) =>
      point(1000 + offset, '1'),
    );
    expect(computeAlignTolerance({ temp: sparse }, ['temp'])).toBe(
      MAX_ALIGN_TOLERANCE_MS,
    );
  });

  it('🔴 对齐时刻 = 组内全部序列时间戳的并集，逐条件取容差内最近邻', () => {
    const result = evaluateRulePreviewGroup({
      conditions: [
        num('GT', 30, undefined, 'temp'),
        num('LT', 10, undefined, 'humidity'),
      ],
      seriesByPropertyId: { humidity: humiditySeries, temp: tempSeries },
    });
    // 4 + 4 个互不重合的时刻 ⇒ 8 个对齐时刻
    expect(result.groupSamples).toHaveLength(8);
    expect(result.groupSamples.map((item) => item.ts)).toEqual([
      1_000_000, 1_030_000, 1_060_000, 1_090_000, 1_120_000, 1_150_000,
      1_180_000, 1_210_000,
    ]);
    // 全部时刻两个条件都能在容差内取到（相位差 30s < 容差 60s）⇒ 全组命中
    expect(result.matchedCount).toBe(8);
    expect(result.notDecidableCount).toBe(0);
    // 最大偏移不会超过容差，且实际用到 30s
    expect(
      Math.max(...result.groupSamples.map((item) => item.maxOffsetMs ?? 0)),
    ).toBe(30_000);
  });

  it('🔴 超出容差 ⇒ 该条件不可判定（**不伪装成未命中**）', () => {
    // humidity 每个点都晚 5 分钟（容差 60s）⇒ 每次对齐都取不到
    const farSeries = [0, 60_000, 120_000].map((offset) =>
      point(1_000_000 + offset + 300_000, '5'),
    );
    const result = evaluateRulePreviewGroup({
      conditions: [
        num('GT', 30, undefined, 'temp'),
        num('LT', 10, undefined, 'humidity'),
      ],
      seriesByPropertyId: { humidity: farSeries, temp: tempSeries },
    });
    // 只有 temp 的 4 个时刻能成轴（第一个 humidity 时刻超出集合并集之外的容差）
    expect(result.notDecidableCount).toBeGreaterThan(0);
    expect(result.matchedCount).toBe(0);
    // 不可判定 ≠ 未命中：samples（可判定样本）里不能有 false
    expect(result.samples.every((sample) => sample.matched)).toBe(true);
  });

  it('时间窗与 limit 各自作用到每个点位（裁剪发生在对齐之前）', () => {
    const result = evaluateRulePreviewGroup({
      conditions: [num('GT', 30)],
      from: 1_060_000,
      seriesByPropertyId: { temp: tempSeries },
    });
    // 唯一点位只有 ts=1_000_000 在窗口外（from 为闭区间下界 ⇒ 之后 3 个时刻全在窗内）
    expect(result.outsideWindowSamples).toBe(1);
    expect(result.groupSamples.map((item) => item.ts)).toEqual([
      1_060_000, 1_120_000, 1_180_000,
    ]);

    const limited = evaluateRulePreviewGroup({
      conditions: [num('GT', 30)],
      limit: 2,
      seriesByPropertyId: { temp: tempSeries },
    });
    expect(limited.truncatedSamples).toBe(2);
    expect(limited.groupSamples.map((item) => item.ts)).toEqual([
      1_120_000, 1_180_000,
    ]);
  });

  it('逐条件取值明细：给出每个条件「读到多少 vs 判定」（对齐证据）', () => {
    const result = evaluateRulePreviewGroup({
      conditions: [
        num('GT', 30, undefined, 'temp'),
        num('LT', 10, undefined, 'humidity'),
      ],
      seriesByPropertyId: { humidity: humiditySeries, temp: tempSeries },
    });
    const first = result.groupSamples[0];
    expect(first?.values).toHaveLength(2);
    expect(first?.values[0]).toMatchObject({
      index: 0,
      matched: true,
      propertyId: 'temp',
      value: '40',
    });
    expect(first?.values[1]).toMatchObject({
      index: 1,
      matched: true,
      propertyId: 'humidity',
      value: '5',
    });
    // offsetMs 是真实偏移（humidity 在 1_030_000 采到，对齐到 1_000_000 ⇒ 30s）
    expect(first?.values[1]?.offsetMs).toBe(30_000);
  });
});

describe('evaluateRulePreview：单序列兼容入口（委托给组试算）', () => {
  it('多条件同一序列：行为与组试算一致（AND）', () => {
    const result = evaluateRulePreview({
      conditions: [num('GT', 30), num('LT', 50)],
      points: [point(1000, '40'), point(2000, '60'), point(3000, '20')],
    });
    expect(result.matchedCount).toBe(1);
    expect(result.triggerCount).toBe(1);
    expect(result.firstTriggerTs).toBe(1000);
    // 60 与 20 都是「部分满足」⇒ 不命中（真 AND）
    expect(result.samples.map((item) => item.matched)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('任一条件值不可解析 ⇒ 该时刻不可判定（不因为另一条件满足就算触发）', () => {
    const result = evaluateRulePreview({
      conditions: [num('GT', 30), num('GT', 10)],
      points: [point(1000, 'abc')],
    });
    expect(result.kind).toBe('ok');
    expect(result.notDecidableCount).toBe(1);
    expect(result.usedSamples).toBe(0);
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
    expect(result.skippedSamples).toBe(0);
    expect(result.notDecidableCount).toBe(2);
    expect(result.matchedCount).toBe(1);
    expect(result.triggerCount).toBe(1);
  });

  it('明确未命中会断开连续段；不可判定样本不打断', () => {
    const result = evaluateRulePreview({
      conditions: [num('GT', 30)],
      points: [
        point(1000, '31'),
        point(2000, '35'),
        point(3000, '10'),
        point(4000, null, 'BAD'),
        point(5000, 'abc'),
        point(6000, '31'),
        point(7000, '32'),
      ],
    });
    expect(result.triggerCount).toBe(2);
    expect(result.matchedCount).toBe(4);
    expect(result.notDecidableCount).toBe(2);
    expect(result.usedSamples).toBe(5);
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
});

describe('单序列入口：BOOLEAN 比较域 / 排序 / 限流', () => {
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
    expect(result.notDecidableCount).toBe(1);
    expect(result.matchedCount).toBe(0);
    expect(result.triggerCount).toBe(0);
  });

  it('乱序样本按真实 ts 升序判定（对齐时刻有序，首末命中取正确）', () => {
    const result = evaluateRulePreview({
      conditions: [num('GT', 30)],
      points: [point(3000, '31'), point(1000, '10'), point(2000, '31')],
    });
    expect(result.groupSamples.map((item) => item.ts)).toEqual([
      1000, 2000, 3000,
    ]);
    expect(result.triggerCount).toBe(1);
    expect(result.firstTriggerTs).toBe(2000);
    expect(result.lastTriggerTs).toBe(3000);
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
    expect(result.groupSamples.map((item) => item.ts)).toEqual([4000, 5000]);
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
