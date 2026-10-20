import type * as THREE_NS from 'three';

import type { AnchorTransform } from './types';

/**
 * 锚点链 → 场景图（**纯函数，可脱离 WebGL 单测**）。
 *
 * ## 为什么单独抽出来
 *
 * 这里曾是真实缺陷的所在地：`attachModel` 只把**自身** anchor 设到模型根，父链从未进场景图，
 * 却又另外手写合成了一套「含父链」的世界矩阵去换算坐标 ⇒ 渲染位置与换算矩阵不是同一套，
 * 落库坐标系统性偏移（父 anchor x=10、子 anchor x=5 时，点到「画布上看到的原点」
 * 存进去是 (-10,0,0) 而不是 (0,0,0)）。
 *
 * 缺陷之所以漏过，是因为世界矩阵合成**完全没有测试覆盖**（`scene-manager.test.ts` 只测常量），
 * 而它又藏在需要 WebGL 的类里、无法直接单测。
 *
 * 抽成独立纯函数的收益：
 * 1. 单测能**直接调用生产代码**，而不是在测试里另写一份「同构实现」——
 *    后者是更强的假绿：测试自己重建一遍逻辑，实现改错了测试照样绿；
 * 2. `attachModel` 只负责「建出来的对象挂到哪儿」，变换数学只有这一处。
 *
 * ## 数学口径
 *
 * 沿 ancestry（根 → 叶，含自身）逐级套一层 anchor 变换，等价于：
 * ```
 * world(leaf) = anchor(root) × anchor(2nd) × … × anchor(leaf)
 * anchor      = T × Rz × Ry × Rx × S     （three 的 Euler 默认序 'XYZ'）
 * ```
 * 由 three 的场景图 `matrixWorld` 递归相乘实现，**不手写矩阵**——手写就是上述缺陷的来源。
 */

/** 度 → 弧度。 */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * 按锚点链建嵌套 Group 并返回「最深一级的父节点」。
 *
 * 调用方拿到返回值后把模型 `add` 进去即可；`modelRoot.matrixWorld` 随即等于
 * 锚点链的连乘积（需先 `updateWorldMatrix(true, true)`）。
 *
 * @param THREE three 命名空间（由调用方传入，避免本模块顶层 import 破坏分包）
 * @param sceneRoot 挂载根（通常是 Scene）
 * @param ancestry 从根到叶的锚点链（含自身）
 * @returns `parent`（最深一级容器）与 `pivots`（新建的各级 Group，供调用方后续移除）
 */
export function buildAncestryPivots(
  THREE: typeof THREE_NS,
  sceneRoot: THREE_NS.Object3D,
  ancestry: AnchorTransform[],
): { parent: THREE_NS.Object3D; pivots: THREE_NS.Object3D[] } {
  let parent: THREE_NS.Object3D = sceneRoot;
  const pivots: THREE_NS.Object3D[] = [];
  for (const anchor of ancestry) {
    const pivot = new THREE.Group();
    // 命名仅供调试识别（不参与任何逻辑判断）
    pivot.name = '__twin_anchor__';
    pivot.position.set(anchor.x, anchor.y, anchor.z);
    pivot.rotation.set(
      toRadians(anchor.rx),
      toRadians(anchor.ry),
      toRadians(anchor.rz),
      'XYZ',
    );
    pivot.scale.setScalar(anchor.scale);
    parent.add(pivot);
    parent = pivot;
    pivots.push(pivot);
  }
  return { parent, pivots };
}

/**
 * 把自身锚点变换直接设到某个对象上（ancestry 为空时的兜底）。
 *
 * 为什么保留这个兜底：后端保证 `ancestry` 至少含自身，但前端不应因契约意外而渲染出
 * 「位置全在原点」的模型——那样用户只会觉得功能坏了且无从判断原因。
 *
 * @param object 目标对象
 * @param anchor 自身锚点变换
 */
export function applyAnchorToObject(
  object: THREE_NS.Object3D,
  anchor: AnchorTransform,
): void {
  object.position.set(anchor.x, anchor.y, anchor.z);
  object.rotation.set(
    toRadians(anchor.rx),
    toRadians(anchor.ry),
    toRadians(anchor.rz),
    'XYZ',
  );
  object.scale.setScalar(anchor.scale);
}
