import type { IotPointApi, IotThingModelApi } from '#/api/iot';

import { beforeEach, describe, expect, it } from 'vitest';

import type { SeriesQueryResult } from './series-utils';

import {
  buildChartModel,
  buildCsv,
  buildCsvRows,
  buildDetailRows,
  buildPointOptions,
  chartUnits,
  countOrphanPoints,
  csvCell,
  formatRangeLabel,
  formatSeriesTs,
  IOT_SERIES_MAX_SELECTED_POINTS,
  isValidPropertyId,
  loadSeriesPreferences,
  resolveModelHint,
  resolveSeriesRange,
  saveSeriesPreferences,
  seriesCsvFileName,
  toNumeric,
} from './series-utils';

/**
 * 历史曲线的规则单测。
 *
 * 挑的都是「写错也不会报错、只会安静给出错误结果」的分支：空时间范围的语义、
 * 点位标识的翻译、非数值点的断开、CSV 注入防护与毫秒精度。
 */

const NOW = 1_790_400_000_000;

function point(ts: number, value: null | string, quality = 'GOOD') {
  return { quality, ts, value };
}

function mapping(
  overrides: Partial<IotPointApi.PointMappingResp> &
    Pick<IotPointApi.PointMappingResp, 'propertyId'>,
): IotPointApi.PointMappingResp {
  return {
    addressType: 'holding',
    deviceId: '9300012',
    id: '9500011',
    rawAddress: 'holding:0',
    refType: 'property',
    rw: 'R',
    ...overrides,
  };
}

function property(
  overrides: Partial<IotThingModelApi.PropertyResp> &
    Pick<IotThingModelApi.PropertyResp, 'id' | 'identifier'>,
): IotThingModelApi.PropertyResp {
  return {
    accessMode: 'R',
    dataType: 'decimal',
    propertyName: overrides.identifier,
    serviceId: '9120001',
    ...overrides,
  };
}

function result(
  overrides: Partial<SeriesQueryResult> &
    Pick<SeriesQueryResult, 'points' | 'propertyId'>,
): SeriesQueryResult {
  return {
    error: '',
    name: overrides.propertyId,
    unit: '',
    ...overrides,
  };
}

describe('resolveSeriesRange', () => {
  it('快捷档位 = now - hours ~ now（不是空范围）', () => {
    expect(resolveSeriesRange('24h', {}, NOW)).toEqual({
      from: NOW - 24 * 3_600_000,
      to: NOW,
      unbounded: false,
    });
    expect(resolveSeriesRange('1h', {}, NOW).from).toBe(NOW - 3_600_000);
    expect(resolveSeriesRange('7d', {}, NOW).from).toBe(NOW - 168 * 3_600_000);
  });

  it('自定义档位原样透传', () => {
    expect(resolveSeriesRange('custom', { from: 100, to: 200 }, NOW)).toEqual({
      from: 100,
      to: 200,
      unbounded: false,
    });
  });

  it('自定义档位两侧都空 ⇒ unbounded（后端语义 = 最早的 N 个点，界面必须能识别）', () => {
    expect(resolveSeriesRange('custom', {}, NOW)).toEqual({
      from: undefined,
      to: undefined,
      unbounded: true,
    });
  });

  it('未知档位不静默发空范围，退回 24 小时', () => {
    const range = resolveSeriesRange('bogus' as never, {}, NOW);
    expect(range.unbounded).toBe(false);
    expect(range.from).toBe(NOW - 24 * 3_600_000);
  });
});

