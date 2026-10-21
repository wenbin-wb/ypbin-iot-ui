import { describe, expect, it } from 'vitest';

import {
  buildPropertyCard,
  classifyQuality,
  describeAge,
  formatCardValue,
  resolveCardStatus,
} from './property-card-model';

/**
 * 悬浮属性卡片的数据口径（**纯函数**测试）。
 *
 * ## 为什么这个文件的存在感这么强
 *
 * 「无数据显示 0」是本仓历史上出过的**语义级**缺陷（见 `runtime-store.ts` 与
 * `anchor-layer.ts` 里「显示 `--`，不是 0」的注释）：后端对从未上报的属性返回
 * `{ value: null, ts: null }`，前端一旦 `Number(null) ?? 0` 就会渲染成「0 ℃」，
 * 运维会把一台没数据的设备当成「温度正常」。卡片是**新增的信息入口**，
 * 如果口径不一，同一个属性会在标签与卡片上显示两个值 —— 比不显示更糟。
 *
 * 因此本文件钉住四条不变量：
 * 1. 无数据 ⇒ `valueText === undefined`（由 `.vue` 渲染成 `--`），**绝不**是 `'0'`；
 * 2. 主展示属性口径与 `runtime-store` 一致（primary 优先，否则第一条）；
 * 3. `stale`（值失效）与 `quality`（质量差）分别表达；
 * 4. 单位 `unitOverride` 优先。
 */

/** 造一个最简点位（只填本模块用到的字段）。 */
function point(overrides: {
  bindings: Parameters<typeof buildPropertyCard>[0]['point']['bindings'];
  deviceIdName?: string;
  id?: string;
  remark?: string;
}): Parameters<typeof buildPropertyCard>[0]['point'] {
  return {
    bindings: overrides.bindings,
    deviceId: '9300001',
    deviceIdName: overrides.deviceIdName ?? '演示设备',
    id: overrides.id ?? 'point-1',
    labelVisible: true,
    localX: '0',
    localY: '0',
    localZ: '0',
    normalX: '0',
    normalY: '1',
    normalZ: '0',
    remark: overrides.remark,
    sceneId: 'scene-1',
  };
}

/** 造一条绑定。 */
function binding(overrides: {
  decimals?: null | number;
  displayRole?: 'primary' | 'secondary';
  propertyIdentifier: string;
  propertyName: string;
  stale?: boolean;
  unit?: null | string;
  unitOverride?: null | string;
}): Parameters<typeof buildPropertyCard>[0]['point']['bindings'][number] {
  return {
    dataType: 'DOUBLE',
    decimals: overrides.decimals,
    displayRole: overrides.displayRole ?? 'secondary',
    displayType: 'value',
    id: `b-${overrides.propertyIdentifier}`,
    propertyIdentifier: overrides.propertyIdentifier,
    propertyName: overrides.propertyName,
    serviceIdentifier: 'svc',
    stale: overrides.stale ?? false,
    unitOverride: overrides.unitOverride,
    unit: overrides.unit,
  };
}

describe('formatCardValue：无数据必须是 undefined，不是 0', () => {
  it('null / undefined / 空串 ⇒ undefined（绝不渲染成 0）', () => {
    expect(formatCardValue(null, 1)).toBeUndefined();
    expect(formatCardValue(undefined, 1)).toBeUndefined();
    expect(formatCardValue('', 1)).toBeUndefined();
    expect(formatCardValue('   ', 1)).toBeUndefined();
  });

  it('★ 字符串 "0" 是**真实数据**，必须原样保留（与「没数据」区分）', () => {
    expect(formatCardValue('0', 0)).toBe('0');
    expect(formatCardValue('0', 2)).toBe('0.00');
  });

  it('按小数位格式化；非数字（枚举/布尔）不套小数位', () => {
    expect(formatCardValue('23.456', 1)).toBe('23.5');
    expect(formatCardValue('23', 0)).toBe('23');
    expect(formatCardValue('running', 1)).toBe('running');
    expect(formatCardValue('true', 2)).toBe('true');
  });
});

