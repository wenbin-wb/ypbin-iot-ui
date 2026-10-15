import { describe, expect, it } from 'vitest';

import {
  createConditionRow,
  isDecimalText,
  MAX_POINTS_PER_RULE,
  parseConditionRows,
  toConditionRequests,
  validateConditionRows,
} from './condition-rows';

/**
 * 多条件行纯逻辑用例（task-4 建，task-7 按真 AND 语义修订）。
 *
 * 守门的不变量（每一条都对应一个真实会伤到用户的失败）：
 * 1. **回填全部条件行**——旧实现只取 `points[0]`，编辑多条件规则再保存会静默删掉其余条件；
 * 2. **保存顺序 = 界面顺序**——顺序是用户能看到的语义（也决定通知正文明细与实例快照的顺序）；
 * 3. 校验与后端 `AlertRuleServiceImpl.buildPoint()/validate()` **完全同口径**
 *    （比较符白名单、布尔只能 EQ/NE 且阈值 0/1、阈值/回差必须是十进制数、回差非负、行数上限、
 *    点位级至少一行）；
 * 4. **同一点位重复不再被拦**（task-7 语义翻转）——去重键已是 `R:ruleId:deviceId`（不含
 *    propertyId），组内两条同点位条件各参与一次合取判定（例如「同一读数 > 80 且 < 100」），
 *    属于合法用法，必须能保存。
 */

