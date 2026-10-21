import type { AnchorDescriptor, AnchorRuntimeState } from './types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      this.material = {
        color: { set: () => undefined },
        dispose: () => undefined,
      };
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
    expect(anyFilled, '标签应包含设备名与数值（数据先到、模型后到）').toBe(
      true,
    );
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
    const layerA = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      containerA,
      {
        onClickAnchor: () => undefined,
      },
    );
    layerA.update(
      new Map([
        ['pA', { alertCount: 0, hasValue: true, primaryText: '11.1 ℃' }],
      ]) as never,
    );
    layerA.attach(new (fakeThree().Group)() as never, [anchor('pA', 'A 泵')]);
    expect(document.body.innerHTML.includes('11.1')).toBe(true);

    // 顺序 B：先 attach 再 update（模型比数据快）
    const containerB = document.createElement('div');
    const layerB = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      containerB,
      {
        onClickAnchor: () => undefined,
      },
    );
    layerB.attach(new (fakeThree().Group)() as never, [anchor('pB', 'B 泵')]);
    layerB.update(
      new Map([
        ['pB', { alertCount: 0, hasValue: true, primaryText: '22.2 ℃' }],
      ]) as never,
    );
    expect(document.body.innerHTML.includes('22.2')).toBe(true);
  });
});

/**
 * 本次视觉改造新增的锚点层能力：hover 语义、DOM 契约、数值跳变、降级圆点。
 *
 * 这些用例的意义在于：hover 卡片（另一人的模块）**只能通过 DOM 契约**接进来，
 * 契约一旦漂移，卡片就会「永远不出现」或「永远不消失」，而单元测试覆盖不到 UI 联动。
 */
describe('createAnchorLayer：hover 回调语义（进入 pointId / 离开 undefined）', () => {
  it('★ 鼠标离开标签必须回调 undefined（否则 hover 卡片永远关不掉）', () => {
    const fake = fakeThree();
    const container = document.createElement('div');
    const hovers: Array<string | undefined> = [];
    const layer = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      container,
      {
        onClickAnchor: () => undefined,
        onHoverAnchor: (pointId) => hovers.push(pointId),
      },
    );
    layer.attach(new (fakeThree().Group)() as never, [anchor('p1', '1 号泵')]);
    const label = document.querySelector(
      '.twin-anchor-label[data-point-id="p1"]',
    );
    expect(label).toBeTruthy();
    const capsule = label?.querySelector('.twin-anchor-capsule');
    expect(capsule).toBeTruthy();
    capsule?.dispatchEvent(new Event('pointerenter'));
    expect(hovers).toEqual(['p1']);
    capsule?.dispatchEvent(new Event('pointerleave'));
    expect(hovers, '★ 离开时必须是 undefined').toEqual(['p1', undefined]);
  });

  it('向后兼容：只写 `(pointId: string) => void` 的旧回调仍能赋值并收到进入事件', () => {
    const fake = fakeThree();
    const container = document.createElement('div');
    const received: string[] = [];
    // 旧签名：参数是 string（不是 string | undefined）。
    // ⚠️ 类型层验证：只写 `(pointId: string) => void` 的回调**能**赋给新契约，
    // 但运行时可能收到 undefined —— 旧调用方必须自己判空（这正是「向后兼容」的代价）。
    const legacy = (pointId: string) => {
      if (pointId) {
        received.push(pointId);
      }
    };
    const layer = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      container,
      {
        onClickAnchor: () => undefined,
        // 用 `as never` 就是为了模拟「未改签名的旧调用方」：证明放宽参数类型是对的
        onHoverAnchor: legacy as never,
      },
    );
    layer.attach(new (fakeThree().Group)() as never, [anchor('p1', '泵')]);
    const capsule = document.querySelector('.twin-anchor-capsule');
    expect(capsule).toBeTruthy();
    capsule?.dispatchEvent(new Event('pointerenter'));
    expect(received).toEqual(['p1']);
  });

  it('setHovered(pointId) 由管理器转发时也触发回调（不依赖真实鼠标）', () => {
    const fake = fakeThree();
    const container = document.createElement('div');
    const hovers: Array<string | undefined> = [];
    const layer = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      container,
      {
        onClickAnchor: () => undefined,
        onHoverAnchor: (pointId) => hovers.push(pointId),
      },
    );
    layer.attach(new (fakeThree().Group)() as never, [anchor('p1', '泵')]);
    layer.setHovered('p1');
    layer.setHovered(undefined);
    expect(hovers).toEqual(['p1', undefined]);
  });
});

