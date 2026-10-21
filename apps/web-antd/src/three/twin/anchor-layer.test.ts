import type { AnchorDescriptor, AnchorRuntimeState } from './types';

import { describe, expect, it } from 'vitest';

import { createAnchorLayer } from './anchor-layer';

/**
 * 锚点层：**数据先到、模型后到**时必须能重放状态（线上缺陷回归）。
 *
 * ## 缺陷现场
 *
 * `index.vue` 的加载顺序是「先拉点位 + 运行态快照 → 画布再异步加载 GLB」，
 * 因此 `update(states)` 往往**早于** `attach(modelRoot, anchors)`。
 *
 * 修复前的 `detach()` 会把已收到的 `currentStates` 清空，且 `attach()` 之后不重放
 * ⇒ 锚点图标能显示，但**标签永远是空白**（没有设备名与数值），界面还不报错。
 * 实测现象：6 个 `.twin-anchor-label` 全部 `textContent === ''`、尺寸 14×6px。
 *
 * 本文件用最小 three 替身验证该不变量。
 */

/** 最小 three 替身（只实现 anchor-layer 用到的部分）。 */
function fakeThree() {
  class FakeObject3D {
    children: FakeObject3D[] = [];
    name = '';
    position = { set: () => undefined };
    renderOrder = 0;
    userData: Record<string, unknown> = {};
    add(child: FakeObject3D) {
      this.children.push(child);
      return this;
    }
    removeFromParent() {
      return this;
    }
  }
  class FakeGroup extends FakeObject3D {}
  class FakeSprite extends FakeObject3D {
    material: {
      color: { set: (value: string) => void };
      dispose: () => void;
    };
    scale = { set: () => undefined };
    constructor() {
      super();
      this.material = { color: { set: () => undefined }, dispose: () => undefined };
    }
  }
  class FakeTexture {
    needsUpdate = false;
    dispose = () => undefined;
  }
  const canvasStub = {
    getContext: () => ({
      arc: () => undefined,
      beginPath: () => undefined,
      clearRect: () => undefined,
      fill: () => undefined,
      fillStyle: '',
    }),
    height: 64,
    width: 64,
  };
  return {
    CanvasTexture: class extends FakeTexture {},
    Group: FakeGroup,
    Sprite: FakeSprite,
    SpriteMaterial: class {
      color = { set: () => undefined };
      depthTest = true;
      map: unknown = null;
      sizeAttenuation = true;
      transparent = true;
      constructor(params?: Record<string, unknown>) {
        Object.assign(this, params);
      }
      dispose = () => undefined;
    },
    __canvasStub: canvasStub,
  };
}

/**
 * 最小 CSS2D 替身。
 *
 * 真实 `CSS2DRenderer` 会在每帧 render 时把 `CSS2DObject.element` 挂进它的 domElement。
 * 单测里不跑渲染循环，所以这里在构造时就**把元素插入 document.body**，
 * 使测试能直接查 DOM（与真实渲染后的可观测结果一致）。
 */
function fakeCss2d() {
  class FakeGroup {
    children: unknown[] = [];
    name = '';
    position = { set: () => undefined };
    userData: Record<string, unknown> = {};
    add(child: unknown) {
      this.children.push(child);
      return this;
    }
    removeFromParent() {
      return this;
    }
  }
  class CSS2DObject extends FakeGroup {
    element: HTMLElement;
    constructor(element: HTMLElement) {
      super();
      this.element = element;
      document.body.append(element);
    }
  }
  return {
    CSS2DObject,
    CSS2DRenderer: class {
      domElement = document.createElement('div');
      render() {}
      setSize() {}
    },
  };
}

/** 造一个锚点描述。 */
function anchor(pointId: string, deviceName: string): AnchorDescriptor {
  return {
    deviceId: `dev-${pointId}`,
    deviceName,
    labelVisible: true,
    local: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    pointId,
    sort: 0,
  };
}

describe('createAnchorLayer：状态重放', () => {
  it('★ 运行态先到、锚点后挂载 ⇒ 标签必须立刻有文字', () => {
    // 让 document.createElement('canvas') 返回可控 canvas
    const fake = fakeThree();
    const container = document.createElement('div');
    const layer = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      container,
      { onClickAnchor: () => undefined },
    );

    // 1) 先推状态（此时还没有任何锚点）
    const states = new Map<string, AnchorRuntimeState>([
      [
        'p1',
        {
          alertCount: 0,
          hasValue: true,
          onlineStatus: 'online',
          primaryText: '23.5 ℃',
          renderMode: 'label',
          status: 1,
        },
      ],
    ]);
    layer.update(states);

    // 2) 后挂载锚点（模拟模型加载完成）
    layer.attach(new (fakeThree().Group)() as never, [anchor('p1', '1 号泵')]);

    // 3) 标签必须已带文字（修复前是空串，正是线上现象）
    const labels = [...document.body.querySelectorAll('.twin-anchor-label')];
    // CSS2DObject 的 element 会被 append 到容器；这里直接从 DOM 查
    const texts = labels.map((el) => el.textContent ?? '');
    // 即便 CSS2D 替身没把元素插入容器，也检查 layer 内部是否写入了文本
    const anyFilled =
      texts.some((t) => t.includes('1 号泵') && t.includes('23.5')) ||
      document.body.innerHTML.includes('1 号泵');
    expect(anyFilled, '标签应包含设备名与数值（数据先到、模型后到）').toBe(true);
  });

  it('detach 之后重新 attach：仍能显示最后一次已知状态', () => {
    const fake = fakeThree();
    const container = document.createElement('div');
    const layer = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      container,
      { onClickAnchor: () => undefined },
    );
    layer.update(
      new Map([
        [
          'p1',
          {
            alertCount: 0,
            hasValue: true,
            onlineStatus: 'online',
            primaryText: '7.5 V',
            renderMode: 'label',
            status: 1,
          },
        ],
      ]),
    );
    layer.attach(new (fakeThree().Group)() as never, [anchor('p1', '电表')]);
    layer.detach();
    layer.attach(new (fakeThree().Group)() as never, [anchor('p1', '电表')]);

    expect(document.body.innerHTML.includes('7.5')).toBe(true);
  });

  it('★ update 与 attach 的两种顺序都必须让标签有文本（线上两种时序都出现过）', () => {
    const fake = fakeThree();

    // 顺序 A：先 update 再 attach（数据比模型快 —— 实测常态）
    const containerA = document.createElement('div');
    const layerA = createAnchorLayer(fake as never, fakeCss2d() as never, containerA, {
      onClickAnchor: () => undefined,
    });
    layerA.update(new Map([['pA', { alertCount: 0, hasValue: true, primaryText: '11.1 ℃' }]]) as never);
    layerA.attach(new (fakeThree().Group)() as never, [anchor('pA', 'A 泵')]);
    expect(document.body.innerHTML.includes('11.1')).toBe(true);

    // 顺序 B：先 attach 再 update（模型比数据快）
    const containerB = document.createElement('div');
    const layerB = createAnchorLayer(fake as never, fakeCss2d() as never, containerB, {
      onClickAnchor: () => undefined,
    });
    layerB.attach(new (fakeThree().Group)() as never, [anchor('pB', 'B 泵')]);
    layerB.update(new Map([['pB', { alertCount: 0, hasValue: true, primaryText: '22.2 ℃' }]]) as never);
    expect(document.body.innerHTML.includes('22.2')).toBe(true);
  });
});
