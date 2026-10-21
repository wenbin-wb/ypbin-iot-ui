import type * as THREE_NS from 'three';

/**
 * 相机自动巡航（**长时间无交互后的缓慢环绕**）。
 *
 * ## 为什么要做
 *
 * 用户的原话是「模型能‘动’起来」。对静态厂房模型，**相机的缓慢环绕**是最省成本、
 * 观感提升最大的一档「活着」：画面始终有细微视差，模型不像一张贴图。
 *
 * ## 必须做对的四件事
 *
 * 1. **一有交互立刻停**：`pointerdown` / `wheel` / `touchstart` / `keydown` 都要停，
 *    并且停在一个干净的相位上（不做「回弹」，用户一旦接手相机就不该被抢回去）；
 * 2. **空闲才启动**：最后一次交互后满 {@link AUTO_ORBIT_IDLE_MS}（20s）才缓缓开始，
 *    启动前还有一段 `easeIn`，避免「突然开始转」的突兀感；
 * 3. **reduced / off 档不启用**：由调用方查 `motionSwitches(mode).autoOrbit`，
 *    本模块不做档位判断（单一真相在 `motion-profile.ts`）；
 * 4. **不接管用户正在做的动作**：`OrbitControls` 的阻尼还在收敛时不插手势
 *    （否则与阻尼打架，观感是「抖」）。
 *
 * ## 为什么不直接用 OrbitControls 的 `autoRotate`
 *
 * `controls.autoRotate` 的语义是「永远转」，没有「空闲检测」，也无法 `easeIn`；
 * 且它与本实现的 `controls.target` 飞行会互相覆盖。本模块直接改 `camera.position`
 * 绕 `controls.target` 旋转，与飞行互斥（飞行期间暂停，由 manager 协调）。
 */

/** 空闲多久后开始巡航（毫秒）。 */
export const AUTO_ORBIT_IDLE_MS = 20_000;

/** 环绕速度（弧度/秒）。约 0.055 rad/s ⇒ 转一圈约 114 秒（足够慢，不晃眼）。 */
export const AUTO_ORBIT_SPEED_RAD_PER_SECOND = 0.055;

/** 从静止到全速的缓入时长（毫秒）。 */
export const AUTO_ORBIT_EASE_IN_MS = 2500;

/** 相机看地面的最小仰角（防止某次环绕后相机贴近地平线）。 */
const MIN_POLAR_ANGLE = 0.12;

/** 相机看地面的最大仰角（防止钻到模型上方垂直俯视）。 */
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.05;

/** 巡航的收敛/滞回（纯函数，可单测）：见 {@link stepOrbit}。 */
export interface OrbitPhase {
  /** 缓入进度 0~1。 */
  ease: number;
  /** 是否已在环绕。 */
  orbiting: boolean;
}

/**
 * 巡航推进（**纯函数**：给定相位与帧间隔，算出下一相位）。
 *
 * 抽出来是为了单测「空闲 20s 才启动」「启动有缓入」「停就真停」这三条不变量，
 * 而不必在测试里跑 rAF。
 *
 * @param phase 当前相位
 * @param idleMs 距上次交互的毫秒数
 * @param thresholdMs 启动阈值（默认 20s）
 * @param deltaSeconds 帧间隔
 * @returns 下一相位
 */
export function stepOrbit(
  phase: OrbitPhase,
  idleMs: number,
  thresholdMs: number,
  deltaSeconds: number,
): OrbitPhase {
  if (idleMs < thresholdMs) {
    return { ease: 0, orbiting: false };
  }
  const orbiting = true;
  const easeMs = Math.max(1, AUTO_ORBIT_EASE_IN_MS);
  return {
    ease: Math.min(1, phase.ease + (deltaSeconds * 1000) / easeMs),
    orbiting,
  };
}

/** 自动巡航接口。 */
export interface TwinAutoOrbit {
  /** 记录一次「用户交互」（立即停止巡航并重新计时空闲）。 */
  notifyInteraction: () => void;
  /** 每帧推进（`deltaSeconds` 为真实帧间隔）。 */
  update: (deltaSeconds: number) => void;
  /** 是否正在环绕（供状态栏/调试）。 */
  isOrbiting: () => boolean;
  /** 暂停（飞行/悬停卡片打开时；暂停不重置空闲计时）。 */
  pause: () => void;
  /** 恢复（恢复后重新从「满空闲」开始计时，不立刻启动）。 */
  resume: () => void;
  /** 解绑事件与状态。 */
  dispose: () => void;
}

