import { createApp } from 'vue';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  accessModeLabel,
  addressTypeLabel,
  dataFormatLabel,
  dataTypeLabel,
  displayOrFallback,
  formatDateTime,
  formatRelativeTime,
  maintenanceState,
  maintenanceStateLabel,
  modelStatusLabel,
  onlineStatusLabel,
  openApiScopeLabelKey,
  platformHealthRuleLabelKey,
  pointRefTypeLabel,
  prettyJson,
  protocolLabel,
  qualityLabel,
  serviceOptionLabel,
} from './display';

/**
 * 展示层纯函数的边界用例。
 *
 * 这里刻意加载**真实 i18n**（与页面同一条 `$t` 路径）：展示层返回值会直接渲染到界面，
 * 用桩替换 `$t` 只能证明调用成功，证明不了「键存在且能编译」。
 */
beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

describe('枚举码 → 展示文案', () => {
  it('协议码翻译为中文名称，未知码保留原码', () => {
    expect(protocolLabel('modbus')).toBe('Modbus TCP');
    expect(protocolLabel('TCP')).toBe('TCP 透传');
    expect(protocolLabel('opcua')).toBe('OPC UA');
    expect(protocolLabel('lorawan')).toBe('未知（lorawan）');
    expect(protocolLabel('')).toBe('-');
  });

  it('在线状态与物模型状态都有中文映射', () => {
    expect(onlineStatusLabel('online')).toBe('在线');
    expect(onlineStatusLabel('offline')).toBe('离线');
    expect(onlineStatusLabel('unknown')).toBe('未知');
    expect(modelStatusLabel('draft')).toBe('草稿');
    expect(modelStatusLabel('PUBLISHED')).toBe('已发布');
    expect(dataFormatLabel('BINARY')).toBe('二进制');
  });

  it('物模型/点位/服务枚举与读数质量都有中文映射', () => {
    expect(dataTypeLabel('date_time')).toBe('日期时间');
    expect(dataTypeLabel('JSON_OBJECT')).toBe('JSON 对象');
    expect(accessModeLabel('RW')).toBe('读写（RW）');
    expect(serviceOptionLabel('mandatory')).toBe('必选服务');
    expect(pointRefTypeLabel('command')).toBe('命令（command）');
    expect(addressTypeLabel('holding')).toBe('保持寄存器（holding）');
    expect(qualityLabel('NOT_CONNECTED')).toBe('未连接');
    expect(qualityLabel('bad')).toBe('坏值');
    expect(qualityLabel('mystery')).toBe('未知（mystery）');
  });

  it('平台规则码与开放作用域码不做动态拼键（未知码给专门文案）', () => {
    expect(platformHealthRuleLabelKey('PLATFORM_NOTIFY_FAILING')).toBe(
      'page.iot.platformAlert.ruleLabel.notifyFailing',
    );
    expect(platformHealthRuleLabelKey('PLATFORM_NOT_EXIST')).toBe(
      'page.iot.platformAlert.ruleLabel.unknown',
    );
    expect(openApiScopeLabelKey('iot:series:get')).toBe(
      'page.iot.openApiKey.scope.seriesGet',
    );
    expect(openApiScopeLabelKey('iot:nope')).toBe(
      'page.iot.openApiKey.scope.unknown',
    );
  });
});

describe('时间展示', () => {
  it('空值与非法值不输出 Invalid Date', () => {
    expect(displayOrFallback('')).toBe('-');
    expect(formatDateTime('')).toBe('-');
    expect(formatDateTime('not-a-date')).toBe('-');
    expect(formatDateTime(null)).toBe('-');
  });

  it('兼容后端两种时间形态：空格分隔与 ISO T 分隔', () => {
    expect(formatDateTime('2026-10-14 09:30:00')).toBe('2026-10-14 09:30:00');
    expect(formatDateTime('2026-10-14T09:30:00')).toBe('2026-10-14 09:30:00');
  });

  it('数字型时间按毫秒/秒解析（最新值 ts 是 epoch 毫秒）', () => {
    expect(formatDateTime(1_760_000_000_000)).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(formatDateTime('1760000000')).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('近期时间给相对人话，超过 30 天回落绝对时间', () => {
    const recent = Date.now() - 5 * 60 * 1000;
    expect(formatRelativeTime(recent)).toBe('5 分钟前');
    expect(formatRelativeTime(Date.now() - 3 * 60 * 60 * 1000)).toBe(
      '3 小时前',
    );
    expect(formatRelativeTime('2020-01-01 00:00:00')).toBe(
      '2020-01-01 00:00:00',
    );
  });

  it('维护窗口状态按起止时刻推导', () => {
    const past = '2020-01-01 00:00:00';
    const past2 = '2020-01-02 00:00:00';
    const future = '2999-01-01 00:00:00';
    expect(maintenanceState(past, past2)).toBe('ended');
    expect(maintenanceState(past, undefined)).toBe('ongoing');
    expect(maintenanceState(future, undefined)).toBe('upcoming');
    expect(maintenanceStateLabel(future, undefined)).toBe('未开始');
  });
});

describe('json 展示', () => {
  it('美化 JSON；非法 JSON 原样返回；空值给占位符', () => {
    expect(prettyJson('{"b":1,"a":2}')).toBe('{\n  "b": 1,\n  "a": 2\n}');
    expect(prettyJson('not-json')).toBe('not-json');
    expect(prettyJson('')).toBe('-');
  });
});
