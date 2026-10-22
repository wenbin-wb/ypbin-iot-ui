import type * as THREE_NS from 'three';

/**
 * 渲染器/后处理配置（**纯函数，可单测**）。
 *
 * ## 为什么要把配置抽出来
 *
 * 改造前的渲染器只开了 `antialias: true`，其余全是 three 的默认值：
 *
 * | 项 | 缺省值 | 后果 |
 * |---|---|---|
 * | `outputColorSpace` | 已是 SRGB（three r152+ 默认），但**模型里手写的颜色**若按 sRGB 解释则偏灰 | 色彩发闷 |
 * | `toneMapping` | `NoToneMapping` | 高光直接裁切，金属/自发光一片死白 |
 * | `shadowMap.enabled` | `false` | 没有投影，建筑像「贴纸」，**这是「像 demo」的最大来源** |
 * | `scene.environment` | 无 | 金属材质没有反射，只能看到纯色 → 假 |
 *
 * 这些都是**一个字段就能改**的东西，但历史上从未被设置过，只靠「看代码觉得对」很容易
 * 漏掉或写错枚举值（例如把 `toneMapping` 写成字符串）。因此把它们收口成一个纯函数：
 * 单测可以直接断言数值，变异（改回旧值）必须让测试变红。
 *
 * ## 为什么不是直接写在 init 里
 *
 * `init()` 需要真实 WebGL 上下文，happy-dom 下跑不了；抽成纯函数后，本仓可以在
 * **无 GPU** 的 CI 里验证「关键开关确实被设置」。真正应用到 renderer 的那一行由
 * `applyRendererOptions` 提供，scene-manager 调用它并**另用替身 renderer** 断言调用了。
 */

/** 渲染器配置（与 three 的字段一一对应，值都是 three 的枚举常量数字/布尔）。 */
export interface TwinRendererOptions {
  /** 输出色彩空间（应为 `SRGBColorSpace`）。 */
  outputColorSpace: string;
  /** 色调映射（应为 `ACESFilmicToneMapping`）。 */
  toneMapping: number;
  /** 曝光（ACES 下 1.0 略暗，1.15 让暗部细节更清楚而不发灰）。 */
  toneMappingExposure: number;
  /** 是否开阴影。 */
  shadowMapEnabled: boolean;
  /** 阴影贴图类型（应为 `PCFSoftShadowMap`）。 */
  shadowMapType: number;
  /** 阴影贴图分辨率（像素，正方形）。 */
  shadowMapSize: number;
  /** 阴影相机半径（相对模型包围盒尺寸的倍数）。 */
  shadowCameraScale: number;
  /** 阴影深度偏移（防「漏光/阴影斑」）。 */
  shadowBias: number;
  /** 法线偏移（防自阴影噪点）。 */
  shadowNormalBias: number;
}

/**
 * 默认渲染器配置。
 *
 * 取值理由（全部经实测/官方文档口径）：
 *
 * - `ACESFilmicToneMapping`：three 官方示例中对「真实感场景」的默认选择，高光滚降自然；
 * - `toneMappingExposure = 1.1`：ACES 会把中灰压暗，1.1 让暗部可读又不过曝；
 * - `PCFSoftShadowMap`：`PCFShadowMap` 边缘硬、像游戏；软阴影才像建筑渲染。软阴影的
 *   代价是采样更多，因此 `shadowMapSize` 取 2048（桌面足够，4096 收益递减且吃显存）；
 * - `shadowBias = -0.0005` + `shadowNormalBias = 0.02`：建筑模型常见「薄墙 + 大尺度」，
 *   纯 bias 调小会出焦斑，补 normalBias 最稳（两者都用「模型包围盒尺寸」归一化后在
 *   应用时按比例换算，见 {@link resolveRendererOptions}）。
 */
export const DEFAULT_RENDERER_OPTIONS: Readonly<TwinRendererOptions> =
  Object.freeze({
    outputColorSpace: 'srgb',
    // 世界单位的深度偏移（three 默认 -0.0005 数量级；PCFSoft 下再调大会漏光）
    shadowBias: -0.0006,
    shadowCameraScale: 1,
    shadowMapEnabled: true,
    // 园区 380m 跨度：2048 贴合后每像素 ≈ extent*2/2048 ≈ 0.27m，足以消掉墙面暗斑
    shadowMapSize: 2048,
    shadowMapType: 2,
    shadowNormalBias: 0.02,
    toneMapping: 4,
    toneMappingExposure: 1.1,
  });

/** 后处理开关（Bloom 强度等；与渲染器配置分开：它依赖 EffectComposer 是否可用）。 */
export interface TwinPostOptions {
  /** 是否启用后处理链（弱机型关闭，直接 `renderer.render`）。 */
  enabled: boolean;
  /** Bloom 强度。 */
  bloomStrength: number;
  /** Bloom 半径。 */
  bloomRadius: number;
  /** Bloom 阈值（**调高**：只让自发光与告警点发光，建筑不许泛白）。 */
  bloomThreshold: number;
  /** 是否启用 FXAA（composer 输出为 LDR 后处理，MSAA 失效，靠 FXAA 补抗锯齿）。 */
  fxaa: boolean;
}