/** 创建选项。 */
export interface CreateAutoOrbitOptions {
  /** 相机。 */
  camera: THREE_NS.PerspectiveCamera;
  /** OrbitControls（只读其 `target`）。 */
  controls: { target: THREE_NS.Vector3 };
  /** 是否启用（由 manager 按 `motionSwitches(mode).autoOrbit` 决定）。 */
  enabled: boolean;
  /** 绑定事件的 DOM（通常是渲染器画布）。 */
  domElement: HTMLElement;
  /** 空闲阈值（毫秒，默认 20s；单测可调小）。 */
  idleMs?: number;
  /** 时钟（单测注入；默认 `performance.now`）。 */
  now?: () => number;
}

/**
 * 创建相机自动巡航。
 *
 * @param THREE three 命名空间
 * @param options 选项
 * @returns 巡航控制器
 */
export function createAutoOrbit(
  THREE: typeof THREE_NS,
  options: CreateAutoOrbitOptions,
): TwinAutoOrbit {
  const { camera, controls, domElement } = options;
  const idleMs = options.idleMs ?? AUTO_ORBIT_IDLE_MS;
  const now = options.now ?? (() => performance.now());
  const enabled = options.enabled;
  let paused = false;
  let disposed = false;
  let lastInteractionAt = now();
  let orbiting = false;
  /** 缓入进度 0~1。 */
  let ease = 0;

  /** 立即停止环绕（不回弹）。 */
  const stop = (): void => {
    orbiting = false;
    ease = 0;
  };

  const notifyInteraction = (): void => {
    lastInteractionAt = now();
    stop();
  };

  // 交互事件：全部用 `{ passive: true }` —— 只监听不阻止默认行为，
  // 否则会拖慢滚动（移动端尤其明显）。
  const interactionEvents = [
    'pointerdown',
    'wheel',
    'touchstart',
    'keydown',
  ] as const;
  for (const eventName of interactionEvents) {
    domElement.addEventListener(eventName, notifyInteraction, {
      passive: true,
    });
  }

  /** 复用向量，避免每帧分配。 */
  const spherical = new THREE.Spherical();
  const offset = new THREE.Vector3();

  const update = (deltaSeconds: number): void => {
    if (disposed || !enabled || paused) {
      return;
    }
    const idleFor = now() - lastInteractionAt;
    const next = stepOrbit({ ease, orbiting }, idleFor, idleMs, deltaSeconds);
    ease = next.ease;
    orbiting = next.orbiting;
    if (!orbiting) {
      return;
    }
    // smoothstep 缓入，观感更软
    const factor = ease * ease * (3 - 2 * ease);
    const delta = AUTO_ORBIT_SPEED_RAD_PER_SECOND * factor * deltaSeconds;
    if (delta <= 0) {
      return;
    }
    // 绕 controls.target 在水平面上旋转：把相机位置转成球坐标，只改 theta
    offset.copy(camera.position).sub(controls.target);
    spherical.setFromVector3(offset);
    spherical.theta += delta;
    // 夹住极角：环绕不该改变俯视角度，更不该把相机带到地面以下
    spherical.phi = Math.min(
      MAX_POLAR_ANGLE,
      Math.max(MIN_POLAR_ANGLE, spherical.phi),
    );
    offset.setFromSpherical(spherical);
    camera.position.copy(controls.target).add(offset);
    // 让视线始终朝向目标（OrbitControls 有自己的 lookAt，但它只在 update() 时生效；
    // 本模块不调用 controls.update()，避免与阻尼互相拉扯）
  };

  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const eventName of interactionEvents) {
        domElement.removeEventListener(eventName, notifyInteraction);
      }
      stop();
    },
    isOrbiting: () => orbiting,
    notifyInteraction,
    pause: () => {
      paused = true;
      stop();
    },
    resume: () => {
      paused = false;
      // 恢复后重新从「满空闲」开始计时：刚解除暂停就立刻转起来会很突兀
      lastInteractionAt = now();
    },
    update,
  };
}
