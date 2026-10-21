/**
 * 动效档位（**纯函数，可单测，零依赖**；本文件的判据是动效降级的「单一真相」）。
 *
 * ## 为什么需要这一层
 *
 * 本次视觉改造给画布加了大量持续运动：锚点呼吸、告警扩散环、扫描光圈、相机巡航、
 * 环境光缓变、GLB 自带动画。它们让画面「活着」，但对两类用户是**负担甚至伤害**：
 *
 * 1. **前庭功能障碍/偏头痛用户**：操作系统里开了「减少动态效果」
 *    （`prefers-reduced-motion: reduce`）。这是**用户明确表达了意愿**，必须尊重——
 *    持续旋转/脉冲会引发不适，且不降级属于无障碍缺陷（WCAG 2.3.3）。
 * 2. **弱机型**：`navigator.deviceMemory <= 4`（GB）或 `hardwareConcurrency <= 4`（核）。
 *    每帧跑滤镜/多次绘制会把帧率打到 15fps 以下，**本来能用的页面反而变得像坏了**。
 *
 * ## 三档口径
 *
 * | 档位 | 含义 | 动效 |
 * |---|---|---|
 * | `normal` | 默认 | 全开 |
 * | `reduced` | 用户偏好「减少动态效果」 | 关脉冲/扩散环/扫描光圈/巡航/环境缓变；GLB 自带动画**降速到 1/3 继续播**（完全停会让「动起来」的需求失效）；数值跳变高亮**保留**（一次性动效，不属持续运动） |
 * | `off` | 弱机型 | 全关（`clipSpeed = 0`） |
 *
 * **优先级：用户偏好高于机型能力**。原因：机型弱只是「可能卡」，用户偏好是「明确要求」；
 * 前者可以靠降速/减负缓解，后者不能被技术参数覆盖。
 *
 * ## 为什么所有调用方只查 `motionSwitches(mode)`，不再自行判断
 *
 * 曾经的设计里每个模块各自判断「是否 reduce / 是否弱机型」，结果三处判据不一致：
 * 有的查 `matchMedia`、有的查 `navigator`，用户中途切换系统设置后只有部分动效停下
 * （画面上「一半在动一半不动」，比全开更奇怪）。现在判据只有 {@link resolveMotionMode}
 * 一处，开关表只有 {@link MOTION_SWITCHES} 一处。
 */

/** 动效档位。 */
export type TwinMotionMode = 'normal' | 'off' | 'reduced';

/** 判定动效档位所需的输入（全部可空：浏览器可能不提供这些字段）。 */
export interface MotionProfileInput {
  /** `navigator.deviceMemory`（GB，Chrome 系才有；Safari/Firefox 为 undefined）。 */
  deviceMemory?: null | number;
  /** `navigator.hardwareConcurrency`（逻辑核数）。 */
  hardwareConcurrency?: null | number;
  /** 是否命中 `prefers-reduced-motion: reduce`。 */
  prefersReducedMotion?: boolean;
}

/** 弱机型阈值：内存（GB）**小于等于**该值即视为弱机型。 */
export const WEAK_DEVICE_MEMORY_GB = 4;

/** 弱机型阈值：逻辑核数**小于等于**该值即视为弱机型。 */
export const WEAK_HARDWARE_CONCURRENCY = 4;

/** `reduced` 档下 GLB 自带动画的播放倍率（1/3：保留「在动」的感知，显著降低运动量）。 */
export const REDUCED_CLIP_SPEED = 1 / 3;

/** 某一档位下的动效开关表。 */
export interface MotionSwitches {
  /** 锚点呼吸/脉动（持续缩放＋透明度呼吸）。 */
  anchorPulse: boolean;
  /** 告警锚点的红色扩散环。 */
  alertRipple: boolean;
  /** 环境光/方向光强度缓慢缓变。 */
  ambientDrift: boolean;
  /** GLB 自带动画的播放倍率（0 ⇒ 不更新 mixer）。 */
  clipSpeed: number;
  /** 长时间无交互后的相机自动巡航。 */
  autoOrbit: boolean;
  /** 贴地的扫描光圈。 */
  scanRing: boolean;
  /** 标签避让位移的平滑过渡（关 ⇒ 直接跳到目标位，不做插值）。 */
  smoothLabels: boolean;
  /** 数值跳变瞬间的一次性高亮（**不属持续运动**，`reduced` 档也保留）。 */
  valueFlash: boolean;
}

/**
 * 三档开关表。
 *
 * `off` 保留 `valueFlash = true`：它是一次性的短促高亮（≤600ms），不产生持续运动，
 * 且是「数值变了」这一**信息**的载体——关掉会让用户错过状态变化。同理 `smoothLabels`
 * 在 `off` 档为 false（整屏标签插值在弱机型上是纯 CPU 浪费）。
 */
