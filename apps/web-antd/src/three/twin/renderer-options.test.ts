import type { TwinRendererOptions } from './renderer-options';

import { describe, expect, it } from 'vitest';

import {
  applyRendererOptions,
  DEFAULT_POST_OPTIONS,
  DEFAULT_RENDERER_OPTIONS,
  resolvePostOptions,
  resolveRendererOptions,
  resolveShadowCamera,
} from './renderer-options';

/**
 * 渲染器配置的**反向验证**（本仓硬要求）。
 *
 * ## 为什么这里必须用替身
 *
 * `init()` 需要真实 WebGL 上下文（happy-dom 没有），而历史上「测试全绿但功能无效」的
 * 典型形态正是：配置算对了、但没人把它写进 renderer。因此本文件做两件事：
 *
 * 1. `resolveRendererOptions` 的输出必须含正确的枚举值与显式布尔（防空配置）；
 * 2. `applyRendererOptions` 必须把每个字段**真的写到 renderer 上**（替身记录写入）。
 *
 * 变异验证（见 trackA-notes.md）：
 * - 把 `applyRendererOptions` 里 `shadowMap.enabled` 那行删掉 ⇒ 第 2 组用例红；
 * - 把 `toneMapping` 改回 `0`（NoToneMapping）⇒ 第 1、2 组都红。
 *
 * ## 为什么用「假 three 命名空间」而不是 mock 整个 three
 *
 * `resolveRendererOptions` 只读三个枚举常量，用只含这三个字段的对象即可，
 * 不必拉入 three 的整个模块图（快且不会因为替身缺方法而假失败）。
 */

/** 最小 three 替身：只含 renderer-options 用到的枚举。 */
const FAKE_THREE = {
  ACESFilmicToneMapping: 4,
  PCFSoftShadowMap: 2,
  SRGBColorSpace: 'srgb',
} as unknown as Parameters<typeof resolveRendererOptions>[0];

/** 记录属性写入的替身 renderer。 */
function fakeRenderer() {
  const writes: Record<string, unknown> = {};
  const renderer = {
    shadowMap: {
      get enabled() {
        return writes['shadowMap.enabled'] as boolean;
      },
      set enabled(value: boolean) {
        writes['shadowMap.enabled'] = value;
      },
      get type() {
        return writes['shadowMap.type'] as number;
      },
      set type(value: number) {
        writes['shadowMap.type'] = value;
      },
    },
    get outputColorSpace() {
      return writes.outputColorSpace as string;
    },
    set outputColorSpace(value: string) {
      writes.outputColorSpace = value;
    },
    get toneMapping() {
      return writes.toneMapping as number;
    },
    set toneMapping(value: number) {
      writes.toneMapping = value;
    },
    get toneMappingExposure() {
      return writes.toneMappingExposure as number;
    },
    set toneMappingExposure(value: number) {
      writes.toneMappingExposure = value;
    },
  };
  return { renderer, writes };
}

describe('★ resolveRendererOptions：关键开关的默认值', () => {
  it('★ 输出色彩空间 = sRGB、色调映射 = ACESFilmic、阴影开启且为软阴影', () => {
    const options = resolveRendererOptions(FAKE_THREE);
    expect(options.outputColorSpace).toBe('srgb');
    expect(options.toneMapping).toBe(4);
    expect(options.shadowMapEnabled).toBe(true);
    expect(options.shadowMapType).toBe(2);
    // 改造前这三项全是 three 默认值（NoToneMapping / 阴影关闭），正是「像 demo」的根因
  });

  it('曝光在合理区间（ACES 下 1.0 偏暗、>1.5 过曝）', () => {
    const { toneMappingExposure } = resolveRendererOptions(FAKE_THREE);
    expect(toneMappingExposure).toBeGreaterThanOrEqual(1);
    expect(toneMappingExposure).toBeLessThanOrEqual(1.5);
  });

  it('弱机型可覆盖为「关阴影」（其余关键开关不受影响）', () => {
    const options = resolveRendererOptions(FAKE_THREE, {
      shadowMapEnabled: false,
    });
    expect(options.shadowMapEnabled).toBe(false);
    // 关阴影不应连带把色调映射也关掉（那是两件事）
    expect(options.toneMapping).toBe(4);
  });

  it('默认配置不可变（防止运行时被改写导致三处不一致）', () => {
    expect(Object.isFrozen(DEFAULT_RENDERER_OPTIONS)).toBe(true);
  });
});

