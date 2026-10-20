import { describe, expect, it } from 'vitest';

import { IotTwinApi } from '#/api/iot';

/**
 * 前端校验常量与后端 `TwinLimits` 的**同口径**。
 *
 * 这些常量必须与后端逐一相等：漂移会导致「前端放过、后端拒绝」（用户白填一遍表单）
 * 或反过来（前端拦住后端本可接受的输入）。与
 * `DEVICE_IMPORT_FRONTEND_LIMITS` ←→ `DeviceImportLimits` 的既有模式一致。
 */
describe('twinLimits 与后端同口径', () => {
  it('场景与点位上限', () => {
    expect(IotTwinApi.TWIN_LIMITS.maxSceneDepth).toBe(4);
    expect(IotTwinApi.TWIN_LIMITS.maxPointsPerScene).toBe(500);
    expect(IotTwinApi.TWIN_LIMITS.maxBindingsPerPoint).toBe(12);
  });

  it('文本长度上限', () => {
    expect(IotTwinApi.TWIN_LIMITS.maxSceneCodeLength).toBe(64);
    expect(IotTwinApi.TWIN_LIMITS.maxSceneNameLength).toBe(128);
    expect(IotTwinApi.TWIN_LIMITS.maxSceneRemarkLength).toBe(500);
    expect(IotTwinApi.TWIN_LIMITS.maxNodeNameLength).toBe(255);
    expect(IotTwinApi.TWIN_LIMITS.maxIconLength).toBe(64);
    expect(IotTwinApi.TWIN_LIMITS.maxPointRemarkLength).toBe(500);
    expect(IotTwinApi.TWIN_LIMITS.maxUnitLength).toBe(32);
    expect(IotTwinApi.TWIN_LIMITS.maxAssetNameLength).toBe(128);
    expect(IotTwinApi.TWIN_LIMITS.maxExternalUrlLength).toBe(1024);
  });

  it('数值与体积上限', () => {
    expect(IotTwinApi.TWIN_LIMITS.maxDecimals).toBe(6);
    expect(IotTwinApi.TWIN_LIMITS.maxViewJsonBytes).toBe(16 * 1024);
    expect(IotTwinApi.TWIN_LIMITS.maxModelBytes).toBe(64 * 1024 * 1024);
  });

  it('★ 场景编码正则与后端 TwinLimits.SCENE_CODE_PATTERN 等价', () => {
    const pattern = IotTwinApi.TWIN_LIMITS.sceneCodePattern;
    expect(pattern.test('B1-F3')).toBe(true);
    expect(pattern.test('b1_f3')).toBe(true);
    expect(pattern.test('b1 f3')).toBe(false);
    expect(pattern.test('')).toBe(false);
    expect(pattern.test('a'.repeat(65))).toBe(false);
    expect(pattern.test('a'.repeat(64))).toBe(true);
  });

  it('允许的模型扩展名', () => {
    expect([...IotTwinApi.TWIN_LIMITS.allowedModelExtensions]).toEqual([
      '.glb',
      '.gltf',
    ]);
  });
});
