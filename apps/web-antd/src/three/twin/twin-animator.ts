import type * as THREE_NS from 'three';

import type { LoadedModel } from './model-loader';

/**
 * GLB 自带动画（**让模型「动起来」**的第一档：模型作者做好的骨骼/节点动画）。
 *
 * ## 为什么需要
 *
 * 现状是模型加载后**完全静止**：传送带不转、风机不转、门不开关。即使模型本身带了
 * 动画（`gltf.animations` 非空，且 `model-loader.ts` 已经把 `animations` 取出来了），
 * 也没有任何代码消费它 ⇒ 用户看到的是「一张不会动的图」。
 *
 * ## 本条实现的策略
 *
 * 1. **多 clip**：按关键字挑选（`idle|loop|run|move|flow|conveyor|fan|spin|rotate|
 *    rotating`），挑中的第一个作为「主循环」；**没挑中则用第一个 clip**（多数导出工具的
 *    默认命名是 `Armature|Action`，按名字挑不中，但「第一个」通常就是作者想展示的动画）；
 *    其余 clip **同样循环播放**（多设备动画常常拆成多个 clip，只播第一个会让一半模型不动）；
 * 2. **播放倍率**：来自 `motionSwitches(mode).clipSpeed`（normal=1 / reduced=1/3 / off=0）；
 *    `0` 时**不调用 `mixer.update`**（省 CPU），但**不停 action** —— 档位切回来立刻继续播；
 * 3. **生命周期**：切场景必须 `stopAllAction()` + `uncacheRoot(root)` + `uncacheClip`，
 *    否则 mixer 内部仍持有对已 dispose 的骨骼/节点的引用（显存与内存双泄漏）。
 *
 * ## 为什么限制 clip 数量
 *
 * 有的模型带几十个 clip（每个设备一个），全部同时 `play()` 会让 CPU 每帧遍历几十条轨道。
 * 上限 {@link MAX_ACTIVE_CLIPS} = 8，超出按「先挑中的」截断，并 console.warn 留痕（不静默）。
 */

/** 主循环 clip 的关键字（小写匹配）。 */
const LOOP_KEYWORDS = [
  'idle',
  'loop',
  'run',
  'move',
  'flow',
  'conveyor',
  'fan',
  'spin',
  'rotate',
  'rotating',
  'cycle',
] as const;

/** 同时播放的 clip 上限。 */
export const MAX_ACTIVE_CLIPS = 8;

/** 动效管理器接口。 */
export interface TwinAnimator {
  /** 每帧推进（`deltaSeconds` 为真实帧间隔；档位为 off 时不调用本方法）。 */
  update: (deltaSeconds: number) => void;
  /** 当前播放倍率（0 = 暂停更新）。 */
  getClipSpeed: () => number;
  /** 设置播放倍率（由 scene-manager 在档位变化时调用）。 */
  setClipSpeed: (speed: number) => void;
  /** 是否有动画在播放（供状态栏/调试）。 */
  hasClips: () => boolean;
  /**
   * 动画当前是否**真的在推进**（有 clip 且播放倍率 > 0）。
   *
   * 与 {@link hasClips} 的区别：`hasClips` 只说明「模型带了动画、action 已创建」，
   * 而 `clipSpeed=0`（弱机型档位）时 mixer 每帧都不 update ⇒ 画面是静止的。
   * HUD/状态栏要展示「动画是否在动」必须用这个，否则会在弱机型上显示「播放中」而实际静止
   * ——这正是「说的和做的不一致」。
   */
  isRunning: () => boolean;
  /** 播放的 clip 名（调试/日志用）。 */
  getActiveClipNames: () => string[];
  /** 停止全部 action 并解绑（**切场景/销毁必须调用**）。 */
  dispose: () => void;
}

