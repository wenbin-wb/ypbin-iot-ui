import { describe, expect, it } from 'vitest';

import {
  MOTION_SWITCHES,
  motionSwitches,
  readMotionProfileInput,
  REDUCED_CLIP_SPEED,
  reducedMotionMediaQuery,
  resolveMotionMode,
  WEAK_DEVICE_MEMORY_GB,
  WEAK_HARDWARE_CONCURRENCY,
} from './motion-profile';

/**
 * 动效档位判定的单测（纯函数，无 DOM 依赖）。
 *
 * 覆盖：偏好优先、弱机型边界、未知字段、开关表一致性，以及「中途切换系统设置」时
 * 读到的输入会变化（scene-manager 依赖它重建档位）。
 */
describe('resolveMotionMode：用户偏好优先于机型能力', () => {
  it('★ 偏好 reduce ⇒ reduced，且优先于弱机型（强烈弱机型也是 reduced）', () => {
    expect(resolveMotionMode({ prefersReducedMotion: true })).toBe('reduced');
    expect(
      resolveMotionMode({
        deviceMemory: 1,
        hardwareConcurrency: 2,
        prefersReducedMotion: true,
      }),
      '用户偏好是明确要求，不能被机型参数覆盖',
    ).toBe('reduced');
  });

  it('偏好明确为 false 且机型正常 ⇒ normal', () => {
    expect(
      resolveMotionMode({
        deviceMemory: 8,
        hardwareConcurrency: 16,
        prefersReducedMotion: false,
      }),
    ).toBe('normal');
  });
});

describe('resolveMotionMode：弱机型降级', () => {
  it('★ deviceMemory = 4（边界，含）⇒ off', () => {
    expect(resolveMotionMode({ deviceMemory: 4 })).toBe('off');
    expect(resolveMotionMode({ deviceMemory: 4.5 })).toBe('normal');
  });

  it('★ hardwareConcurrency = 4（边界，含）⇒ off', () => {
    expect(resolveMotionMode({ hardwareConcurrency: 4 })).toBe('off');
    expect(resolveMotionMode({ hardwareConcurrency: 5 })).toBe('normal');
  });

  it('阈值常量口径与需求一致（4GB / 4 核）', () => {
    expect(WEAK_DEVICE_MEMORY_GB).toBe(4);
    expect(WEAK_HARDWARE_CONCURRENCY).toBe(4);
  });

  it('两个弱机型条件任一命中即降级（OR 关系）', () => {
    expect(
      resolveMotionMode({ deviceMemory: 2, hardwareConcurrency: 32 }),
    ).toBe('off');
    expect(
      resolveMotionMode({ deviceMemory: 32, hardwareConcurrency: 2 }),
    ).toBe('off');
  });
});

describe('resolveMotionMode：未知字段按「有能力」处理', () => {
  it('★ 不传输入 / 空对象 ⇒ normal（Safari 不提供 deviceMemory）', () => {
    expect(resolveMotionMode()).toBe('normal');
    expect(resolveMotionMode({})).toBe('normal');
    expect(
      resolveMotionMode({ deviceMemory: null, hardwareConcurrency: null }),
    ).toBe('normal');
  });

  it('nan/infinity 等非有限数不误判（防御脏输入）', () => {
    // NaN <= 4 为 false，不应命中弱机型分支
    expect(resolveMotionMode({ deviceMemory: Number.NaN })).toBe('normal');
    expect(resolveMotionMode({ hardwareConcurrency: Number.NaN })).toBe(
      'normal',
    );
  });
});

