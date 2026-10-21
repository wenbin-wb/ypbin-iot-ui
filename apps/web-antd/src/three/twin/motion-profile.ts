/**
 * 动效档位（**纯函数，可单测**）。
 *
 * ## 为什么需要一个显式的档位模型
 *
 * 「让模型动起来」与「不能影响可用性」是一对张力：
 * - 动效是工业监控场景里最直接的「系统还活着」的信号（数值在跳、告警在闪）；
 * - 但前庭功能障碍用户开启「减少动态效果」后，持续脉冲/环绕会引发不适
 *   （WCAG 2.3.3 Animation from Interactions / `prefers-reduced-motion`）；
 * - 弱机型（低内存/少核心）上，每帧的脉冲 + 辉光 + 巡航会把帧率拖垮，反而更不可用。
 *
 * 因此这里把「动效强度」收口成一个**三档枚举**，由两个输入共同决定：
 * 用户偏好（媒体查询，**优先级最高**）与设备能力（内存/核心数）。
 *
 * 档位语义：
 * - `off`：节奏类动效（脉冲、闪烁、扫描线、巡航、数值跳变高亮）**全部关闭**；
 *   静态表达保留（颜色、标签、布局）；GLB 自带动画**也停**（它是持续运动，最易引发不适）。
 * - `reduced`：关闭「持续运动」类（自带动画降速到约 1/3、巡航关闭、扫描光圈关闭），
 *   保留「状态变化」类（告警脉冲只闪不放大、数值跳变只做一次性高亮）。
 * - `normal`：全量动效。
 *
 * 注意：动效档位**不影响**功能可用性——标签、锚点、卡片与交互在任何档位都完全可用。
 */

/** 动效档位。 */
export type TwinMotionMode = 'normal' | 'off' | 'reduced';

/** 档位计算输入（刻意用普通对象，便于页面/测试注入，不依赖 DOM）。 */
export interface MotionProfileInput {
  /** `navigator.hardwareConcurrency`（未知传 undefined）。 */
  hardwareConcurrency?: null | number;
  /** `navigator.deviceMemory`（GB，未知传 undefined）。 */
  deviceMemory?: null | number;
  /** `matchMedia('(prefers-reduced-motion: reduce)').matches`。 */
  prefersReducedMotion?: boolean;
}

/** 设备内存阈值（GB）：`<= 4GB`（手机/低配平板/老笔记本）视为弱机型。 */
export const WEAK_DEVICE_MEMORY_GB = 4;

/** 逻辑核心阈值：`<= 4` 核视为弱机型（后处理与阴影同时吃 GPU 与 CPU）。 */
export const WEAK_HARDWARE_CONCURRENCY = 4;

/**
 * `reduced` 档下 GLB 自带动画的播放倍率。
 *
 * 为什么不是 0：自带动画是「模型还活着」的直观证据，降到 1/3 已能显著降低前庭刺激；
 * 完全停掉会让「减少动态效果」变成「模型死了」，反而丢失信息。
 */
export const REDUCED_CLIP_SPEED = 1 / 3;

/**
 * 计算动效档位。
 *
 * 优先级：**用户偏好 > 设备能力**。
 * 用户显式要求减少动效时必须尊重（即使机器很强）；机器弱时即使没开偏好也要降级。
 *
 * @param input 输入（全部可空：未知≠弱，未知时按不降级处理，避免误伤）
 * @returns 动效档位
 */
export function resolveMotionMode(
  input: MotionProfileInput = {},
): TwinMotionMode {
  if (input.prefersReducedMotion === true) {
    return 'reduced';
  }
  const memory = input.deviceMemory;
  const weakMemory =
    typeof memory === 'number' &&
    Number.isFinite(memory) &&
    memory > 0 &&
    memory <= WEAK_DEVICE_MEMORY_GB;
  const cores = input.hardwareConcurrency;
  const weakCores =
    typeof cores === 'number' &&
    Number.isFinite(cores) &&
    cores > 0 &&
    cores <= WEAK_HARDWARE_CONCURRENCY;
  return weakMemory || weakCores ? 'off' : 'normal';
}

/**
 * 「减少动态效果」的 media query 字符串。
 *
 * 抽成导出而不是各处内联：scene-manager 监听 `change` 时要用**同一个**查询串，
 * 两处写死会漂移（改了主判据但监听没改 ⇒ 用户中途切换设置后不生效）。
 *
 * @returns media query
 */
export function reducedMotionMediaQuery(): string {
  return '(prefers-reduced-motion: reduce)';
}

/**
 * 从 `window`/`navigator` 读取输入（**唯一触碰 DOM 的地方**，便于测试绕过）。
 *
 * @param scope 可注入的全局对象（默认 `globalThis`）
 * @returns 输入
 */
export function readMotionProfileInput(
  scope: typeof globalThis = globalThis,
): MotionProfileInput {
  const navigatorLike = scope.navigator as
    | undefined
    | { deviceMemory?: number; hardwareConcurrency?: number };
  let prefersReducedMotion: boolean;
  try {
    prefersReducedMotion =
      scope.matchMedia?.(reducedMotionMediaQuery()).matches ?? false;
  } catch {
    // 旧浏览器/非浏览器环境没有 matchMedia：按「未要求减少」处理（默认态）
    prefersReducedMotion = false;
  }
  return {
    deviceMemory: navigatorLike?.deviceMemory,
    hardwareConcurrency: navigatorLike?.hardwareConcurrency,
    prefersReducedMotion,
  };
}

/**
 * 各档位下的动效开关（**单一真相**：渲染层只查这张表，不再自己判断档位）。
 *
 * 为什么要表而不是一串 if：档位新增时（例如将来加 `cinematic`）只需改表，
 * 渲染层不会漏改某一处，避免出现「加了档位但某类动效没跟着关」的隐性缺陷。
 */
export interface MotionSwitches {
  /** 告警扩散环。 */
  alertRipple: boolean;
  /** 环境光/太阳的缓慢缓变。 */
  ambientDrift: boolean;
  /** 锚点呼吸/脉冲。 */
  anchorPulse: boolean;
  /** 相机自动巡航。 */
  autoOrbit: boolean;
  /** GLB 自带动画的播放倍率（0 = 不播放）。 */
  clipSpeed: number;
  /** 地面扫描光圈旋转。 */
  scanRing: boolean;
  /** 标签被挤压时的平滑过渡（关掉后直接跳到最终位置）。 */
  smoothLabels: boolean;
  /** 数值跳变的一次性高亮。 */
  valueFlash: boolean;
}

/** 档位 → 开关表。 */
export const MOTION_SWITCHES: Readonly<
  Record<TwinMotionMode, Readonly<MotionSwitches>>
> = Object.freeze({
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
    valueFlash: false,
  }),
  reduced: Object.freeze({
    alertRipple: false,
    ambientDrift: false,
    anchorPulse: false,
    autoOrbit: false,
    // 降速而不是停止：理由见 REDUCED_CLIP_SPEED
    clipSpeed: REDUCED_CLIP_SPEED,
    scanRing: false,
    smoothLabels: false,
    // 一次性高亮不是持续运动，保留（它承载「值变了」这一信息）
    valueFlash: true,
  }),
});

/**
 * 取档位对应的开关表。
 *
 * @param mode 档位
 * @returns 开关表（只读）
 */
export function motionSwitches(mode: TwinMotionMode): Readonly<MotionSwitches> {
  // 防御：调用方可能从 JSON/URL/接口拿到任意字符串，未知档位按最保守的 off 处理
  return MOTION_SWITCHES[mode] ?? MOTION_SWITCHES.off;
}
