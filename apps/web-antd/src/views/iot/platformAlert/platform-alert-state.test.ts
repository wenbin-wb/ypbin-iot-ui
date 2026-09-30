import { describe, expect, it } from 'vitest';

import {
  platformAlertSeverityColor,
  platformAlertSeverityLabelKey,
  platformAlertStateColor,
  platformAlertStateLabelKey,
  resolvePlatformAlertListState,
  snapshotLabel,
  tsLabel,
} from './platform-alert-state';

/** 平台告警纯逻辑用例（看板 #10 二批）。 */

describe('状态 label/color（与后端枚举对齐）', () => {
  it('三种状态与未知回落', () => {
    expect(platformAlertStateLabelKey('FIRING')).toBe(
      'page.iot.platformAlert.state.firing',
    );
    expect(platformAlertStateLabelKey('PENDING')).toBe(
      'page.iot.platformAlert.state.pending',
    );
    expect(platformAlertStateLabelKey('RESOLVED')).toBe(
      'page.iot.platformAlert.state.resolved',
    );
    expect(platformAlertStateLabelKey('BOGUS')).toBe(
      'page.iot.platformAlert.state.unknown',
    );
  });

  it('fIRING 红色（最需注意），RESOLVED 绿色', () => {
    expect(platformAlertStateColor('FIRING')).toBe('error');
    expect(platformAlertStateColor('PENDING')).toBe('warning');
    expect(platformAlertStateColor('RESOLVED')).toBe('success');
    expect(platformAlertStateColor()).toBe('default');
  });
});

describe('级别 label/color', () => {
  it('cRITICAL 标记 error 色', () => {
    expect(platformAlertSeverityLabelKey('CRITICAL')).toBe(
      'page.iot.platformAlert.severity.critical',
    );
    expect(platformAlertSeverityLabelKey('WARNING')).toBe(
      'page.iot.platformAlert.severity.warning',
    );
    expect(platformAlertSeverityLabelKey()).toBe(
      'page.iot.platformAlert.severity.unknown',
    );
    expect(platformAlertSeverityColor('CRITICAL')).toBe('error');
    expect(platformAlertSeverityColor('WARNING')).toBe('default');
  });
});

describe('resolvePlatformAlertListState（错误优先）', () => {
  it('加载中/错误/空/有数据', () => {
    expect(resolvePlatformAlertListState(true, '', 0)).toBe('loading');
    expect(resolvePlatformAlertListState(false, 'boom', 0)).toBe('error');
    expect(resolvePlatformAlertListState(false, '', 0)).toBe('empty');
    expect(resolvePlatformAlertListState(false, '', 2)).toBe('ready');
  });
});

describe('tsLabel / snapshotLabel', () => {
  it('时间空给 -', () => {
    expect(tsLabel('2026-10-05T00:00:00')).toBe('2026-10-05T00:00:00');
    expect(tsLabel(undefined)).toBe('-');
    expect(tsLabel('')).toBe('-');
  });

  it('指标快照：合法 JSON 对象紧凑化；空/非法原样', () => {
    expect(snapshotLabel(undefined)).toBe('-');
    expect(snapshotLabel('{not-json')).toBe('{not-json');
    expect(snapshotLabel('{"lag": 45000}')).toBe('{"lag":45000}');
  });
});
