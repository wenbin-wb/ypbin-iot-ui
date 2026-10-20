import type * as THREE_NS from 'three';

/**
 * 相机操作（重置视角 / 聚焦某个锚点）。
 *
 * 与场景管理器的职责边界：管理器只负责「建相机、给初始视角」，本模块负责**运行期的相机
 * 动作**（用户点击锚点后飞过去、点「重置」回默认视角）。
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

/** 相机控制器：绑定到一个透视相机与 OrbitControls。 */
export class CameraRig {
  private animationFrameId = 0;

  private camera: THREE_NS.PerspectiveCamera;

  private controls: import('three/addons/controls/OrbitControls.js').OrbitControls;

  /** 初始视角（重置时回到这里）。 */
  private homePosition: THREE_NS.Vector3;

  private homeTarget: THREE_NS.Vector3;

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

  /** 取消进行中的飞行。 */
  cancelFly(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
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
          resolve();
          return;
        }
        this.animationFrameId = requestAnimationFrame(tick);
      };
      this.animationFrameId = requestAnimationFrame(tick);
    });
  }

  /** 重置到初始视角（瞬时，不飞行）。 */
  reset(): void {
    this.cancelFly();
    this.camera.position.copy(this.homePosition);
    this.controls.target.copy(this.homeTarget);
    this.controls.update();
  }
}
