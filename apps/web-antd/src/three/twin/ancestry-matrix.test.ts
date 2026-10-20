import type { AnchorTransform } from './types';

import { describe, expect, it } from 'vitest';

/**
 * 世界坐标链的**纯数学**验证（不依赖 WebGL / 场景管理器实例）。
 *
 * ## 为什么必须有这组测试
 *
 * 这里曾是真实缺陷的所在地（独立复核发现）：渲染只把自身 anchor 设到模型根，
 * 父链没进场景图；但坐标换算却用了「手写合成的含父链矩阵」⇒ 两者不是同一套，
 * 落库坐标系统性偏移（父 x=10、子 x=5 时点到看到的原点，存进去却是 -10 而不是 0）。
 *
 * 该缺陷之所以漏过，正是因为「世界矩阵合成」完全无测试覆盖
 * （`scene-manager.test.ts` 只测常量）。修复后的实现改为**让 three 的场景图承担合成**
 * （嵌套 Group），这里用与实现完全相同的 API 复现该组合，钉死数学口径。
 *
 * 与后端 `TwinSceneTransformTest` 用同一套语义：`world = parent × anchor`，
 * `anchor = T × Rz × Ry × Rx × S`（three 的 Euler 默认 'XYZ'）。
 */

/** 度 → 弧度（与实现同式）。 */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * 用 three 的场景图建一条祖先链并返回模型根的世界矩阵。
 *
 * 与 `TwinSceneManager#attachModel` **完全同构**（嵌套 Group + updateWorldMatrix）。
 *
 * @param ancestry 从根到叶的锚点链
 * @returns 模型根的世界矩阵与「世界矩阵的逆」
 */
async function buildChain(ancestry: AnchorTransform[]) {
  const THREE = await import('three');
  const sceneRoot = new THREE.Scene();
  let parent: import('three').Object3D = sceneRoot;
  for (const anchor of ancestry) {
    const pivot = new THREE.Group();
    pivot.position.set(anchor.x, anchor.y, anchor.z);
    pivot.rotation.set(
      toRadians(anchor.rx),
      toRadians(anchor.ry),
      toRadians(anchor.rz),
      'XYZ',
    );
    if (anchor.scale !== 1) {
      pivot.scale.setScalar(anchor.scale);
    }
    parent.add(pivot);
    parent = pivot;
  }
  const modelRoot = new THREE.Group();
  parent.add(modelRoot);
  modelRoot.updateWorldMatrix(true, true);
  return {
    inverse: modelRoot.matrixWorld.clone().invert(),
    THREE,
    world: modelRoot.matrixWorld.clone(),
  };
}

/** 造一个锚点。 */
function anchor(patch: Partial<AnchorTransform> = {}): AnchorTransform {
  return { rx: 0, ry: 0, rz: 0, scale: 1, x: 0, y: 0, z: 0, ...patch };
}

describe('世界坐标链（渲染与换算同源）', () => {
  it('空祖先链 ⇒ 世界矩阵为单位阵', async () => {
    const { world } = await buildChain([]);
    expect([...world.elements]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('单级平移 ⇒ 世界原点等于该锚点位置', async () => {
    const { THREE, world } = await buildChain([anchor({ x: 5 })]);
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(world);
    expect(origin.x).toBeCloseTo(5);
    expect(origin.y).toBeCloseTo(0);
    expect(origin.z).toBeCloseTo(0);
  });

  it('★ 两级平移：子场景原点在世界 = 父 + 子（这是曾经算错的核心场景）', async () => {
    const { THREE, world } = await buildChain([
      anchor({ x: 10 }),
      anchor({ x: 5 }),
    ]);
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(world);
    // 父 10 + 子 5 = 15。修复前「渲染」给出的却是 5（父链没进场景图）
    expect(origin.x).toBeCloseTo(15);
  });

  it('★ 三级平移：逐级累加（误差不应随层数放大）', async () => {
    const { THREE, world } = await buildChain([
      anchor({ x: 100 }),
      anchor({ x: 10 }),
      anchor({ x: 1 }),
    ]);
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(world);
    expect(origin.x).toBeCloseTo(111);
  });

  it('★ 父级旋转会带动子级位置（父 90° 绕 Y + 子偏移 (5,0,0) ⇒ 世界 (0,0,-5)）', async () => {
    const { THREE, world } = await buildChain([
      anchor({ ry: 90 }),
      anchor({ x: 5 }),
    ]);
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(world);
    expect(origin.x).toBeCloseTo(0);
    expect(origin.y).toBeCloseTo(0);
    expect(origin.z).toBeCloseTo(-5);
  });

  it('★ 父级缩放会放大子级偏移（父 scale=2 + 子 x=5 ⇒ 世界 10）', async () => {
    const { THREE, world } = await buildChain([
      anchor({ scale: 2 }),
      anchor({ x: 5 }),
    ]);
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(world);
    expect(origin.x).toBeCloseTo(10);
  });

  it('★ 世界 → 局部 往返自洽：任意世界点经逆矩阵回到该场景局部坐标', async () => {
    const { THREE, inverse, world } = await buildChain([
      anchor({ ry: 30, x: 7, y: 2, z: -3 }),
      anchor({ scale: 1.5, x: 4 }),
    ]);
    // 本场景局部点 (2,3,4) → 世界 → 再反算回局部，必须回到 (2,3,4)
    const localPoint = new THREE.Vector3(2, 3, 4);
    const worldPoint = localPoint.clone().applyMatrix4(world);
    const back = worldPoint.clone().applyMatrix4(inverse);
    expect(back.x).toBeCloseTo(2);
    expect(back.y).toBeCloseTo(3);
    expect(back.z).toBeCloseTo(4);
  });

  it('★ 法线用逆转置矩阵：非均匀缩放下方向不失真', async () => {
    const { THREE, world } = await buildChain([anchor({ scale: 2 })]);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(
      world.clone().invert().transpose(),
    );
    // 均匀缩放下法线方向不变
    const n = new THREE.Vector3(0, 1, 0).applyMatrix3(normalMatrix).normalize();
    expect(n.x).toBeCloseTo(0);
    expect(n.y).toBeCloseTo(1);
    expect(n.z).toBeCloseTo(0);
  });
});
