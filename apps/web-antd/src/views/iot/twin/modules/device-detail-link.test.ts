import { describe, expect, it } from 'vitest';

import {
  buildDeviceDetailTarget,
  DEVICE_LEDGER_PATH,
} from './device-detail-link';

/**
 * 设备详情深链（工单 #127）。
 *
 * 钉住「复用既有 `?deviceId=` 约定」这件事本身：若将来有人改成
 * `/iot/devices/123` 这种路径参数形态，而设备台账页仍按 `?deviceId=` 读，
 * 从孪生页点进去就会打不开——这条测试会先红。
 */
describe('buildDeviceDetailTarget', () => {
  it('★ 复用既有约定：path 为设备台账页 + query.deviceId', () => {
    expect(buildDeviceDetailTarget('9300012')).toEqual({
      path: '/iot/devices',
      query: { deviceId: '9300012' },
    });
  });

  it('path 常量与既有设备台账路由一致', () => {
    expect(DEVICE_LEDGER_PATH).toBe('/iot/devices');
  });

  it('去除首尾空白（设备 id 来自接口，不应带空白）', () => {
    expect(buildDeviceDetailTarget('  9300012  ')?.query.deviceId).toBe(
      '9300012',
    );
  });

  it('★ 空 / null / undefined / 纯空白 ⇒ 不构造链接（不跳到空详情页）', () => {
    expect(buildDeviceDetailTarget(undefined)).toBeUndefined();
    expect(buildDeviceDetailTarget(null)).toBeUndefined();
    expect(buildDeviceDetailTarget('')).toBeUndefined();
    expect(buildDeviceDetailTarget('   ')).toBeUndefined();
  });

  it('点位的 deviceId 是字符串形态（后端 Long 序列化为字符串）', () => {
    // 若调用方误传 number，类型层已拦；这里确认字符串原样保留、不做数字转换
    expect(buildDeviceDetailTarget('1234567890123456789')?.query.deviceId).toBe(
      '1234567890123456789',
    );
  });
});
