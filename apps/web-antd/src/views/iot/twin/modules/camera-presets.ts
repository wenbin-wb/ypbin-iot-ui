/**
 * 相机机位预设（**纯函数，可单测**）。
 *
 * ## 为什么需要「预设」而不是只有自由旋转
 *
 * 自由旋转是功能，**可复现的构图才是专业感**：
 * - 演示/汇报时希望每次都是同一个「好看的机位」；
 * - 运维排查时希望一键切到「俯视看全局」或「贴地看设备」；
 * - 场景里存了 `view_json`（用户自定义机位）时，预设不应覆盖它——预设是**临时切换**，
 *   点「重置」要能回到场景配置的默认机位。
 *
 * ## 三种预设的口径
 *
 * | 预设 | 俯视角 | 方位 | 距离 | 用途 |
 * |---|---|---|---|---|
 * | 俯视 | 62° | 45° | 1.35×尺寸 | 看全局布局、快速找设备 |
 * | 等轴 | 35° | 45° | 1.9×尺寸 | 默认审美机位（接近参考图构图） |
 * | 侧视 | 12° | 90° | 2.0×尺寸 | 看立面细节（机柜正脸/管线） |
 *
 * 距离一律**相对模型尺寸**（`maxDimension`）：模型可能是米或毫米，
 * 写死世界单位会在另一种尺度上完全失效。
 */

/** 机位枚举。 */
export type CameraPresetId = 'iso' | 'side' | 'top';

/** 全部预设（顺序即界面上按钮的顺序）。 */
export const CAMERA_PRESET_IDS: readonly CameraPresetId[] = [
  'iso',
  'top',
  'side',
];

/** 单个预设的几何参数（与模型尺寸无关）。 */
export interface CameraPresetSpec {
  /** 俯视角（弧度）。 */
  elevationRad: number;
  /** 水平方位角（弧度）。 */
  azimuthRad: number;
  /** 距离系数（相对模型最大尺寸）。 */
  distanceRatio: number;
}

/** 预设参数表（唯一真相：改构图只改这里）。 */
export const CAMERA_PRESETS: Readonly<
  Record<CameraPresetId, CameraPresetSpec>
> = Object.freeze({
  iso: Object.freeze({
    azimuthRad: (45 * Math.PI) / 180,
    distanceRatio: 1.9,
    elevationRad: (35 * Math.PI) / 180,
  }),
  side: Object.freeze({
    azimuthRad: (90 * Math.PI) / 180,
    distanceRatio: 2,
    elevationRad: (12 * Math.PI) / 180,
  }),
  top: Object.freeze({
    azimuthRad: (45 * Math.PI) / 180,
    distanceRatio: 1.35,
    elevationRad: (62 * Math.PI) / 180,
  }),
});

/** 计算出的机位（世界坐标）。 */
export interface CameraPose {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

/**
 * 由「预设 + 模型尺度 + 观察中心」算出机位。
 *
 * @param presetId 预设
 * @param metrics 模型尺度（`getModelMetrics()` 的返回；缺尺寸时按 100 兜底）
 * @returns 机位（相对模型中心，世界坐标）
 */
export function resolveCameraPreset(
  presetId: CameraPresetId,
  metrics:
    | undefined
    | {
        center: { x: number; y: number; z: number };
        maxDimension: number;
      },
): CameraPose {
  const spec = CAMERA_PRESETS[presetId];
  const center = metrics?.center ?? { x: 0, y: 0, z: 0 };
  const size =
    metrics && Number.isFinite(metrics.maxDimension) && metrics.maxDimension > 0
      ? metrics.maxDimension
      : 100;
  const distance = size * spec.distanceRatio;
  const horizontal = Math.cos(spec.elevationRad) * distance;
  return {
    position: {
      x: center.x + Math.cos(spec.azimuthRad) * horizontal,
      y: center.y + Math.sin(spec.elevationRad) * distance,
      z: center.z + Math.sin(spec.azimuthRad) * horizontal,
    },
    target: { ...center },
  };
}

/**
 * 判断机位是否「看起来是同一个」（用于按钮选中态）。
 *
 * 容差按模型尺寸的比例给：绝对像素/世界单位在不同尺度模型上没有意义。
 *
 * @param a 当前机位
 * @param b 目标机位
 * @param maxDimension 模型最大尺寸
 * @returns 是否视为同一机位
 */
export function isSamePose(
  a: CameraPose | undefined,
  b: CameraPose | undefined,
  maxDimension = 100,
): boolean {
  if (!a || !b) {
    return false;
  }
  const tolerance = Math.max(1e-6, maxDimension * 0.08);
  const d = (
    p: { x: number; y: number; z: number },
    q: { x: number; y: number; z: number },
  ) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  return (
    d(a.position, b.position) <= tolerance && d(a.target, b.target) <= tolerance
  );
}
