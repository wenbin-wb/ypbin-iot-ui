import { describe, expect, it } from 'vitest';

import { worldNormalToSceneLocal, worldToSceneLocal } from './picker';

/**
 * 坐标换算（**纯数学，可脱离 WebGL 单测**）。
 *
 * 这些换算是「拾取结果是否正确落库」的唯一保证：算错方向会让点位保存到错误位置，
 * 而且只在父场景有旋转/缩放时才暴露（单位阵下所有换算都是恒等，测不出问题）。
 *
 * three 从真实包导入（math 部分不依赖 WebGL，happy-dom 下可用）。
 */
describe('worldToSceneLocal', () => {
  it('世界矩阵为单位阵时，局部坐标等于世界坐标', async () => {
    const THREE = await import('three');
    const local = worldToSceneLocal(new THREE.Matrix4(), THREE, {
      x: 1,
      y: 2,
      z: 3,
    });
    expect(local.x).toBeCloseTo(1);
    expect(local.y).toBeCloseTo(2);
    expect(local.z).toBeCloseTo(3);
  });

  it('世界矩阵含平移时正确反推（父场景在 (10,0,0)）', async () => {
    const THREE = await import('three');
    const world = new THREE.Matrix4().makeTranslation(10, 0, 0);
    const local = worldToSceneLocal(world, THREE, { x: 13, y: 2, z: 3 });
    expect(local.x).toBeCloseTo(3);
    expect(local.y).toBeCloseTo(2);
    expect(local.z).toBeCloseTo(3);
  });

  it('世界矩阵含缩放时正确反推（缩放 2 倍）', async () => {
    const THREE = await import('three');
    const world = new THREE.Matrix4().makeScale(2, 2, 2);
    const local = worldToSceneLocal(world, THREE, { x: 4, y: 6, z: 8 });
    expect(local.x).toBeCloseTo(2);
    expect(local.y).toBeCloseTo(3);
    expect(local.z).toBeCloseTo(4);
  });

  it('世界矩阵含 90° 绕 Y 轴旋转时正确反推', async () => {
    const THREE = await import('three');
    const world = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    // 绕 Y 轴 90°：(1,0,0) → (0,0,-1)
    const local = worldToSceneLocal(world, THREE, { x: 0, y: 0, z: -1 });
    expect(local.x).toBeCloseTo(1);
    expect(local.y).toBeCloseTo(0);
    expect(local.z).toBeCloseTo(0);
  });

  it('★ 复合变换（先平移再旋转）反推与正推互逆', async () => {
    const THREE = await import('three');
    const world = new THREE.Matrix4()
      .makeTranslation(5, 0, 0)
      .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
    // 正推：局部 (1,0,0) → 世界
    const forward = new THREE.Vector3(1, 0, 0).applyMatrix4(world);
    const back = worldToSceneLocal(world, THREE, {
      x: forward.x,
      y: forward.y,
      z: forward.z,
    });
    expect(back.x).toBeCloseTo(1);
    expect(back.y).toBeCloseTo(0);
    expect(back.z).toBeCloseTo(0);
  });
});

describe('worldNormalToSceneLocal', () => {
  it('单位阵时法线不变', async () => {
    const THREE = await import('three');
    const local = worldNormalToSceneLocal(new THREE.Matrix4(), THREE, {
      x: 0,
      y: 1,
      z: 0,
    });
    expect(local.x).toBeCloseTo(0);
    expect(local.y).toBeCloseTo(1);
    expect(local.z).toBeCloseTo(0);
  });

  it('★ 非均匀缩放下法线用逆转置矩阵（而非直接乘矩阵）', async () => {
    const THREE = await import('three');
    // 非均匀缩放：法线必须用逆转置，否则方向失真。
    // 场景：x 方向放大 2 倍，法线 (0,1,0) 应保持 (0,1,0)。
    const world = new THREE.Matrix4().makeScale(2, 1, 1);
    const local = worldNormalToSceneLocal(world, THREE, { x: 0, y: 1, z: 0 });
    expect(local.x).toBeCloseTo(0);
    expect(local.y).toBeCloseTo(1);
    expect(local.z).toBeCloseTo(0);
  });

  it('结果始终归一化', async () => {
    const THREE = await import('three');
    const world = new THREE.Matrix4().makeScale(3, 5, 7);
    const local = worldNormalToSceneLocal(world, THREE, { x: 1, y: 1, z: 1 });
    const length = Math.hypot(local.x, local.y, local.z);
    expect(length).toBeCloseTo(1);
  });
});
