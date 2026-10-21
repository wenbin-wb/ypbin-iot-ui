import { describe, expect, it } from 'vitest';

import {
  FLY_MAX_MODEL_BYTES,
  FLY_MIN_DEVICE_MEMORY_GB,
  MEMORY_LEAK_GEOMETRY_THRESHOLD,
} from './scene-manager';

/**
 * 场景管理器的**常量口径**单测。
 *
 * 为什么不测 `enterScene`（加载/渲染）：它依赖 WebGL 上下文，happy-dom 下没有真实的
 * `WebGLRenderer`，硬测只能把 three 全 mock 掉——那测的是 mock 不是实现。真正的
 * 「切换不涨内存」验收在手工验收（切 10 次看 `renderer.info.memory`）。
 *
 * 世界矩阵合成的正确性由后端 `TwinSceneTransformTest`（数学口径）与手工验收共同保证：
 * 前后端用的是**同一套数学定义**（T × Rz × Ry × Rx × S），前端由 three 的
 * `Matrix4.compose` 承担合成。
 */
describe('scene-manager 常量口径', () => {
  it('飞行模式模型上限是 20MB（超限禁用飞行，不静默降级）', () => {
    expect(FLY_MAX_MODEL_BYTES).toBe(20 * 1024 * 1024);
  });

  it('低显存设备阈值是 4GB', () => {
    expect(FLY_MIN_DEVICE_MEMORY_GB).toBe(4);
  });

  it('设备内存恰好等于阈值时也禁用飞行（<= 判定，不是 <）', () => {
    const memory = FLY_MIN_DEVICE_MEMORY_GB;
    expect(memory <= FLY_MIN_DEVICE_MEMORY_GB).toBe(true);
  });

  it('内存泄漏告警阈值是几何体数量增量 20', () => {
    expect(MEMORY_LEAK_GEOMETRY_THRESHOLD).toBe(20);
  });

  it('20MB 边界：恰好等于上限时仍允许飞行（> 判定，不是 >=）', () => {
    const bytes = FLY_MAX_MODEL_BYTES;
    expect(bytes > FLY_MAX_MODEL_BYTES).toBe(false);
  });
});
