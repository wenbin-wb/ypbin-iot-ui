/**
 * 锚点层的**测试替身**（最小 three / CSS2D 桩）。
 *
 * 从 `anchor-layer.test.ts` 抽出来复用：新增的 hover-DOM 权威用例需要同一套替身，
 * 复制一份会导致「替身漂移」（一处改了另一处没改，测试结果不再可比）。
 */

export function fakeThree() {
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
export function fakeCss2d() {
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
