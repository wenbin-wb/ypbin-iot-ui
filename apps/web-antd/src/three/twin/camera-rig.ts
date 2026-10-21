import type * as THREE_NS from 'three';

/**
 * 相机操作（重置视角 / 聚焦某个锚点 / 自动巡航协调）。
 *
 * 与场景管理器的职责边界：管理器只负责「建相机、给初始视角」，本模块负责**运行期的相机
 * 动作**（用户点击锚点后飞过去、点「重置」回默认视角、长时间无交互后缓速环绕）。
 *
 * 飞行用位置插值 + smoothstep 缓动而不是直线穿过模型：直线穿过模型内部时会看到「穿过墙壁」
 * 的穿模感；插值同时移动 `controls.target` 让视线始终朝向目标，观感更稳。
 */

/** 相机飞行参数。 */
export interface FlyToOptions {
  /** 目标点（世界坐标）。 */
  target: { x: number; y: number; z: number };
  /** 与目标点的距离（世界单位）。 */
  distance: number;
  /** 飞行时长（毫秒）。 */
  durationMs?: number;
}

/** 默认飞行时长。 */
export const DEFAULT_FLY_DURATION_MS = 600;

/** 聚焦飞行时的俯视仰角（弧度；约 32°，接近参考图的「略俯视」机位）。 */
export const FOCUS_ELEVATION_RAD = (32 * Math.PI) / 180;

/**
 * 相机控制器：绑定到一个透视相机与 OrbitControls。
 */
export class CameraRig {
  private animationFrameId = 0;

  private camera: THREE_NS.PerspectiveCamera;

  private controls: import('three/addons/controls/OrbitControls.js').OrbitControls;

  /** 初始视角（重置时回到这里）。 */
  private homePosition: THREE_NS.Vector3;

  private homeTarget: THREE_NS.Vector3;

  /**
   * 进行中飞行的 resolve（**必须持有**）。
   *
   * 修复的缺陷：旧实现里 `cancelFly()` 只取消 rAF 帧，而 `flyTo` 的 Promise 再无别人
   * resolve ⇒ 新飞行打断旧飞行时，**旧 Promise 永远挂起**。调用方若 `await flyTo(...)`
   * 再改状态（例如：「飞行结束后关掉 loading」），那一行永远不执行。
   */
  private pendingResolve?: () => void;

  private THREE: typeof THREE_NS;

  constructor(
    THREE: typeof THREE_NS,
    camera: THREE_NS.PerspectiveCamera,
    controls: import('three/addons/controls/OrbitControls.js').OrbitControls,
  ) {
    this.THREE = THREE;
    this.camera = camera;
    this.controls = controls;
    this.homePosition = camera.position.clone();
    this.homeTarget = controls.target.clone();
  }

  /** 取消进行中的飞行（并 **resolve** 它的 Promise：被新飞行打断不是错误）。 */
  cancelFly(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = undefined;
    resolve?.();
  }

  /** 把当前相机位姿记为「初始视角」（每次进入场景后由页面调用）。 */
  captureHome(): void {
    this.homePosition = this.camera.position.clone();
    this.homeTarget = this.controls.target.clone();
  }

  /**
   * 飞向目标点。
   *
   * @param options 飞行参数
   * @returns 飞行完成时 resolved；被新的飞行/重置打断时也 resolved
   *          （「被打断」不是错误，调用方不需要区分）
   */
  async flyTo(options: FlyToOptions): Promise<void> {
    this.cancelFly();
    const duration = options.durationMs ?? DEFAULT_FLY_DURATION_MS;
    const startPosition = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const endTarget = new this.THREE.Vector3(
      options.target.x,
      options.target.y,
      options.target.z,
    );
    // 终点位置：沿「目标点 → 当前相机」方向、距离 distance。
    // 方向长度为 0 时（相机恰在目标点）用斜上方兜底，避免除零。
    const direction = startPosition.clone().sub(endTarget);
    if (direction.lengthSq() < 1e-6) {
      direction.set(1, 1, 1);
    }
    direction.normalize().multiplyScalar(options.distance);
    const endPosition = endTarget.clone().add(direction);

    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      this.pendingResolve = resolve;
      const tick = () => {
        const elapsed = performance.now() - startedAt;
        const t = Math.min(1, elapsed / duration);
        // smoothstep：起止速度为 0，中段快，观感比线性自然
        const eased = t * t * (3 - 2 * t);
        this.camera.position.lerpVectors(startPosition, endPosition, eased);
        this.controls.target.lerpVectors(startTarget, endTarget, eased);
        this.controls.update();
        if (t >= 1) {
          this.animationFrameId = 0;
          this.pendingResolve = undefined;
          resolve();
          return;
        }
        this.animationFrameId = requestAnimationFrame(tick);
      };
      this.animationFrameId = requestAnimationFrame(tick);
    });
  }

  /**
   * 立即设置机位（**无动画**：`prefers-reduced-motion` 下聚焦要用它，
   * 直接切过去而不是飞过去）。
   *
   * @param pose 机位
   */
  jumpTo(pose: {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
  }): void {
    this.cancelFly();
    this.camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.controls.target.set(pose.target.x, pose.target.y, pose.target.z);
    this.controls.update();
  }

  /** 重置到初始视角（瞬时，不飞行）。 */
  reset(): void {
    this.cancelFly();
    this.camera.position.copy(this.homePosition);
    this.controls.target.copy(this.homeTarget);
    this.controls.update();
  }

  /**
   * 计算「聚焦某点」的机位（**纯计算，不改相机**）。
   *
   * 机位取「略俯视 + 侧前方位」：参考图的构图是 30°~40° 俯视、带一点透视。
   * 方位沿用当前相机的水平朝向（不瞬间换边，避免飞行时绕大圈）。
   *
   * @param target 目标点（世界坐标）
   * @param distance 与目标的距离（世界单位）
   * @param elevationRad 俯视角（弧度，默认 {@link FOCUS_ELEVATION_RAD}）
   * @returns 相机应处的位置与观察目标
   */
  resolveFocusPose(
    target: { x: number; y: number; z: number },
    distance: number,
    elevationRad = FOCUS_ELEVATION_RAD,
  ): {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
  } {
    const toTarget = this.camera.position
      .clone()
      .sub(new this.THREE.Vector3(target.x, target.y, target.z));
    toTarget.y = 0;
    if (toTarget.lengthSq() < 1e-6) {
      toTarget.set(1, 0, 1);
    }
    toTarget.normalize();
    const horizontal = Math.cos(elevationRad) * distance;
    const vertical = Math.sin(elevationRad) * distance;
    return {
      position: {
        x: target.x + toTarget.x * horizontal,
        y: target.y + vertical,
        z: target.z + toTarget.z * horizontal,
      },
      target,
    };
  }
}