describe('mOTION_SWITCHES：三档开关表', () => {
  it('★ off.clipSpeed === 0 且 reduced.clipSpeed ∈ (0,1)（降速而非停止）', () => {
    expect(MOTION_SWITCHES.off.clipSpeed).toBe(0);
    expect(MOTION_SWITCHES.normal.clipSpeed).toBe(1);
    expect(MOTION_SWITCHES.reduced.clipSpeed).toBeGreaterThan(0);
    expect(MOTION_SWITCHES.reduced.clipSpeed).toBeLessThan(1);
    expect(MOTION_SWITCHES.reduced.clipSpeed).toBe(REDUCED_CLIP_SPEED);
  });

  it('reduced 关掉全部持续运动（脉冲/扩散环/扫描光圈/巡航/环境缓变）', () => {
    const switches = MOTION_SWITCHES.reduced;
    expect(switches.anchorPulse).toBe(false);
    expect(switches.alertRipple).toBe(false);
    expect(switches.scanRing).toBe(false);
    expect(switches.autoOrbit).toBe(false);
    expect(switches.ambientDrift).toBe(false);
  });

  it('★ reduced 保留标签平滑：它不是装饰，是防止「挤开标签瞬间跳位」引发阅读错乱', () => {
    // 与 Lead 在 motion-profile 契约里的口径一致（reduced 只关了 5 项持续运动），
    // 这里显式钉住，避免有人「顺手」把它也关掉导致标签抖动在下拉/缩放时更严重。
    expect(MOTION_SWITCHES.reduced.smoothLabels).toBe(true);
  });

  it('数值跳变高亮是一次性动效 ⇒ reduced 与 off 都保留（信息载体不能丢）', () => {
    expect(MOTION_SWITCHES.normal.valueFlash).toBe(true);
    expect(MOTION_SWITCHES.reduced.valueFlash).toBe(true);
    expect(MOTION_SWITCHES.off.valueFlash).toBe(true);
  });

  it('★ 三档的键集合完全一致（新加开关时不会漏配某一档）', () => {
    const keysOf = (value: object) => Object.keys(value).toSorted().join(',');
    const expected = keysOf(MOTION_SWITCHES.normal);
    expect(keysOf(MOTION_SWITCHES.reduced)).toBe(expected);
    expect(keysOf(MOTION_SWITCHES.off)).toBe(expected);
    // 防空跑：至少要覆盖需求里点名的这些开关
    for (const key of [
      'anchorPulse',
      'alertRipple',
      'ambientDrift',
      'clipSpeed',
      'autoOrbit',
      'scanRing',
      'smoothLabels',
      'valueFlash',
    ]) {
      expect(expected.split(',')).toContain(key);
    }
  });

  it('motionSwitches：合法档位返回对应表；未知字符串回落 off（不抛错）', () => {
    expect(motionSwitches('normal')).toBe(MOTION_SWITCHES.normal);
    expect(motionSwitches('reduced')).toBe(MOTION_SWITCHES.reduced);
    expect(motionSwitches('off')).toBe(MOTION_SWITCHES.off);
    expect(motionSwitches('bogus' as never)).toBe(MOTION_SWITCHES.off);
  });

  it('开关表不可变（防止运行时被意外改写导致三处判据漂移）', () => {
    expect(Object.isFrozen(MOTION_SWITCHES)).toBe(true);
    expect(Object.isFrozen(MOTION_SWITCHES.normal)).toBe(true);
  });
});

describe('readMotionProfileInput：唯一触碰 DOM 的入口', () => {
  it('★ 读取 matchMedia 与 navigator 字段（可注入替身，不污染全局）', () => {
    const input = readMotionProfileInput({
      matchMedia: (query: string) => ({
        matches: query === reducedMotionMediaQuery(),
      }),
      navigator: { deviceMemory: 2, hardwareConcurrency: 8 },
    } as never);
    expect(input).toEqual({
      deviceMemory: 2,
      hardwareConcurrency: 8,
      prefersReducedMotion: true,
    });
  });

  it('matchMedia 抛错/缺失 ⇒ 偏好为 undefined，不崩溃', () => {
    const noMedia = readMotionProfileInput({
      navigator: { deviceMemory: 8, hardwareConcurrency: 16 },
    } as never);
    expect(noMedia.prefersReducedMotion).toBeUndefined();
    expect(resolveMotionMode(noMedia)).toBe('normal');

    const throwing = readMotionProfileInput({
      matchMedia: () => {
        throw new Error('boom');
      },
      navigator: {},
    } as never);
    expect(throwing.prefersReducedMotion).toBeUndefined();
  });

  it('media query 字符串与首屏契约一致（change 监听复用同一字符串）', () => {
    expect(reducedMotionMediaQuery()).toBe('(prefers-reduced-motion: reduce)');
  });
});
