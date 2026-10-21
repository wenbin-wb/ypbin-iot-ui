import { describe, expect, it, vi } from 'vitest';

import {
  createTwinAnimator,
  MAX_ACTIVE_CLIPS,
  selectAnimationClips,
} from './twin-animator';

/**
 * GLB 自带动画：选片策略 + mixer 生命周期（**反向验证**）。
 *
 * ## 反向验证
 *
 * 变异：把 `createTwinAnimator` 的 `dispose` 里 `mixer.stopAllAction()` 删掉
 * ⇒ 「★ 切场景必须 stopAllAction」用例红（替身 mixer 记录调用次数）。
 *
 * ## 为什么用替身而不是真实 three
 *
 * 真实 `AnimationMixer` 需要可绑定的场景图与 clip 轨道，且本文件要断言的是
 * 「调用时序」（dispose 时先 stop 再 uncache），替身记录调用序列比断言副作用更直接。
 */

/** 替身 mixer 记录。 */
interface MixerSpy {
  calls: string[];
  mixer: unknown;
  updateDeltas: number[];
}

/** 造一个替身 three（只含 AnimationMixer / LoopRepeat）。 */
function fakeThree(): { spy: MixerSpy; THREE: never } {
  const spy: MixerSpy = { calls: [], mixer: undefined, updateDeltas: [] };
  class AnimationMixer {
    constructor(public root: unknown) {
      spy.mixer = this;
    }
    clipAction(clip: { name: string }) {
      return {
        clampWhenFinished: false,
        play: () => {
          spy.calls.push(`play:${clip.name}`);
          return this;
        },
        setLoop: (loop: number, repeats: number) => {
          spy.calls.push(`setLoop:${clip.name}:${loop}:${repeats}`);
          return this;
        },
        stop: () => {
          spy.calls.push(`action.stop:${clip.name}`);
          return this;
        },
      };
    }
    stopAllAction() {
      spy.calls.push('stopAllAction');
    }
    uncacheClip(clip: { name: string }) {
      spy.calls.push(`uncacheClip:${clip.name}`);
    }
    uncacheRoot() {
      spy.calls.push('uncacheRoot');
    }
    update(delta: number) {
      spy.updateDeltas.push(delta);
    }
  }
  return {
    THREE: { AnimationMixer, LoopRepeat: 2201 } as never,
    spy,
  };
}

/**
 * 造一个 clip。
 *
 * 断言里只用到 `name`（选片策略按名字），而 `createTwinAnimator` 的参数类型是
 * `AnimationClip[]`；构造完整 AnimationClip 没有意义（替身 mixer 不读轨道），
 * 因此用 `as never` 显式声明「这是替身」。
 */
function clip(name: string): never {
  return { duration: 1, name, tracks: [] } as never;
}

describe('selectAnimationClips：按关键字挑选主循环', () => {
  it('★ 命中关键字的 clip 优先入选（conveyor/fan/idle）', () => {
    const clips = [
      clip('Armature|Action'),
      clip('Conveyor_Loop'),
      clip('Fan_Spin'),
    ];
    const { clips: selected, truncated } = selectAnimationClips<{
      name: string;
    }>(clips);
    expect(selected.map((item) => item.name)).toEqual([
      'Conveyor_Loop',
      'Fan_Spin',
      // 命中不足时按原顺序补齐：不按名字挑的模型也必须动起来
      'Armature|Action',
    ]);
    expect(truncated).toBe(0);
  });

  it('★ 没有任何关键字命中 ⇒ 仍选第一个（模型必须动起来，不能因为命名不规范就不播）', () => {
    const clips = [clip('Armature|Action'), clip('Clip_002')];
    const { clips: selected } = selectAnimationClips<{ name: string }>(clips);
    expect(selected[0]?.name).toBe('Armature|Action');
    expect(selected).toHaveLength(2);
  });

  it('超过上限时截断并报告数量（不静默丢弃）', () => {
    const clips = Array.from({ length: 20 }, (_, index) =>
      clip(`clip${index}`),
    );
    const { clips: selected, truncated } = selectAnimationClips(clips);
    expect(selected).toHaveLength(MAX_ACTIVE_CLIPS);
    expect(truncated).toBe(20 - MAX_ACTIVE_CLIPS);
  });

  it('空列表 ⇒ 空结果（不返回 null）', () => {
    expect(selectAnimationClips([])).toEqual({ clips: [], truncated: 0 });
  });
});

