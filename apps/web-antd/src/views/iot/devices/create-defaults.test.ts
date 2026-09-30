import { describe, expect, it } from 'vitest';

import { buildCreateDeviceValues, resolveDeviceName } from './create-defaults';

/**
 * 创建设备默认值闭环纯逻辑用例（看板 #12）。
 */

describe('resolveDeviceName（设备名默认跟随编码）', () => {
  it('name 为空 → 取 code（闭环：只填编码即可）', () => {
    expect(resolveDeviceName('', 'dev-001')).toBe('dev-001');
    expect(resolveDeviceName(undefined, 'dev-001')).toBe('dev-001');
    expect(resolveDeviceName('  ', 'dev-001')).toBe('dev-001');
  });

  it('name 有值 → 保留（不覆盖用户输入）', () => {
    expect(resolveDeviceName('一号机', 'dev-001')).toBe('一号机');
    expect(resolveDeviceName(' 一号机 ', 'dev-001')).toBe('一号机');
  });

  it('两者都空 → 空串（让后端 @NotBlank 报错，不编造）', () => {
    expect(resolveDeviceName('', '')).toBe('');
    expect(resolveDeviceName(undefined, undefined)).toBe('');
  });
});

describe('buildCreateDeviceValues', () => {
  it('补齐 deviceName 且其余字段透传', () => {
    expect(
      buildCreateDeviceValues({
        deviceCode: 'dev-002',
        protocol: 'modbus',
        productId: '9',
        remark: 'x',
      }),
    ).toEqual({
      deviceCode: 'dev-002',
      protocol: 'modbus',
      productId: '9',
      remark: 'x',
      deviceName: 'dev-002',
    });
  });

  it('显式 deviceName 保留', () => {
    expect(
      buildCreateDeviceValues({ deviceCode: 'd', deviceName: '二号机' })
        .deviceName,
    ).toBe('二号机');
  });
});
