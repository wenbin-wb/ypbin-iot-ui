import { describe, expect, it } from 'vitest';

import {
  argKey,
  buildRuleSummary,
  channelCodes,
  isNumericText,
  isOfflineRule,
  operatorSymbol,
  repeatIntervalText,
  repeatIntervalUnitKey,
  resolveArgs,
  thresholdText,
} from './summary';

/**
 * 「人话预览」的用例（用户口径 ②③：一句话总结 + 合理默认 + 人话报错）。
 *
 * 为什么这些用例是「傻瓜式」的守门人：预览是用户**唯一**能回答「我这么配会发生什么」的地方；
 * 它一旦错（比如把「低于下限」说成「高于上限」、把 30 分钟说成 30 秒），用户会带着错误的预期保存规则，
 * 而页面、接口、后端校验**全都会通过**——错误只会在告警真的响或没响时才暴露。
 */

const base = {
  scopeType: 'POINT',
  deviceLabel: '演示设备',
  productLabel: '演示产品',
  propertyLabel: '温度',
  unit: '℃',
  operator: 'GT',
  threshold: '80',
  valueType: 'NUMERIC',
  triggerMode: 'CONSECUTIVE_COUNT',
  triggerThreshold: 3,
  repeatIntervalSec: 1800,
  channels: 'INBOX,EMAIL',
  notifyTargets: '1001,ops@example.com',
};

describe('人话预览 buildRuleSummary', () => {
  it('点位超上限：给出「温度 连续 3 次 > 80 ℃ 就告警，30 分钟内不重复通知」', () => {
    const summary = buildRuleSummary(base);
    expect(summary.ready).toBe(true);
    expect(summary.sentenceKey).toBe('page.iot.alert.summary.pointCount');
    // 参数顺序：点位名、次数、符号、阈值+单位、重复间隔数值、重复间隔单位键
    expect(summary.sentenceArgs[0]).toBe('温度');
    expect(summary.sentenceArgs[1]).toBe(3);
    expect(summary.sentenceArgs[2]).toBe('>');
    expect(summary.sentenceArgs[3]).toBe('80 ℃');
    expect(summary.sentenceArgs[4]).toBe('30');
    expect(summary.sentenceArgs[5]).toEqual(
      argKey('page.iot.alert.unit.minute'),
    );
  });

  it('点位低于下限：符号是 <（不能把方向说反）', () => {
    const summary = buildRuleSummary({ ...base, operator: 'LT', threshold: '10' });
    expect(summary.sentenceArgs[2]).toBe('<');
    expect(summary.sentenceArgs[3]).toBe('10 ℃');
  });

  it('持续模式：句式换成「持续 T 秒」，并说明需要时序库可查', () => {
    const summary = buildRuleSummary({
      ...base,
      triggerMode: 'DURATION',
      triggerThreshold: 300,
    });
    expect(summary.sentenceKey).toBe('page.iot.alert.summary.pointDuration');
    expect(summary.sentenceArgs[1]).toBe(300);
    expect(summary.expectations).toContain(
      'page.iot.alert.expect.durationNeedsSeries',
    );
  });

  it('立即模式：句式不含次数，且说明不会去查时序库', () => {
    const summary = buildRuleSummary({ ...base, triggerMode: 'IMMEDIATE' });
    expect(summary.sentenceKey).toBe('page.iot.alert.summary.pointImmediate');
    expect(summary.sentenceArgs[0]).toBe('温度');
    expect(summary.sentenceArgs[1]).toBe('>');
  });

  it('断档类（无阈值）：按作用域给出三套句式，并说明复用平台断档链路', () => {
    const device = buildRuleSummary({
      scopeType: 'DEVICE',
      deviceLabel: '演示设备',
      repeatIntervalSec: 600,
      channels: 'INBOX,EMAIL',
    });
    expect(device.sentenceKey).toBe('page.iot.alert.summary.offlineDevice');
    expect(device.sentenceArgs[0]).toBe('演示设备');
    expect(device.expectations).toContain(
      'page.iot.alert.expect.offlineReuseOutage',
    );

    const product = buildRuleSummary({
      scopeType: 'PRODUCT',
      productLabel: '演示产品',
      channels: 'INBOX',
    });
    expect(product.sentenceKey).toBe('page.iot.alert.summary.offlineProduct');

    const tenant = buildRuleSummary({
      scopeType: 'TENANT',
      channels: 'INBOX',
      repeatIntervalSec: 1800,
    });
    expect(tenant.sentenceKey).toBe('page.iot.alert.summary.offlineTenant');
    // 租户级没有「范围名」参数（模板是「本租户任意设备…{0} {1}内不重复通知」）
    expect(tenant.sentenceArgs).toHaveLength(2);
    expect(tenant.sentenceArgs[0]).toBe('30');
  });

  it('缺设备 / 缺点位 / 阈值不是数字 / 没配渠道 ⇒ 句子变成「还差什么」并给人话提示', () => {
    expect(buildRuleSummary({ ...base, deviceLabel: '' }).sentenceKey).toBe(
      'page.iot.alert.summary.needDevice',
    );
    expect(
      buildRuleSummary({ ...base, scopeType: 'PRODUCT', productLabel: '' })
        .sentenceKey,
    ).toBe('page.iot.alert.summary.needProduct');
    expect(buildRuleSummary({ ...base, propertyLabel: '' }).sentenceKey).toBe(
      'page.iot.alert.summary.needPoint',
    );
    const notNumber = buildRuleSummary({ ...base, threshold: '八十' });
    expect(notNumber.sentenceKey).toBe('page.iot.alert.summary.needNumber');
    expect(notNumber.ready).toBe(false);
    expect(notNumber.warnings[0]?.key).toBe(
      'page.iot.alert.warn.thresholdNotNumber',
    );
    expect(buildRuleSummary({ ...base, channels: '' }).sentenceKey).toBe(
      'page.iot.alert.summary.needChannel',
    );
  });

  it('非阻断提醒：持续 <60s、布尔点位用大小比较、没配收件人、规则被停用都要提示', () => {
    const durationShort = buildRuleSummary({
      ...base,
      triggerMode: 'DURATION',
      triggerThreshold: 30,
    });
    expect(durationShort.ready).toBe(true);
    expect(durationShort.warnings.map((item) => item.key)).toContain(
      'page.iot.alert.warn.durationShort',
    );

    const booleanGt = buildRuleSummary({
      ...base,
      valueType: 'BOOLEAN',
      operator: 'GT',
      threshold: '1',
    });
    expect(booleanGt.warnings.map((item) => item.key)).toContain(
      'page.iot.alert.warn.booleanOperator',
    );

    const noTargets = buildRuleSummary({ ...base, notifyTargets: '' });
    expect(noTargets.warnings.map((item) => item.key)).toContain(
      'page.iot.alert.warn.noTargets',
    );

    const disabled = buildRuleSummary({ ...base, enabled: false });
    expect(disabled.warnings.map((item) => item.key)).toContain(
      'page.iot.alert.warn.disabled',
    );
  });

  it('空句子绝不允许：任何输入下 sentenceKey 都非空（提示不能是空白）', () => {
    const cases = [
      base,
      { ...base, deviceLabel: '' },
      { ...base, threshold: 'abc' },
      { scopeType: 'DEVICE' },
      { scopeType: 'TENANT', channels: 'INBOX' },
    ];
    for (const item of cases) {
      expect(buildRuleSummary(item).sentenceKey).not.toBe('');
    }
  });
});

