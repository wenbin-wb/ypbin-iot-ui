import { describe, expect, it } from 'vitest';

import {
  CAMERA_PRESET_IDS,
  CAMERA_PRESETS,
  isSamePose,
  resolveCameraPreset,
} from './camera-presets';

/**
 * 相机机位预设（**纯函数**测试）。
 *
 * 钉住的三条不变量：
 * 1. 三个预设的**俯视角严格递减**（俯视 > 等轴 > 侧视）——否则「切到俯视」看不出区别；
 * 2. 机位距离与模型尺寸**成正比**（毫米级模型不会飞到天上/钻进地里）；
 * 3. 机位始终在模型中心**上方**（y > center.y）——控制器的 `maxPolarAngle` 禁止到地面以下。
 */
const METRICS = {
  center: { x: 10, y: 2, z: -5 },
  maxDimension: 24,
};

describe('camera_presets', () => {
  it('★ 俯视角严格递减：俯视 > 等轴 > 侧视', () => {
    const top = CAMERA_PRESETS.top.elevationRad;
    const iso = CAMERA_PRESETS.iso.elevationRad;
    const side = CAMERA_PRESETS.side.elevationRad;
    expect(top).toBeGreaterThan(iso);
    expect(iso).toBeGreaterThan(side);
  });

  it('★ 机位距离与模型尺寸成正比（同预设下放大 10 倍 ⇒ 距离也放大 10 倍）', () => {
    const small = resolveCameraPreset('iso', METRICS);
    const big = resolveCameraPreset('iso', {
      ...METRICS,
      maxDimension: METRICS.maxDimension * 10,
    });
    const distance = (p: { x: number; y: number; z: number }) =>
      Math.hypot(
        p.x - METRICS.center.x,
        p.y - METRICS.center.y,
        p.z - METRICS.center.z,
      );
    expect(distance(big.position) / distance(small.position)).toBeCloseTo(
      10,
      5,
    );
  });

  it('★ 机位始终在模型中心上方（不会被地面裁掉）', () => {
    for (const id of CAMERA_PRESET_IDS) {
      const pose = resolveCameraPreset(id, METRICS);
      expect(pose.position.y).toBeGreaterThan(METRICS.center.y);
      expect(pose.target).toEqual(METRICS.center);
    }
  });

  it('缺尺寸时按 100 兜底（不产生 0/NaN 机位）', () => {
    const pose = resolveCameraPreset('iso', undefined);
    for (const value of Object.values(pose.position)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).not.toBe(0);
    }
  });

  it('isSamePose：同机位为 true，差一个模型尺寸为 false', () => {
    const a = resolveCameraPreset('iso', METRICS);
    const b = resolveCameraPreset('iso', METRICS);
    expect(isSamePose(a, b, METRICS.maxDimension)).toBe(true);
    const top = resolveCameraPreset('top', METRICS);
    expect(isSamePose(a, top, METRICS.maxDimension)).toBe(false);
    expect(isSamePose(undefined, a)).toBe(false);
  });
});