/**
 * 从动画列表里挑出要播放的 clip（**纯函数，可单测**）。
 *
 * 规则：
 * 1. 名字命中关键字的优先（保持原顺序），命中者全部入选；
 * 2. 命中不足时按原顺序补足（保证「一定有动画在播」）；
 * 3. 总数不超过 `maxClips`。
 *
 * @param clips 动画列表
 * @param maxClips 上限
 * @returns 选中的 clip 与是否因超限被截断
 */
export function selectAnimationClips<T extends { name: string }>(
  clips: T[],
  maxClips = MAX_ACTIVE_CLIPS,
): { clips: T[]; truncated: number } {
  if (clips.length === 0) {
    return { clips: [], truncated: 0 };
  }
  const matched = clips.filter((clip) =>
    LOOP_KEYWORDS.some((keyword) => clip.name.toLowerCase().includes(keyword)),
  );
  const selected: T[] = [];
  for (const clip of matched) {
    if (selected.length >= maxClips) {
      break;
    }
    selected.push(clip);
  }
  // 命中不足时按原顺序补：**不按名字挑**的模型也必须动起来
  for (const clip of clips) {
    if (selected.length >= maxClips) {
      break;
    }
    if (!selected.includes(clip)) {
      selected.push(clip);
    }
  }
  return {
    clips: selected,
    truncated: Math.max(0, clips.length - selected.length),
  };
}

/**
 * 创建动画管理器。
 *
 * @param THREE three 命名空间（调用方注入，避免本模块顶层 import）
 * @param root 模型根（AnimationMixer 的根；必须与 clip 的轨道命名同源）
 * @param clips 动画列表（来自 `LoadedModel.animations`）
 * @param initialSpeed 初始播放倍率（来自动效档位）
 * @returns 动画管理器
 */
export function createTwinAnimator(
  THREE: typeof THREE_NS,
  root: THREE_NS.Object3D,
  clips: LoadedModel['animations'],
  initialSpeed = 1,
): TwinAnimator {
  const mixer = new THREE.AnimationMixer(root);
  const { clips: selected, truncated } = selectAnimationClips(clips);
  if (truncated > 0) {
    console.warn(
      `[iot/twin] 模型自带动画共 ${clips.length} 个，超过上限 ${MAX_ACTIVE_CLIPS}，` +
        `仅播放前 ${selected.length} 个（其余不播，避免每帧遍历过多轨道）`,
    );
  }
  const actions = selected.map((clip) => {
    const action = mixer.clipAction(clip);
    // 循环播放：数字孪生的动画是「持续状态」，不是一次性演出
    action.setLoop(THREE.LoopRepeat, Number.POSITIVE_INFINITY);
    action.clampWhenFinished = false;
    action.play();
    return action;
  });
  let speed = initialSpeed;
  let disposed = false;

  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      // 顺序要紧：先停 action 再 uncache。只停不禁会把 track 绑定缓存留在 mixer 里，
      // 而 root 马上要被 disposeSubtree 释放 ⇒ 悬空引用。
      mixer.stopAllAction();
      for (const action of actions) {
        action.stop();
      }
      for (const clip of selected) {
        mixer.uncacheClip(clip);
      }
      mixer.uncacheRoot(root);
    },
    getActiveClipNames: () => selected.map((clip) => clip.name),
    getClipSpeed: () => speed,
    hasClips: () => selected.length > 0,
    isRunning: () => !disposed && speed > 0 && selected.length > 0,
    setClipSpeed: (next: number) => {
      speed = Number.isFinite(next) ? Math.max(0, next) : 0;
    },
    update: (deltaSeconds: number) => {
      if (disposed || speed <= 0 || selected.length === 0) {
        return;
      }
      // delta 上限 0.1s：切 tab 回来时 `requestAnimationFrame` 的 delta 可能几秒，
      // 直接推进会让动画「瞬移」到某个中间帧（观感突然跳变）
      const clamped = Math.min(deltaSeconds, 0.1);
      mixer.update(clamped * speed);
    },
  };
}