describe('classifyQuality：与 runtime-store 的 isGoodQuality 同口径', () => {
  it('无质量码 ⇒ unknown（不因为没报质量就判异常）', () => {
    expect(classifyQuality(null)).toBe('unknown');
    expect(classifyQuality(undefined)).toBe('unknown');
    expect(classifyQuality('')).toBe('unknown');
  });

  it('bad / uncertain 前缀 ⇒ bad（大小写不敏感）', () => {
    expect(classifyQuality('BAD')).toBe('bad');
    expect(classifyQuality('bad-value')).toBe('bad');
    expect(classifyQuality('uncertain')).toBe('bad');
  });

  it('其它 ⇒ good', () => {
    expect(classifyQuality('GOOD')).toBe('good');
    expect(classifyQuality('good')).toBe('good');
  });
});

describe('resolveCardStatus：优先级 停用 > 告警 > 在线 > 离线 > 未知', () => {
  it('停用优先于告警（停用设备不该继续闪告警）', () => {
    expect(
      resolveCardStatus({ alertCount: 3, onlineStatus: 'online', status: 0 }),
    ).toBe('disabled');
  });

  it('告警优先于在线', () => {
    expect(
      resolveCardStatus({ alertCount: 1, onlineStatus: 'online', status: 1 }),
    ).toBe('alert');
  });

  it('在线 / 离线 / 未知 / 未到达', () => {
    expect(
      resolveCardStatus({ alertCount: 0, onlineStatus: 'online', status: 1 }),
    ).toBe('normal');
    expect(
      resolveCardStatus({ alertCount: 0, onlineStatus: 'offline', status: 1 }),
    ).toBe('offline');
    expect(
      resolveCardStatus({ alertCount: 0, onlineStatus: 'unknown', status: 1 }),
    ).toBe('unknown');
    expect(resolveCardStatus(undefined)).toBe('unknown');
  });
});