describe('★ applyRendererOptions：配置必须真的写进 renderer（替身记录写入）', () => {
  it('★ 五个字段全部落到 renderer 上', () => {
    const { renderer, writes } = fakeRenderer();
    const options: TwinRendererOptions = resolveRendererOptions(FAKE_THREE);
    applyRendererOptions(renderer as never, options);

    expect(writes.outputColorSpace, '★ 未写输出色彩空间').toBe('srgb');
    expect(writes.toneMapping, '★ 未写色调映射').toBe(4);
    expect(writes.toneMappingExposure).toBe(options.toneMappingExposure);
    expect(
      writes['shadowMap.enabled'],
      '★ 未写阴影开关（无阴影=建筑贴纸感）',
    ).toBe(true);
    expect(writes['shadowMap.type']).toBe(2);
  });

  it('关闭阴影时也显式写入 false（不是「不写」——默认值可能是 undefined）', () => {
    const { renderer, writes } = fakeRenderer();
    applyRendererOptions(
      renderer as never,
      resolveRendererOptions(FAKE_THREE, { shadowMapEnabled: false }),
    );
    expect(writes['shadowMap.enabled']).toBe(false);
  });
});

describe('resolveShadowCamera：阴影范围按模型尺度自适应', () => {
  it('★ 米级与毫米级模型拿到与尺度成比例的阴影相机（不是固定 ±100）', () => {
    const building = resolveShadowCamera({ x: 40, y: 20, z: 40 });
    const cabinet = resolveShadowCamera({ x: 0.4, y: 0.2, z: 0.4 });
    expect(building.extent).toBeGreaterThan(10);
    expect(cabinet.extent).toBeLessThan(1);
    expect(building.extent / cabinet.extent).toBeCloseTo(100, 0);
    // ★ bias 是**阴影贴图深度单位（世界单位）**，必须**不随模型尺寸放大**。
    //
    // 回归的是实测缺陷：旧实现 `bias = shadowBias * safe`，380m 园区上 bias 达 -0.19m
    // （比楼板还厚）⇒ 墙面/楼面出现随相机游走的暗斑，用户看到的就是「楼和地面都在闪」。
    expect(building.bias).toBe(cabinet.bias);
    expect(Math.abs(building.bias)).toBeLessThan(0.01);
    // normalBias 才按尺度缩放（沿法线推开采样点，防自阴影条纹）
    expect(building.normalBias).toBeGreaterThan(cabinet.normalBias);
    expect(building.normalBias).toBeGreaterThan(cabinet.normalBias);
  });

  it('退化输入（全 0 尺寸）不产生 NaN/0 范围', () => {
    const degenerate = resolveShadowCamera({ x: 0, y: 0, z: 0 });
    expect(Number.isFinite(degenerate.extent)).toBe(true);
    expect(degenerate.extent).toBeGreaterThan(0);
    expect(Number.isFinite(degenerate.far)).toBe(true);
  });
});

describe('★ resolvePostOptions：Bloom 必须克制（阈值调高、强度低）', () => {
  it('★ 阈值 >= 0.85（只让自发光与告警发光，建筑不许泛白）', () => {
    const options = resolvePostOptions();
    expect(options.bloomThreshold).toBeGreaterThanOrEqual(0.85);
  });

  it('★ 强度 <= 0.4（强度 1.0 是霓虹效果，会像「加了滤镜的 demo」）', () => {
    const options = resolvePostOptions();
    expect(options.bloomStrength).toBeGreaterThan(0);
    expect(options.bloomStrength).toBeLessThanOrEqual(0.4);
  });

  it('默认启用后处理与 FXAA；弱机型可整链关闭', () => {
    expect(DEFAULT_POST_OPTIONS.enabled).toBe(true);
    expect(DEFAULT_POST_OPTIONS.fxaa).toBe(true);
    expect(resolvePostOptions({ enabled: false }).enabled).toBe(false);
  });
});