/**
 * 默认后处理配置。
 *
 * - `bloomThreshold = 0.9`：ACES 下建筑表面亮度普遍 < 0.8，只有自发光指示灯（暖金）
 *   与告警红点会越过阈值。阈值 0.7 会让整面墙轻微泛白（实测过，看起来像"加了滤镜的 demo"）；
 * - `bloomStrength = 0.3`：克制。1.0 是「霓虹」效果，这里只要「发光体有光晕」；
 * - `bloomRadius = 0.45`：中等扩散，半径过大整屏发雾。
 */
export const DEFAULT_POST_OPTIONS: Readonly<TwinPostOptions> = Object.freeze({
  bloomRadius: 0.45,
  bloomStrength: 0.3,
  bloomThreshold: 0.9,
  enabled: true,
  fxaa: true,
});

/**
 * 解析渲染器配置（纯函数：给定输入返回确定配置）。
 *
 * @param THREE three 命名空间（取枚举常量值，避免在本文件写魔法数字）
 * @param overrides 覆盖项（弱机型降级时关阴影/后处理）
 * @returns 最终配置
 */
export function resolveRendererOptions(
  THREE: typeof THREE_NS,
  overrides: Partial<TwinRendererOptions> = {},
): TwinRendererOptions {
  return {
    ...DEFAULT_RENDERER_OPTIONS,
    // 枚举值从 three 现取：写死数字会在 three 调整枚举后静默错位
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMapType: THREE.PCFSoftShadowMap,
    toneMapping: THREE.ACESFilmicToneMapping,
    ...overrides,
  };
}

/**
 * 把配置应用到渲染器（**唯一写 renderer 字段的地方**）。
 *
 * @param renderer 渲染器（或测试替身）
 * @param options 配置
 */
export function applyRendererOptions(
  renderer: THREE_NS.WebGLRenderer,
  options: TwinRendererOptions,
): void {
  renderer.outputColorSpace = options.outputColorSpace as never;
  renderer.toneMapping = options.toneMapping as never;
  renderer.toneMappingExposure = options.toneMappingExposure;
  renderer.shadowMap.enabled = options.shadowMapEnabled;
  renderer.shadowMap.type = options.shadowMapType as never;
}

/**
 * 由模型包围盒尺寸算阴影相机范围与偏移（**纯函数**：不同尺度的模型都能拿到合适阴影）。
 *
 * 建筑模型的坐标尺度差异极大（米级园区 vs 毫米级机柜）。固定 `±100` 的阴影相机会：
 * - 毫米级模型：整个模型只占阴影贴图的一个像素 ⇒ 阴影糊成一片；
 * - 千米级园区：模型远超阴影相机范围 ⇒ **完全没有阴影**（最常见的「阴影开了但看不见」）。
 * 所以范围必须按包围盒自适应。
 *
 * @param size 模型包围盒尺寸
 * @returns 阴影相机范围（半径）与归一化后的 bias
 */
export function resolveShadowCamera(
  size: { x: number; y: number; z: number },
  options: TwinRendererOptions = DEFAULT_RENDERER_OPTIONS,
): {
  /** 深度偏移（世界单位）。 */
  bias: number;
  /** 阴影相机半边长（世界单位）。 */
  extent: number;
  /** 远裁剪面（世界单位）。 */
  far: number;
  /** 法线偏移（世界单位）。 */
  normalBias: number;
} {
  const maxDimension = Math.max(size.x, size.y, size.z);
  const safe =
    Number.isFinite(maxDimension) && maxDimension > 0 ? maxDimension : 100;
  // 对角线的一半足够罩住旋转后的全部构件，再乘系数留余量
  const diagonal = Math.hypot(size.x, size.y, size.z) / 2;
  const extent = Math.max(
    (Number.isFinite(diagonal) && diagonal > 0 ? diagonal : safe) *
      options.shadowCameraScale,
    safe * 0.5,
  );
  return {
    // ⚠️ bias 是**阴影贴图深度单位**（世界单位），**不随模型尺寸放大**。
    //
    // 旧实现写成 `shadowBias * safe`：380m 园区上 bias = -0.0005 × 380 = **-0.19m**，
    // 比建筑薄墙/楼板还厚 ⇒ 阴影深度被系统性推偏，墙面/楼面出现**游走的暗斑**，
    // 相机一动就不断变化，看起来就是「楼和地面都在闪」（用户实测）。
    bias: options.shadowBias,
    // normalBias 才是「按模型尺度」的东西（沿法线推开采样点，避免自阴影条纹）

    extent,
    // 光源在数倍模型尺寸之外，远面要给足
    far: extent * 6,
    normalBias: options.shadowNormalBias * safe * 0.01,
  };
}

/**
 * 解析后处理配置。
 *
 * @param overrides 覆盖项
 * @returns 最终配置
 */
export function resolvePostOptions(
  overrides: Partial<TwinPostOptions> = {},
): TwinPostOptions {
  return { ...DEFAULT_POST_OPTIONS, ...overrides };
}