describe('buildPointOptions', () => {
  const properties = [
    property({
      id: '9130001',
      identifier: 'temperature',
      propertyName: '温度',
      unit: '°C',
    }),
    property({
      id: '9130002',
      identifier: 'humidity',
      propertyName: '湿度',
      dataType: 'int',
      unit: '%RH',
    }),
    property({
      id: '9130003',
      identifier: 'switchState',
      propertyName: '开关状态',
      dataType: 'bool',
      accessMode: 'RW',
    }),
  ];

  it('映射点位翻译成属性标识符，并带上可读名与单位', () => {
    const options = buildPointOptions(
      [mapping({ propertyId: '9130001' })],
      properties,
    );
    expect(options[0]).toMatchObject({
      identifier: 'temperature',
      mapped: true,
      orphan: false,
      propertyName: '温度',
      unit: '°C',
      value: 'temperature',
    });
  });

  it('未映射的属性也列出来（否则设备没配点位时下拉是空的，用户无法查询）', () => {
    const options = buildPointOptions([], properties);
    expect(options.map((item) => item.value)).toEqual([
      'temperature',
      'humidity',
      'switchState',
    ]);
    expect(options.every((item) => !item.mapped)).toBe(true);
  });

  it('物模型里找不到属性 ⇒ 孤儿点退回属性主键（后端对历史主键形态仍可查）', () => {
    const options = buildPointOptions(
      [mapping({ propertyId: '9139999', rawAddress: 'holding:9' })],
      properties,
    );
    const orphan = options.find((item) => item.orphan);
    expect(orphan).toMatchObject({
      identifier: '',
      orphan: true,
      rawAddress: 'holding:9',
      value: '9139999',
    });
  });

  it('命令类型的映射不进候选（access 只对属性点位写时序）', () => {
    const options = buildPointOptions(
      [mapping({ propertyId: '9130001', refType: 'command' })],
      properties,
    );
    expect(options.find((item) => item.value === 'temperature')?.mapped).toBe(
      false,
    );
    expect(options).toHaveLength(3);
  });

  it('同一标识符只保留一条（两条映射共享同一规范坐标，列两条只会画出重复曲线）', () => {
    const options = buildPointOptions(
      [
        mapping({ id: '1', propertyId: '9130001' }),
        mapping({ id: '2', propertyId: '9130001', rawAddress: 'holding:1' }),
      ],
      properties,
    );
    expect(options.filter((item) => item.value === 'temperature')).toHaveLength(
      1,
    );
  });

  it('多点位上限是个正数常量（多点位 = 前端扇出请求，不能无上限）', () => {
    expect(IOT_SERIES_MAX_SELECTED_POINTS).toBeGreaterThan(0);
  });
});

describe('resolveModelHint（物模型不可用要告警，不能让它显示成「无数据」）', () => {
  it('未绑产品 ⇒ noProduct（映射只能按属性主键查，多半查不到）', () => {
    expect(resolveModelHint(false, 0)).toBe('noProduct');
    expect(resolveModelHint(false, 6)).toBe('noProduct');
  });

  it('绑了产品但物模型没有属性 ⇒ emptyModel', () => {
    expect(resolveModelHint(true, 0)).toBe('emptyModel');
  });

  it('物模型可用 ⇒ 不告警', () => {
    expect(resolveModelHint(true, 6)).toBeNull();
  });

  it('解析不出标识符的点位个数用于「部分属性被删」这类物模型整体可用时的告警', () => {
    const properties = [
      property({ id: '9130001', identifier: 'temperature' }),
    ];
    const options = buildPointOptions(
      [
        mapping({ id: '1', propertyId: '9130001' }),
        mapping({ id: '2', propertyId: '9139999' }),
      ],
      properties,
    );
    expect(countOrphanPoints(options)).toBe(1);
    expect(countOrphanPoints([])).toBe(0);
  });
});

describe('toNumeric / formatSeriesTs / formatRangeLabel', () => {
  it('空值与非数值返回 null（曲线在这些点断开，而不是画成 0）', () => {
    expect(toNumeric('19.14')).toBe(19.14);
    expect(toNumeric('')).toBeNull();
    expect(toNumeric(null)).toBeNull();
    expect(toNumeric(undefined)).toBeNull();
    expect(toNumeric('ON')).toBeNull();
  });

  it('时间格式带毫秒（同一秒内的多条读数不能看起来一模一样）', () => {
    const text = formatSeriesTs(1_790_400_000_123);
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.123$/);
    expect(formatSeriesTs('not-a-number')).toBe('not-a-number');
  });

  it('时间范围缺一侧时显示为 ——', () => {
    expect(formatRangeLabel(undefined, NOW)).toContain('—');
    expect(formatRangeLabel(undefined, undefined)).toBe('');
  });
});