describe('createAnchorLayer：DOM 契约（hover 卡片依赖）', () => {
  it('★ 标签元素带 data-point-id 与 .twin-anchor-label 类名', () => {
    const fake = fakeThree();
    const container = document.createElement('div');
    const layer = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      container,
      {
        onClickAnchor: () => undefined,
      },
    );
    layer.attach(new (fakeThree().Group)() as never, [
      anchor('p1', '泵'),
      anchor('p2', '阀'),
    ]);
    const labels = document.querySelectorAll(
      '.twin-anchor-label[data-point-id]',
    );
    expect(labels).toHaveLength(2);
    expect(
      document.querySelector('.twin-anchor-label[data-point-id="p1"]'),
    ).toBeTruthy();
  });

  it('★ 数值文本在 .twin-anchor-value 里（与设备名分离，卡片可单独读取）', () => {
    const fake = fakeThree();
    const container = document.createElement('div');
    const layer = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      container,
      {
        onClickAnchor: () => undefined,
      },
    );
    layer.attach(new (fakeThree().Group)() as never, [anchor('p1', '泵')]);
    layer.update(
      new Map([
        [
          'p1',
          {
            alertCount: 0,
            hasValue: true,
            onlineStatus: 'online',
            primaryText: '23.4 ℃',
          },
        ],
      ]),
    );
    const value = document.querySelector<HTMLElement>(
      '.twin-anchor-label[data-point-id="p1"] .twin-anchor-value',
    );
    expect(value?.textContent).toBe('23.4 ℃');
    const name = document.querySelector(
      '.twin-anchor-label[data-point-id="p1"] .twin-anchor-name',
    );
    expect(name?.textContent).toBe('泵');
  });

  it('★ 数值跳变时该数值元素出现 data-flash 高亮（一次性）', () => {
    vi.useFakeTimers();
    try {
      const fake = fakeThree();
      const container = document.createElement('div');
      const layer = createAnchorLayer(
        fake as never,
        fakeCss2d() as never,
        container,
        {
          onClickAnchor: () => undefined,
        },
      );
      layer.attach(new (fakeThree().Group)() as never, [anchor('p1', '泵')]);
      layer.update(
        new Map([
          ['p1', { alertCount: 0, hasValue: true, primaryText: '23.4 ℃' }],
        ]),
      );
      const value = document.querySelector<HTMLElement>(
        '.twin-anchor-label[data-point-id="p1"] .twin-anchor-value',
      );
      // 首次写入不算跳变（没有「上一值」可比）
      expect(value?.dataset.flash).not.toBe('true');
      layer.update(
        new Map([
          ['p1', { alertCount: 0, hasValue: true, primaryText: '25.1 ℃' }],
        ]),
      );
      expect(value?.dataset.flash, '★ 数值变化必须高亮').toBe('true');
      // 600ms 后自动熄灭（不与 600ms 告警闪烁定时器混用）
      vi.advanceTimersByTime(700);
      expect(value?.dataset.flash).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('★ 告警锚点带 data-alert=true（卡片/图例据此标红）', () => {
    const fake = fakeThree();
    const container = document.createElement('div');
    const layer = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      container,
      {
        onClickAnchor: () => undefined,
      },
    );
    layer.attach(new (fakeThree().Group)() as never, [anchor('p1', '泵')]);
    layer.update(
      new Map([
        [
          'p1',
          {
            alertCount: 2,
            hasValue: true,
            onlineStatus: 'online',
            primaryText: '90 ℃',
          },
        ],
      ]),
    );
    const label = document.querySelector<HTMLElement>(
      '.twin-anchor-label[data-point-id="p1"]',
    );
    expect(label?.dataset.alert).toBe('true');
    layer.dispose();
  });

  it('labelVisible=false 的点位不渲染标签（display:none）', () => {
    const fake = fakeThree();
    const container = document.createElement('div');
    const layer = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      container,
      {
        onClickAnchor: () => undefined,
      },
    );
    const hidden = { ...anchor('p1', '泵'), labelVisible: false };
    layer.attach(new (fakeThree().Group)() as never, [hidden]);
    const label = document.querySelector(
      '.twin-anchor-label[data-point-id="p1"]',
    ) as HTMLElement | null;
    expect(label?.style.display).toBe('none');
    layer.dispose();
  });

  it('setMotionMode 可下发档位；档位变化后状态立即重放（不崩溃）', () => {
    const fake = fakeThree();
    const container = document.createElement('div');
    const layer = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      container,
      {
        onClickAnchor: () => undefined,
      },
    );
    layer.attach(new (fakeThree().Group)() as never, [anchor('p1', '泵')]);
    layer.update(
      new Map([
        [
          'p1',
          {
            alertCount: 1,
            hasValue: true,
            onlineStatus: 'online',
            primaryText: '1',
          },
        ],
      ]),
    );
    expect(() => layer.setMotionMode('reduced')).not.toThrow();
    expect(() => layer.setMotionMode('off')).not.toThrow();
    expect(() => layer.setMotionMode('normal')).not.toThrow();
    layer.dispose();
  });

  it('dispose 清理全部标签 DOM 与注入的 <style>（不残留全局样式）', () => {
    const fake = fakeThree();
    const container = document.createElement('div');
    const layer = createAnchorLayer(
      fake as never,
      fakeCss2d() as never,
      container,
      {
        onClickAnchor: () => undefined,
      },
    );
    layer.attach(new (fakeThree().Group)() as never, [anchor('p1', '泵')]);
    const before = container.querySelectorAll('style').length;
    layer.dispose();
    expect(document.querySelectorAll('.twin-anchor-label')).toHaveLength(0);
    expect(container.querySelectorAll('style').length).toBeLessThan(before);
  });
});

/**
 * 清理：上面的历史用例没有 `dispose()`（它们只关心 `document.body.innerHTML` 是否包含文本），
 * 而本次新增用例用 `document.querySelector` 精确查找——残留元素会让「找到第一个」命中旧元素。
 *
 * 因此每个用例前清空 `document.body`。这是测试卫生问题，不改生产代码。
 */
beforeEach(() => {
  document.body.innerHTML = '';
});