describe('parseConditionRows：编辑回填（本次核心 bug）', () => {
  it('🔴 points=[A,B,C] 全部回填，顺序与标识/比较符/阈值/比较域/回差都不丢', () => {
    const rows = parseConditionRows([
      {
        deadband: '2',
        id: '1',
        operator: 'GT',
        propertyId: 'temperature',
        threshold: '80',
        valueType: 'NUMERIC',
      },
      {
        id: '2',
        operator: 'LT',
        propertyId: 'humidity',
        threshold: '10',
        valueType: 'NUMERIC',
      },
      {
        id: '3',
        operator: 'EQ',
        propertyId: 'switch',
        threshold: '1',
        valueType: 'BOOLEAN',
      },
    ]);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.propertyId)).toEqual([
      'temperature',
      'humidity',
      'switch',
    ]);
    expect(rows.map((row) => row.operator)).toEqual(['GT', 'LT', 'EQ']);
    expect(rows.map((row) => row.threshold)).toEqual(['80', '10', '1']);
    expect(rows.map((row) => row.valueType)).toEqual([
      'NUMERIC',
      'NUMERIC',
      'BOOLEAN',
    ]);
    // 缺回差 ⇒ 空串（表单语义），提交时转 undefined，不伪造 0
    expect(rows[1]?.deadband).toBe('');
    expect(rows[0]?.deadband).toBe('2');
  });

  it('每一行都有唯一 key（v-for 不能出现重复 key）', () => {
    const rows = parseConditionRows([
      {
        id: '1',
        operator: 'GT',
        propertyId: 'a',
        threshold: '1',
        valueType: 'NUMERIC',
      },
      {
        id: '2',
        operator: 'GT',
        propertyId: 'b',
        threshold: '1',
        valueType: 'NUMERIC',
      },
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it('无 points（断档类）⇒ 空数组，不伪造一行', () => {
    expect(parseConditionRows(undefined)).toEqual([]);
    expect(parseConditionRows([])).toEqual([]);
  });

  it('未知比较符/缺比较域 **原样保留**（交给行级校验报错，不悄悄替换）', () => {
    const rows = parseConditionRows([
      { id: '1', operator: 'BOGUS', propertyId: 'a', threshold: '1' },
      { id: '2', operator: 'GT', propertyId: 'b', threshold: '1' },
    ] as never);
    expect(rows[0]?.operator).toBe('BOGUS');
    // 缺 valueType ⇒ 按后端 buildPoint 的「null/blank 兜底 = NUMERIC」
    expect(rows[1]?.valueType).toBe('NUMERIC');
  });
});

describe('toConditionRequests：保存请求按界面顺序、不丢行', () => {
  it('顺序与行数逐字保持', () => {
    const rows = parseConditionRows([
      {
        id: '1',
        operator: 'GT',
        propertyId: 'a',
        threshold: '1',
        valueType: 'NUMERIC',
      },
      {
        id: '2',
        operator: 'LT',
        propertyId: 'b',
        threshold: '2',
        valueType: 'NUMERIC',
      },
    ]);
    const req = toConditionRequests(rows);
    expect(req).toHaveLength(2);
    expect(req.map((item) => item.propertyId)).toEqual(['a', 'b']);
  });

  it('空回差 ⇒ deadband 为 undefined（序列化后不出现在请求体里：不是空串、不是 0）', () => {
    const req = toConditionRequests([
      createConditionRow({ operator: 'GT', propertyId: 'a', threshold: '1' }),
    ]);
    expect(req[0]?.deadband).toBeUndefined();
    // 真正发给后端的 JSON 里没有该字段（空串会被后端当「有回差但解析失败」）
    expect(JSON.stringify(req[0])).not.toContain('deadband');
    expect(req[0]).toMatchObject({
      operator: 'GT',
      propertyId: 'a',
      threshold: '1',
      valueType: 'NUMERIC',
    });
  });

  it('有回差时按原文本提交（不做数值归一：1.10 不得被悄悄改成 1.1）', () => {
    const req = toConditionRequests([
      createConditionRow({
        deadband: ' 1.10 ',
        operator: 'GT',
        propertyId: 'a',
        threshold: ' 80 ',
      }),
    ]);
    expect(req[0]?.deadband).toBe('1.10');
    expect(req[0]?.threshold).toBe('80');
  });

  it('往返：parse → request 保留全部有效信息（无静默丢弃）', () => {
    const points = [
      {
        id: '1',
        operator: 'GT',
        propertyId: 'a',
        threshold: '80',
        valueType: 'NUMERIC',
      },
      {
        deadband: '0',
        id: '2',
        operator: 'NE',
        propertyId: 'b',
        threshold: '0',
        valueType: 'BOOLEAN',
      },
    ];
    expect(toConditionRequests(parseConditionRows(points))).toEqual([
      {
        deadband: undefined,
        operator: 'GT',
        propertyId: 'a',
        threshold: '80',
        valueType: 'NUMERIC',
      },
      {
        deadband: '0',
        operator: 'NE',
        propertyId: 'b',
        threshold: '0',
        valueType: 'BOOLEAN',
      },
    ]);
  });
});

describe('validateConditionRows：与后端 buildPoint 同口径', () => {
  const options = { scopeType: 'POINT' };

  function row(init: Parameters<typeof createConditionRow>[0]) {
    return createConditionRow(init);
  }

  it('合法多行 ⇒ 无问题', () => {
    expect(
      validateConditionRows(
        [
          row({ operator: 'GT', propertyId: 'a', threshold: '80' }),
          row({
            deadband: '2',
            operator: 'LT',
            propertyId: 'b',
            threshold: '10',
          }),
        ],
        options,
      ),
    ).toEqual([]);
  });

  it('逐行定位：缺点位 / 缺比较符 / 缺阈值 / 非数字，都带 1 起行号', () => {
    const issues = validateConditionRows(
      [
        row({ operator: 'GT', propertyId: '', threshold: '1' }),
        row({ operator: '', propertyId: 'b', threshold: '1' }),
        row({ operator: 'GT', propertyId: 'c', threshold: '' }),
        row({ operator: 'GT', propertyId: 'd', threshold: '八十' }),
      ],
      options,
    );
    expect(issues).toEqual([
      {
        args: [1],
        index: 1,
        key: 'page.iot.alert.rule.condition.needProperty',
      },
      {
        args: [2],
        index: 2,
        key: 'page.iot.alert.rule.condition.needOperator',
      },
      {
        args: [3],
        index: 3,
        key: 'page.iot.alert.rule.condition.needThreshold',
      },
      {
        args: [4],
        index: 4,
        key: 'page.iot.alert.rule.condition.thresholdNotNumber',
      },
    ]);
  });

  it('比较符白名单：BOGUS 与未知码都拦（不静默按某个比较符提交）', () => {
    const issues = validateConditionRows(
      [row({ operator: 'BOGUS', propertyId: 'a', threshold: '1' })],
      options,
    );
    expect(issues[0]?.key).toBe('page.iot.alert.rule.condition.needOperator');
  });

  it('布尔点位：非 EQ/NE 拦；阈值只能 0/1', () => {
    const badOperator = validateConditionRows(
      [
        row({
          operator: 'GT',
          propertyId: 'sw',
          threshold: '1',
          valueType: 'BOOLEAN',
        }),
      ],
      options,
    );
    expect(badOperator[0]?.key).toBe(
      'page.iot.alert.rule.condition.booleanOperator',
    );

    const badThreshold = validateConditionRows(
      [
        row({
          operator: 'EQ',
          propertyId: 'sw',
          threshold: '2',
          valueType: 'BOOLEAN',
        }),
      ],
      options,
    );
    expect(badThreshold[0]?.key).toBe(
      'page.iot.alert.rule.condition.booleanThreshold',
    );

    // true/false 这类文本在后端 BigDecimal 解析是失败 ⇒ 前端同口径拒绝
    const textThreshold = validateConditionRows(
      [
        row({
          operator: 'EQ',
          propertyId: 'sw',
          threshold: 'true',
          valueType: 'BOOLEAN',
        }),
      ],
      options,
    );
    expect(textThreshold[0]?.key).toBe(
      'page.iot.alert.rule.condition.thresholdNotNumber',
    );

    expect(
      validateConditionRows(
        [
          row({
            operator: 'NE',
            propertyId: 'sw',
            threshold: '0',
            valueType: 'BOOLEAN',
          }),
        ],
        options,
      ),
    ).toEqual([]);
  });

  it('回差：非数字 / 负数拦，0 与非负小数放行', () => {
    expect(
      validateConditionRows(
        [
          row({
            deadband: 'abc',
            operator: 'GT',
            propertyId: 'a',
            threshold: '1',
          }),
        ],
        options,
      )[0]?.key,
    ).toBe('page.iot.alert.rule.condition.deadbandNotNumber');

    expect(
      validateConditionRows(
        [
          row({
            deadband: '-1',
            operator: 'GT',
            propertyId: 'a',
            threshold: '1',
          }),
        ],
        options,
      )[0]?.key,
    ).toBe('page.iot.alert.rule.condition.deadbandNegative');

    expect(
      validateConditionRows(
        [
          row({
            deadband: '0',
            operator: 'GT',
            propertyId: 'a',
            threshold: '1',
          }),
        ],
        options,
      ),
    ).toEqual([]);
  });

  it('点位级规则 0 行 ⇒ 作用域级问题（后端 validate 第 269-272 行同口径）', () => {
    expect(validateConditionRows([], options)).toEqual([
      { index: 0, key: 'page.iot.alert.rule.condition.needOne' },
    ]);
    // 设备级/租户级没有这条约束（0 行 = 断档类规则）
    expect(validateConditionRows([], { scopeType: 'DEVICE' })).toEqual([]);
    expect(validateConditionRows([], { scopeType: 'TENANT' })).toEqual([]);
  });

  it('行数超过上限 ⇒ 作用域级问题（默认与后端 AlertProperties.maxPointsPerRule 同值）', () => {
    const rows = Array.from({ length: MAX_POINTS_PER_RULE + 1 }, (_, index) =>
      row({ operator: 'GT', propertyId: `p${index}`, threshold: '1' }),
    );
    const issues = validateConditionRows(rows, options);
    expect(issues[0]?.key).toBe('page.iot.alert.rule.condition.tooMany');
    expect(issues[0]?.args).toEqual([MAX_POINTS_PER_RULE]);
    // 上限本身是允许的（后端是「> 上限才拒」）
    expect(
      validateConditionRows(rows.slice(0, MAX_POINTS_PER_RULE), options).some(
        (issue) => issue.key === 'page.iot.alert.rule.condition.tooMany',
      ),
    ).toBe(false);
  });

  it('🔴 同一点位重复**不再**被拦：真 AND 下是合法条件组（同一读数 > 80 且 < 100）', () => {
    const rows = [
      row({ operator: 'GT', propertyId: 'temperature', threshold: '80' }),
      row({ operator: 'LT', propertyId: 'temperature', threshold: '100' }),
    ];
    // 校验必须放行（去重键 R:ruleId:deviceId 不含 propertyId，两条条件各参与一次合取判定）
    expect(validateConditionRows(rows, options)).toEqual([]);
    // 且两行都进保存请求（不得借「重复」之名静默丢掉一行）
    expect(toConditionRequests(rows).map((item) => item.threshold)).toEqual([
      '80',
      '100',
    ]);
  });

  it('重复点位判据不依赖 trim 形态：带空格的同点位同样放行（不再比较 propertyId）', () => {
    expect(
      validateConditionRows(
        [
          row({ operator: 'GT', propertyId: ' temperature ', threshold: '80' }),
          row({ operator: 'LT', propertyId: 'temperature', threshold: '10' }),
        ],
        options,
      ),
    ).toEqual([]);
  });
});

describe('isDecimalText：与后端 BigDecimal(raw.trim()) 同口径', () => {
  it('接受十进制写法与科学计数法', () => {
    for (const text of ['80', '80.5', '.5', '+1', '-3', '1e3', '1.5E-2', 80]) {
      expect(isDecimalText(text)).toBe(true);
    }
  });

  it('拒绝空串 / 文本 / 0x / NaN / Infinity', () => {
    for (const text of [
      '',
      '  ',
      '八十',
      '0x10',
      Number.NaN,
      Infinity,
      null,
      undefined,
    ]) {
      expect(isDecimalText(text as never)).toBe(false);
    }
  });
});