describe('buildChartModel / chartUnits', () => {
  const results = [
    result({
      propertyId: 'temperature',
      name: '温度',
      unit: '°C',
      points: [point(1, '1.5'), point(2, 'ON'), point(3, '2.5')],
    }),
    result({
      propertyId: 'humidity',
      name: '湿度',
      unit: '%RH',
      points: [point(1, '60')],
    }),
    result({
      propertyId: 'broken',
      name: '坏点位',
      error: '历史时序查询未启用',
      points: [],
    }),
  ];

  it('每个单位一条 Y 轴，量纲不同的曲线不共轴', () => {
    expect(chartUnits(results)).toEqual(['°C', '%RH']);
    const model = buildChartModel(results);
    expect(model.map((item) => item.yAxisIndex)).toEqual([0, 1]);
    expect(model[0]?.name).toBe('温度（°C）');
  });

  it('非数值点记为 null（断开），时间戳与值一一对应', () => {
    const model = buildChartModel(results);
    expect(model[0]?.data).toEqual([1.5, null, 2.5]);
    expect(model[0]?.timestamps).toEqual([1, 2, 3]);
  });

  it('失败的点位不进图（失败绝不能被画成 0 条数据）', () => {
    expect(buildChartModel(results)).toHaveLength(2);
  });

  it('点数过多时不画数据点符号', () => {
    const many = result({
      propertyId: 'p',
      points: Array.from({ length: 201 }, (_, index) => point(index, '1')),
    });
    expect(buildChartModel([many])[0]?.showSymbol).toBe(false);
  });
});

describe('buildDetailRows', () => {
  const results = [
    result({
      propertyId: 'temperature',
      points: [point(300, '3'), point(100, '1')],
    }),
    result({
      propertyId: 'humidity',
      points: [point(200, '2')],
    }),
  ];

  it('多点位混排按时刻升序（与后端升序一致）', () => {
    const detail = buildDetailRows(results);
    expect(detail.rows.map((row) => row.tsMillis)).toEqual([100, 200, 300]);
    expect(detail.total).toBe(3);
    expect(detail.truncated).toBe(false);
  });

  it('展示上限只截断渲染、不改变总数（CSV 仍导出全量）', () => {
    const detail = buildDetailRows(results, 2);
    expect(detail.rows).toHaveLength(2);
    expect(detail.total).toBe(3);
    expect(detail.truncated).toBe(true);
  });

  it('失败的结果不进明细', () => {
    const detail = buildDetailRows([
      result({
        propertyId: 'broken',
        error: '历史时序查询未启用',
        points: [],
      }),
    ]);
    expect(detail.total).toBe(0);
  });
});

describe('csvCell / buildCsv / buildCsvRows', () => {
  it('公式注入防护：以 = 或 @ 开头前置单引号', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });

  it('负数不当作公式（+/- 是合法的数值前缀）', () => {
    expect(csvCell('-1.5')).toBe('-1.5');
    expect(csvCell('+3')).toBe('+3');
  });

  it('RFC 4180 转义：逗号 / 引号 / 换行', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });

  it('CRLF 换行 + 表头', () => {
    expect(buildCsv(['t', 'v'], [['1', '2']])).toBe('t,v\r\n1,2');
  });

  it('单点位保持既有三列；多点位首列补点位（时间仍是毫秒精度）', () => {
    const single = result({
      propertyId: 'temperature',
      points: [point(1_790_400_000_123, '19.14')],
    });
    const ts = formatSeriesTs(1_790_400_000_123);
    expect(buildCsvRows([single], false)[0]).toEqual([ts, '19.14', 'GOOD']);
    expect(buildCsvRows([single], true)[0]).toEqual([
      'temperature',
      ts,
      '19.14',
      'GOOD',
    ]);
  });

  it('导出文件名把点位里的非安全字符换掉', () => {
    const name = seriesCsvFileName('9300012', ['temperature', 'a/b'], NOW);
    expect(name.startsWith('iot-series-9300012-temperature_a_b-')).toBe(true);
    expect(name.endsWith('.csv')).toBe(true);
  });
});

describe('isValidPropertyId', () => {
  it('与后端白名单一致', () => {
    expect(isValidPropertyId('temperature')).toBe(true);
    expect(isValidPropertyId('a.b:c-d_1')).toBe(true);
    expect(isValidPropertyId('温度')).toBe(false);
    expect(isValidPropertyId('has space')).toBe(false);
    expect(isValidPropertyId('')).toBe(false);
    expect(isValidPropertyId('a'.repeat(129))).toBe(false);
  });
});

describe('查询偏好记忆', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('写下再读回', () => {
    saveSeriesPreferences({ limit: 2000, rangeMode: '7d' });
    expect(loadSeriesPreferences()).toEqual({ limit: 2000, rangeMode: '7d' });
  });

  it('内容损坏时逐项退回默认（不让坏缓存把查询条件带偏）', () => {
    window.localStorage.setItem('iot-series-preferences', '{not json');
    expect(loadSeriesPreferences()).toEqual({});
    window.localStorage.setItem(
      'iot-series-preferences',
      JSON.stringify({ limit: 0, rangeMode: 'bogus' }),
    );
    expect(loadSeriesPreferences()).toEqual({});
  });
});
