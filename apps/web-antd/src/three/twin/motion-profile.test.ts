import { describe, expect, it } from 'vitest';

import {
  MOTION_SWITCHES,
  motionSwitches,
  readMotionProfileInput,
  reducedMotionMediaQuery,
  resolveMotionMode,
  WEAK_DEVICE_MEMORY_GB,
  WEAK_HARDWARE_CONCURRENCY,
} from './motion-profile';

/**
 * 动效档位（**纯函数**测试）。
 *
 * ## 为什么必须钉死在引擎层
 *
 * 「动效必须可降级」是硬约束：不满足时不是"不好看"，而是**对部分用户不可用**
 * （前庭障碍用户眩晕）与**对弱机型更糟**（脉冲 + 辉光把帧率拖到 10fps 以下）。
 * 而档位判定一旦散落在各处（渲染循环、标签层、后处理各判各的），
 * 就必然出现「关了脉冲但扩散环还在转」这种半降级 —— 所以判定只在本文件，
 * 渲染层只查 {@link MOTION_SWITCHES} 表。
 */

describe('resolveMotionMode：用户偏好优先于设备能力', () => {
  it('★ 偏好 reduce ⇒ reduced（即使机器很强）', () => {
    expect(
      resolveMotionMode({
        deviceMemory: 16,
        hardwareConcurrency: 16,
        prefersReducedMotion: true,
      }),
    ).toBe('reduced');
  });

  it('★ 偏好 reduce 优先于弱机型判定（reduced 而不是 off：降速播放仍保留信息）', () => {
    expect(
      resolveMotionMode({
        deviceMemory: 2,
        hardwareConcurrency: 2,
        prefersReducedMotion: true,
      }),
    ).toBe('reduced');
  });

  it(`★ 弱机型（<= ${WEAK_DEVICE_MEMORY_GB}GB 内存或 <= ${WEAK_HARDWARE_CONCURRENCY} 核）⇒ off`, () => {
    expect(resolveMotionMode({ deviceMemory: 2 })).toBe('off');
    expect(resolveMotionMode({ deviceMemory: WEAK_DEVICE_MEMORY_GB })).toBe('off');
    expect(resolveMotionMode({ hardwareConcurrency: 2 })).toBe('off');
    expect(resolveMotionMode({ hardwareConcurrency: WEAK_HARDWARE_CONCURRENCY })).toBe(
      'off',
    );
  });

  it('★ 未知 ≠ 弱：缺字段时按 normal（不能因为读不到就误关动效）', () => {
    expect(resolveMotionMode({})).toBe('normal');
    expect(resolveMotionMode({ deviceMemory: null, hardwareConcurrency: null })).toBe(
      'normal',
    );
    expect(resolveMotionMode({ deviceMemory: 0, hardwareConcurrency: 0 })).toBe(
      'normal',
    );
  });

  it('强机型且无偏好 ⇒ normal', () => {
    expect(
      resolveMotionMode({ deviceMemory: 8, hardwareConcurrency: 8 }),
    ).toBe('normal');
  });

  it('默认参数不抛错', () => {
    expect(['normal', 'off', 'reduced']).toContain(resolveMotionMode());
  });
});

describe('motion_switches：三档的开关语义', () => {
  it('★ off 档：自带动画倍率为 0，且所有节奏类动效关闭', () => {
    const off = MOTION_SWITCHES.off;
    expect(off.clipSpeed).toBe(0);
    expect(off.anchorPulse).toBe(false);
    expect(off.alertRipple).toBe(false);
    expect(off.autoOrbit).toBe(false);
    expect(off.scanRing).toBe(false);
    expect(off.valueFlash).toBe(false);
  });

  it('★ reduced 档：自带动画降速但不停（0 < speed < 1），持续运动关闭', () => {
    const reduced = MOTION_SWITCHES.reduced;
    expect(reduced.clipSpeed).toBeGreaterThan(0);
    expect(reduced.clipSpeed).toBeLessThan(1);
    expect(reduced.autoOrbit).toBe(false);
    expect(reduced.anchorPulse).toBe(false);
    expect(reduced.scanRing).toBe(false);
    // 一次性高亮不是持续运动，保留（承担「值变了」的信息）
    expect(reduced.valueFlash).toBe(true);
  });

  it('normal 档：全开，倍率为 1', () => {
    const normal = MOTION_SWITCHES.normal;
    expect(normal.clipSpeed).toBe(1);
    for (const key of [
      'alertRipple',
      'ambientDrift',
      'anchorPulse',
      'autoOrbit',
      'scanRing',
      'smoothLabels',
      'valueFlash',
    ] as const) {
      expect(normal[key]).toBe(true);
    }
  });

  it('★ 三档的键集合必须一致（新增开关时不允许漏配某一档）', () => {
    const keys = Object.keys(MOTION_SWITCHES.normal).toSorted();
    expect(Object.keys(MOTION_SWITCHES.reduced).toSorted()).toEqual(keys);
    expect(Object.keys(MOTION_SWITCHES.off).toSorted()).toEqual(keys);
  });

  it('motionSwitches() 返回对应档位（且是只读表）', () => {
    expect(motionSwitches('normal')).toBe(MOTION_SWITCHES.normal);
    expect(motionSwitches('off').clipSpeed).toBe(0);
  });
});

describe('readMotionProfileInput：唯一触碰 DOM 的入口', () => {
  it('从 matchMedia 读偏好，从 navigator 读能力', () => {
    const scope = {
      matchMedia: (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
      }),
      navigator: { deviceMemory: 8, hardwareConcurrency: 8 },
    } as unknown as typeof globalThis;
    expect(readMotionProfileInput(scope)).toEqual({
      deviceMemory: 8,
      hardwareConcurrency: 8,
      prefersReducedMotion: true,
    });
  });

  it('matchMedia 抛错/缺失时按「未要求减少」处理（不抛给调用方）', () => {
    const noMatchMedia = {
      navigator: {},
    } as unknown as typeof globalThis;
    expect(readMotionProfileInput(noMatchMedia).prefersReducedMotion).toBe(false);

    const throwing = {
      matchMedia: () => {
        throw new Error('boom');
      },
      navigator: {},
    } as unknown as typeof globalThis;
    expect(readMotionProfileInput(throwing).prefersReducedMotion).toBe(false);
  });
});

describe('reduced_motion_media_query：判据与监听共用同一个查询串', () => {
  it('返回 standard 的 reduce 查询（改主判据必须同步改监听）', () => {
    expect(reducedMotionMediaQuery()).toBe('(prefers-reduced-motion: reduce)');
  });

  it('readMotionProfileInput 用的正是这个查询串（避免两处漂移）', () => {
    const queries: string[] = [];
    const scope = {
      matchMedia: (query: string) => {
        queries.push(query);
        return { matches: true };
      },
      navigator: {},
    } as unknown as typeof globalThis;
    readMotionProfileInput(scope);
    expect(queries).toEqual([reducedMotionMediaQuery()]);
  });
});