describe('★ createTwinAnimator：mixer 生命周期', () => {
  it('★ dispose 必须 stopAllAction + uncacheRoot（切场景防泄漏）', () => {
    const { THREE, spy } = fakeThree();
    const animator = createTwinAnimator(THREE, {} as never, [clip('idle')], 1);
    animator.dispose();
    expect(
      spy.calls,
      '★ 切场景必须调用 mixer.stopAllAction()，否则 mixer 仍持有已释放节点',
    ).toContain('stopAllAction');
    expect(spy.calls).toContain('uncacheRoot');
    expect(spy.calls).toContain('uncacheClip:idle');
    // 顺序：先 stop（停 action）再 uncache（清缓存）
    expect(spy.calls.indexOf('stopAllAction')).toBeLessThan(
      spy.calls.indexOf('uncacheRoot'),
    );
  });

  it('★ clipSpeed = 0 时 update 不推进 mixer（省 CPU），但仍保留 action（切回档位能继续播）', () => {
    const { THREE, spy } = fakeThree();
    const animator = createTwinAnimator(THREE, {} as never, [clip('fan')], 0);
    animator.update(1 / 60);
    animator.update(1 / 60);
    expect(spy.updateDeltas).toHaveLength(0);
    expect(spy.calls).toContain('play:fan');
    // 档位切回正常：继续播（不是「重新 play」）
    animator.setClipSpeed(1);
    animator.update(1 / 60);
    expect(spy.updateDeltas).toHaveLength(1);
  });

  it('reduced 档（1/3 速度）推进 mixer 时 delta 按倍率缩放', () => {
    const { THREE, spy } = fakeThree();
    const animator = createTwinAnimator(
      THREE,
      {} as never,
      [clip('fan')],
      1 / 3,
    );
    animator.update(0.06);
    expect(spy.updateDeltas[0]).toBeCloseTo(0.02, 6);
  });

  it('delta 上限 0.1s：切 tab 回来不会让动画「瞬移」到中间帧', () => {
    const { THREE, spy } = fakeThree();
    const animator = createTwinAnimator(THREE, {} as never, [clip('fan')], 1);
    animator.update(5);
    expect(spy.updateDeltas[0]).toBe(0.1);
  });

  it('dispose 幂等（重复调用不重复 stop）', () => {
    const { THREE, spy } = fakeThree();
    const animator = createTwinAnimator(THREE, {} as never, [clip('idle')], 1);
    animator.dispose();
    const countAfterFirst = spy.calls.filter(
      (c) => c === 'stopAllAction',
    ).length;
    animator.dispose();
    expect(spy.calls.filter((c) => c === 'stopAllAction').length).toBe(
      countAfterFirst,
    );
  });

  it('无 clip 的模型：hasClips=false，update 是空操作（不报错）', () => {
    const { THREE, spy } = fakeThree();
    const animator = createTwinAnimator(THREE, {} as never, [], 1);
    expect(animator.hasClips()).toBe(false);
    animator.update(1 / 60);
    expect(spy.updateDeltas).toHaveLength(0);
  });

  it('getActiveClipNames 反映实际播放的 clip（调试/观测用）', () => {
    const { THREE } = fakeThree();
    const animator = createTwinAnimator(
      THREE,
      {} as never,
      [clip('Conveyor_Loop'), clip('Armature|Action')],
      1,
    );
    expect(animator.getActiveClipNames()).toEqual([
      'Conveyor_Loop',
      'Armature|Action',
    ]);
  });

  it('超限时 console.warn 留痕（不静默丢弃）', () => {
    const { THREE } = fakeThree();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const clips = Array.from({ length: MAX_ACTIVE_CLIPS + 3 }, (_, index) =>
      clip(`clip${index}`),
    );
    createTwinAnimator(THREE, {} as never, clips, 1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