describe('人话预览的辅助函数', () => {
  it('操作符码转符号（未知码原样返回，不静默替换）', () => {
    expect(operatorSymbol('GTE')).toBe('>=');
    expect(operatorSymbol('LT')).toBe('<');
    expect(operatorSymbol('SOMETHING')).toBe('SOMETHING');
    expect(operatorSymbol()).toBe('');
  });

  it('重复间隔：秒转分钟、不足一分钟按秒（避免「0.5 分钟」）', () => {
    expect(repeatIntervalText(1800)).toBe('30');
    expect(repeatIntervalText(3600)).toBe('60');
    expect(repeatIntervalText(45)).toBe('45');
    expect(repeatIntervalText(0)).toBe('0');
    expect(repeatIntervalUnitKey(45)).toBe('page.iot.alert.unit.second');
    expect(repeatIntervalUnitKey(1800)).toBe('page.iot.alert.unit.minute');
  });

  it('数值校验：只认真实数字（空串/中文/NaN 都不是）', () => {
    expect(isNumericText('80')).toBe(true);
    expect(isNumericText('80.5')).toBe(true);
    expect(isNumericText(80)).toBe(true);
    expect(isNumericText('八十')).toBe(false);
    expect(isNumericText('')).toBe(false);
    expect(isNumericText(undefined)).toBe(false);
    expect(isNumericText('NaN')).toBe(false);
  });

  it('阈值+单位：没有单位时不追加空格', () => {
    expect(thresholdText('80', '℃')).toBe('80 ℃');
    expect(thresholdText('80', '')).toBe('80');
    expect(thresholdText(undefined, '℃')).toBe(' ℃');
  });

  it('渠道码解析与键参数翻译', () => {
    expect(channelCodes('INBOX, EMAIL')).toEqual(['INBOX', 'EMAIL']);
    expect(channelCodes('')).toEqual([]);
    expect(resolveArgs(['80', argKey('page.iot.alert.unit.minute')], (key) => `[${key}]`)).toEqual([
      '80',
      '[page.iot.alert.unit.minute]',
    ]);
  });

  it('断档类判定：无点位条件即为断档类', () => {
    expect(
      isOfflineRule({ id: '1', points: [] } as never),
    ).toBe(true);
    expect(
      isOfflineRule({ id: '1', points: [{ id: '2' }] } as never),
    ).toBe(false);
  });
});