export const MOTION_SWITCHES: Readonly<Record<TwinMotionMode, MotionSwitches>> =
  Object.freeze({
    normal: Object.freeze({
      alertRipple: true,
      ambientDrift: true,
      anchorPulse: true,
      autoOrbit: true,
      clipSpeed: 1,
      scanRing: true,
      smoothLabels: true,
      valueFlash: true,
    }),
    off: Object.freeze({
      alertRipple: false,
      ambientDrift: false,
      anchorPulse: false,
      autoOrbit: false,
      clipSpeed: 0,
      scanRing: false,
      smoothLabels: false,
      valueFlash: true,
    }),
    reduced: Object.freeze({
      alertRipple: false,
      ambientDrift: false,
      anchorPulse: false,
      autoOrbit: false,
      clipSpeed: REDUCED_CLIP_SPEED,
      scanRing: false,
      smoothLabels: true,
      // 一次性动效，不算持续运动 ⇒ 保留
      valueFlash: true,
    }),
  });

/**
 * 取某一档位的开关表。
 *
 * @param mode 动效档位
 * @returns 该档位的开关表（只读）
 */
export function motionSwitches(mode: TwinMotionMode): MotionSwitches {
  // 防御：调用方可能从 JSON/URL 参数拿到任意字符串，未知档位按最保守的 off 处理
  return MOTION_SWITCHES[mode] ?? MOTION_SWITCHES.off;
}

/**
 * 是否命中「减少动态效果」偏好。
 *
 * 抽成独立导出而非内联：调用方（scene-manager）需要在 `matchMedia` 的 `change` 事件里
 * 用**同一个** media query 重建输入，两处字符串写死会漂移。
 *
 * @returns media query 字符串
 */
export function reducedMotionMediaQuery(): string {
  return '(prefers-reduced-motion: reduce)';
}

/**
 * 读浏览器环境输入（**唯一触碰 DOM/`navigator` 的函数**）。
 *
 * `scope` 参数是为了单测注入替身（不污染全局 `navigator`）。
 *
 * @param scope 全局对象（默认 `globalThis`）
 * @returns 判定输入（拿不到的字段为 undefined）
 */
export function readMotionProfileInput(
  scope: typeof globalThis = globalThis,
): MotionProfileInput {
  // `deviceMemory` 不在 TS 内置的 `Navigator` 类型里（非标准、Chrome 专有），
  // 用结构类型显式声明，避免 `any`。
  const navigatorLike = (
    scope as {
      navigator?: {
        deviceMemory?: number;
        hardwareConcurrency?: number;
      };
    }
  ).navigator;
  const matchMediaFn = (scope as { matchMedia?: typeof globalThis.matchMedia })
    .matchMedia;
  let prefersReducedMotion: boolean | undefined;
  if (typeof matchMediaFn === 'function') {
    try {
      prefersReducedMotion = matchMediaFn.call(
        scope,
        reducedMotionMediaQuery(),
      ).matches;
    } catch {
      // 部分环境（旧浏览器/测试沙箱）没有 matchMedia 或调用抛错：
      // 拿不到偏好 ≠ 偏好为 false，但也不能因此崩溃 —— 回落为「未设置」
      prefersReducedMotion = undefined;
    }
  }
  return {
    deviceMemory:
      typeof navigatorLike?.deviceMemory === 'number'
        ? navigatorLike.deviceMemory
        : undefined,
    hardwareConcurrency:
      typeof navigatorLike?.hardwareConcurrency === 'number'
        ? navigatorLike.hardwareConcurrency
        : undefined,
    prefersReducedMotion,
  };
}

/**
 * 判定动效档位。
 *
 * 顺序：**用户偏好优先** → 弱机型 → 默认 normal。
 *
 * 边界口径（全部用「小于等于」而不是「小于」）：
 * `deviceMemory = 4`（4GB 设备）、`hardwareConcurrency = 4`（4 核）**都属于弱机型**——
 * 这类机器上开满动效实测会掉到 15fps 级，而多核台式机普遍 ≥ 8。
 *
 * @param input 判定输入（缺省/字段缺失 ⇒ 视为未知，按有能力处理）
 * @returns 动效档位
 */
export function resolveMotionMode(input?: MotionProfileInput): TwinMotionMode {
  if (input?.prefersReducedMotion === true) {
    return 'reduced';
  }
  const memory = input?.deviceMemory;
  if (typeof memory === 'number' && memory <= WEAK_DEVICE_MEMORY_GB) {
    return 'off';
  }
  const cores = input?.hardwareConcurrency;
  if (typeof cores === 'number' && cores <= WEAK_HARDWARE_CONCURRENCY) {
    return 'off';
  }
  return 'normal';
}