describe('buildPropertyCard：组装全部绑定属性', () => {
  it('★ 无上报值 ⇒ valueText 为空（卡片渲染 --），且 hasAnyValue=false', () => {
    const model = buildPropertyCard({
      point: point({
        bindings: [
          binding({
            decimals: 1,
            displayRole: 'primary',
            propertyIdentifier: 'voltage',
            propertyName: '电压',
            unit: 'V',
          }),
        ],
      }),
      runtime: { alertCount: 0, onlineStatus: 'unknown', status: 1 },
      values: { voltage: { quality: null, stale: false, ts: null, value: null } },
    });
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]?.valueText).toBeUndefined();
    expect(model.rows[0]?.quality).toBe('missing');
    expect(model.hasAnyValue).toBe(false);
    // 单位仍然要展示（用户需要知道这个属性「本该」是什么单位）
    expect(model.rows[0]?.unit).toBe('V');
  });

  it('★ values 完全缺失（运行态未到）⇒ 同样按无数据处理，不抛错', () => {
    const model = buildPropertyCard({
      point: point({
        bindings: [
          binding({ propertyIdentifier: 'temperature', propertyName: '温度' }),
        ],
      }),
      runtime: undefined,
      values: undefined,
    });
    expect(model.rows[0]?.valueText).toBeUndefined();
    expect(model.rows[0]?.quality).toBe('missing');
    expect(model.cardStatus).toBe('unknown');
  });

  it('★ 主展示属性排第一（primary 优先，无 primary 取第一条）', () => {
    const withPrimary = buildPropertyCard({
      point: point({
        bindings: [
          binding({ propertyIdentifier: 'humidity', propertyName: '湿度' }),
          binding({
            propertyIdentifier: 'temperature',
            displayRole: 'primary',
            propertyName: '温度',
          }),
        ],
      }),
      runtime: { alertCount: 0, onlineStatus: 'online', status: 1 },
      values: {},
    });
    expect(withPrimary.rows.map((row) => row.propertyIdentifier)).toEqual([
      'temperature',
      'humidity',
    ]);
    expect(withPrimary.rows[0]?.primary).toBe(true);
    expect(withPrimary.rows[1]?.primary).toBe(false);

    const withoutPrimary = buildPropertyCard({
      point: point({
        bindings: [
          binding({ propertyIdentifier: 'humidity', propertyName: '湿度' }),
          binding({
            propertyIdentifier: 'temperature',
            propertyName: '温度',
          }),
        ],
      }),
      runtime: undefined,
      values: {},
    });
    // 与 runtime-store 同口径：没有 primary 时取第一条，并把它标为 primary 行
    expect(withoutPrimary.rows[0]?.propertyIdentifier).toBe('humidity');
    expect(withoutPrimary.rows[0]?.primary).toBe(true);
  });

  it('★ stale 与 quality 分别表达（可以并存）', () => {
    const model = buildPropertyCard({
      point: point({
        bindings: [
          binding({ propertyIdentifier: 'temperature', propertyName: '温度' }),
          binding({ propertyIdentifier: 'humidity', propertyName: '湿度' }),
        ],
      }),
      runtime: { alertCount: 0, onlineStatus: 'online', status: 1 },
      values: {
        // 值还在，但被标记为失效
        humidity: { quality: 'good', stale: true, ts: '1792574180929', value: '5' },
        // 值在，质量差
        temperature: { quality: 'BAD', stale: false, ts: '1792574180929', value: '99' },
      },
    });
    const byId = new Map(model.rows.map((row) => [row.propertyIdentifier, row]));
    expect(byId.get('humidity')?.valueStale).toBe(true);
    expect(byId.get('humidity')?.quality).toBe('stale');
    expect(byId.get('temperature')?.valueStale).toBe(false);
    expect(byId.get('temperature')?.quality).toBe('bad');
  });

  it('★ 单位：unitOverride 优先于 unit', () => {
    const model = buildPropertyCard({
      point: point({
        bindings: [
          binding({
            propertyIdentifier: 'temperature',
            propertyName: '温度',
            unit: '°C',
            unitOverride: '℃',
          }),
        ],
      }),
      runtime: undefined,
      values: {},
    });
    expect(model.rows[0]?.unit).toBe('℃');
  });

  it('格式化按绑定的小数位，时间戳解析为毫秒数', () => {
    const model = buildPropertyCard({
      point: point({
        bindings: [
          binding({
            decimals: 1,
            propertyIdentifier: 'temperature',
            propertyName: '温度',
            unit: '°C',
          }),
        ],
      }),
      runtime: { alertCount: 1, onlineStatus: 'online', status: 1 },
      values: {
        temperature: {
          quality: 'GOOD',
          stale: false,
          ts: '1792574180929',
          value: '23.46',
        },
      },
    });
    expect(model.rows[0]?.valueText).toBe('23.5');
    // 后端 ts 是 Long ⇒ 字符串；卡片里转成毫秒数（不做字符串比较）
    expect(model.rows[0]?.updatedAt).toBe(Number('1792574180929'));
    expect(model.hasAnyValue).toBe(true);
    expect(model.alertCount).toBe(1);
    expect(model.cardStatus).toBe('alert');
  });

  it('设备名缺失时回落到设备 ID（绝不显示空白标题）', () => {
    const model = buildPropertyCard({
      point: {
        ...point({ bindings: [] }),
        deviceIdName: '   ',
      },
      runtime: undefined,
      values: {},
    });
    expect(model.deviceName).toBe('9300001');
  });

  it('无绑定 ⇒ rows 为空（页面据此渲染「未绑定属性」提示，而不是空表）', () => {
    const model = buildPropertyCard({
      point: point({ bindings: [] }),
      runtime: { alertCount: 0, onlineStatus: 'online', status: 1 },
      values: {},
    });
    expect(model.rows).toEqual([]);
    expect(model.hasAnyValue).toBe(false);
  });
});

describe('describe_age：返回结构化相对时间（不含文案）', () => {
  /** 固定「现在」（避免用例依赖真实时钟）：2027-01-15 08:00 UTC。 */
  const NOW = 1_800_000_000_000;
  /** 1 秒 / 1 分钟 / 1 小时 / 1 天 的毫秒数。 */
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it('秒/分/时/天', () => {
    expect(describeAge(NOW - 5 * SECOND, NOW)).toEqual({
      count: 5,
      unit: 'second',
    });
    expect(describeAge(NOW - 90 * SECOND, NOW)).toEqual({
      count: 2,
      unit: 'minute',
    });
    expect(describeAge(NOW - 3 * HOUR, NOW)).toEqual({ count: 3, unit: 'hour' });
    expect(describeAge(NOW - 2 * DAY, NOW)).toEqual({ count: 2, unit: 'day' });
  });

  it('非法/缺失时间戳 ⇒ undefined（卡片显示 --，而不是 1970 年）', () => {
    expect(describeAge(undefined, NOW)).toBeUndefined();
    expect(describeAge(0, NOW)).toBeUndefined();
    expect(describeAge(Number.NaN, NOW)).toBeUndefined();
  });
});
