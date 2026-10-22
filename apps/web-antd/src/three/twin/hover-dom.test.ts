import type { AnchorDescriptor } from './types';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAnchorLayer } from './anchor-layer';
import { fakeCss2d, fakeThree } from './anchor-layer-test-doubles';

/**
 * hover 的 **DOM 权威**语义（线上反复出现缺陷的回归用例）。
 *
 * ## 缺陷形态（dev 实测，两个独立缺陷叠加）
 *
 * 1. `hitTestAnchor` 用 3D 投影坐标判定，而胶囊真实位置来自 DOM 实测 —— 两者实测差
 *    **170px 以上**（投影与 CSS2D 摆放不同源）。几何判定在节流后误判失败时就硬清空 hover；
 * 2. 指针一直在胶囊内时 `pointerenter` **只触发一次**，之后再没有任何事件能恢复 hover
 *    ⇒ 用户看到的是「卡片出现后在 1 秒内消失，且之后再也不出现」。
 *
 * ## 钉住的不变量
 *
 * 1. **DOM 命中建立 hover 后，几何未命中不得清空它**（DOM 是权威）；
 * 2. 只有 `pointerleave`（真正离开胶囊）才允许清空；
 * 3. 几何命中建立的 hover 仍按原有粘滞语义清理（不因这条修复「卡住」）。
 */
const ANCHORS: AnchorDescriptor[] = [
  {
    deviceId: 'd1',
    deviceName: '设备一',
    labelVisible: true,
    local: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    pointId: 'p1',
    sort: 0,
  },
];

function setup() {
  const fake = fakeThree();
  const container = document.createElement('div');
  const onHoverAnchor = vi.fn();
  const layer = createAnchorLayer(
    fake as never,
    fakeCss2d() as never,
    container,
    {
      onClickAnchor: () => undefined,
      onHoverAnchor,
    },
  );
  layer.attach(new fake.Group() as never, ANCHORS);
  const capsule = document.body.querySelector<HTMLElement>(
    '.twin-anchor-capsule',
  );
  return { capsule, container, layer, onHoverAnchor };
}

/**
 * 取胶囊元素（找不到就直接让测试失败，替代非空断言 —— 本仓 lint 禁止 `!`）。
 *
 * @param root 查询根（默认 document.body）
 * @returns 胶囊元素
 */
function capsuleOf(root: ParentNode = document.body): HTMLElement {
  const element = root.querySelector<HTMLElement>('.twin-anchor-capsule');
  if (!element) {
    throw new Error('胶囊元素不存在：锚点层没有创建 .twin-anchor-capsule');
  }
  return element;
}

describe('anchor_layer_dom_authority：DOM 命中是权威（hover 不丢失）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('★ DOM pointerover 建立的 hover，不会被几何未命中清空', async () => {
    const { container, layer, onHoverAnchor } = setup();
    capsuleOf().dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(onHoverAnchor).toHaveBeenCalledWith('p1');

    // 几何从未命中（没有 lastScreen/lastCapsuleRect）⇒ 连续 pointermove + 待定关闭窗口
    // 过去之后，hover 仍然必须保持（DOM 权威）。
    for (let i = 0; i < 5; i++) {
      container.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 500 + i, clientY: 500 + i }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(onHoverAnchor).not.toHaveBeenCalledWith(undefined);
    layer.dispose();
  });

  it('★ 只有 pointerleave 才清空（真正离开胶囊）', async () => {
    const { layer, onHoverAnchor } = setup();
    capsuleOf().dispatchEvent(new Event('pointerover', { bubbles: true }));
    capsuleOf().dispatchEvent(new Event('pointerleave'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(onHoverAnchor).toHaveBeenLastCalledWith(undefined);
    layer.dispose();
  });

  it('键盘聚焦/失焦与 hover 同语义（a11y）', () => {
    const { layer, onHoverAnchor } = setup();
    capsuleOf().dispatchEvent(new Event('focus'));
    expect(onHoverAnchor).toHaveBeenCalledWith('p1');
    capsuleOf().dispatchEvent(new Event('blur'));
    expect(onHoverAnchor).toHaveBeenLastCalledWith(undefined);
    layer.dispose();
  });

  it('enter 等同点击（钉住）、esc 触发 onDismissAnchor', () => {
    const fake = fakeThree();
    const container = document.createElement('div');
    const onClickAnchor = vi.fn();
    const onDismissAnchor = vi.fn();
    const layer = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      container,
      {
        onClickAnchor,
        onDismissAnchor,
      },
    );
    layer.attach(new fake.Group() as never, ANCHORS);
    const capsule = capsuleOf();
    capsule.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
    );
    expect(onClickAnchor).toHaveBeenCalledWith('p1');
    capsule.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
    );
    expect(onDismissAnchor).toHaveBeenCalledTimes(1);
    layer.dispose();
  });
});
