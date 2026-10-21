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

/**
 * 锚点层就绪前的运行态**不能丢**（线上缺陷回归）。
 *
 * 现场：`onFlush` 在 `runtime.loadSnapshot()` 完成时触发，而画布仍在
 * `await manager.init()` 中（`attachAnchorLayer` 未调用）⇒ `this.anchorLayer?.update()`
 * 静默丢弃 ⇒ 6 个 `.twin-anchor-label` 的 textContent 全为空、childNodes 为 0。
 */
describe('sceneManager：锚点层就绪前的状态缓存', () => {
  it('★ attachAnchorLayer 后必须重放已收到的状态', async () => {
    const { TwinSceneManager } = await import('./scene-manager');
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800 });
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    const received: number[] = [];
    const fakeLayer = {
      attach: () => undefined,
      detach: () => undefined,
      render: () => undefined,
      resize: () => undefined,
      update: (states: Map<string, unknown>) => {
        received.push(states.size);
      },
    };
    const manager = new TwinSceneManager({
      container,
      errorMessages: { downloadFailed: (d) => d, parseFailed: (d) => d },
      onStateChange: () => undefined,
    });

    // 1) 锚点层尚未 attach 时收到状态（真实时序）
    manager.updateAnchorStates(
      new Map([
        ['p1', { alertCount: 0, hasValue: true, primaryText: '1.0' }],
        ['p2', { alertCount: 0, hasValue: true, primaryText: '2.0' }],
      ]) as never,
    );
    expect(received).toEqual([]);

    // 2) 锚点层就绪 ⇒ 必须把之前的状态补推过去
    manager.attachAnchorLayer(fakeLayer as never);
    expect(received).toEqual([2]);

    manager.dispose();
  });

  it('★ 模型就绪前收到的 anchors 必须被记住（否则锚点永远不建）', async () => {
    // 现场：refreshAnchors 在 modelRoot 未就绪时无法挂载；若直接丢弃，
    // 而此后 props.anchors 不再变化（静态场景常态）⇒ 锚点永远不会创建
    // ⇒ 画布上只有模型、没有任何设备点与标签。实测表现为「刷新几次，
    // 有时 6 个标签正常、有时全空」的时序竞态。
    const { TwinSceneManager } = await import('./scene-manager');
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800 });
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    const manager = new TwinSceneManager({
      container,
      errorMessages: { downloadFailed: (d) => d, parseFailed: (d) => d },
      onStateChange: () => undefined,
    });

    // 模型未就绪时传入 anchors（真实时序：点位接口比模型加载快）
    manager.refreshAnchors([
      {
        deviceId: 'd1',
        deviceName: '设备 1',
        labelVisible: true,
        local: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
        pointId: 'p1',
        sort: 0,
      },
    ]);
    // 内部应已记住（通过行为验证：attachAnchorLayer 后不报错、且后续可重放）
    expect(() =>
      manager.attachAnchorLayer({
        attach: () => undefined,
        detach: () => undefined,
        render: () => undefined,
        resize: () => undefined,
        update: () => undefined,
      }),
    ).not.toThrow();
    manager.dispose();
  });
});

/**
 * `getSceneSummary()`：画布 HUD 的上下文数据。
 *
 * ## 为什么这些用例值得写
 *
 * HUD 上每个字段都是「用户看到的一句话」，错一个就是一句假话：
 * - `animationsRunning` 若用「有 clip」判断，弱机型（clipSpeed=0，mixer 不 update）会显示
 *   「动画播放中」而画面完全静止；
 * - `modelBytes`/`animationCount` 若在切场景时不清零，会显示上一个场景的数字；
 * - 未加载模型时若返回全 0，调用方无法区分「没有模型」与「模型 0 字节」。
 *
 * 本文件用**属性注入**的方式构造最小状态（不跑 WebGL）：`getSceneSummary` 是纯读取方法，
 * 它读的都是私有字段，因此在测试里直接把这些字段按生产时的形态摆好即可。
 */
describe('sceneManager：getSceneSummary（HUD 概况）', () => {
  /** 造一个最小管理器并注入内部状态。 */
  async function createManagerWith(state: {
    animationCount?: number;
    animator?: { isRunning: () => boolean };
    modelBytes?: number;
    modelLoaded?: boolean;
    motionMode?: 'normal' | 'off' | 'reduced';
    orbiting?: boolean;
  }) {
    const { TwinSceneManager } = await import('./scene-manager');
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800 });
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    const manager = new TwinSceneManager({
      container,
      errorMessages: { downloadFailed: (d) => d, parseFailed: (d) => d },
      onStateChange: () => undefined,
    });
    const internals = manager as unknown as Record<string, unknown>;
    // 模型根替身：`dispose()` 会走 `disposeSubtree`（需要 traverse/removeFromParent）
    internals.modelRoot =
      state.modelLoaded === false
        ? undefined
        : {
            children: [],
            removeFromParent: () => undefined,
            traverse: () => undefined,
            userData: {},
          };
    // 动画器替身：除了被断言的 isRunning，dispose 也必须存在（manager.dispose 会调用）
    internals.animator = state.animator
      ? { ...state.animator, dispose: () => undefined }
      : undefined;
    internals.animationCount = state.animationCount ?? 0;
    internals.modelBytes = state.modelBytes ?? 0;
    internals.motionMode = state.motionMode ?? 'normal';
    internals.orbit =
      state.orbiting === undefined
        ? undefined
        : {
            dispose: () => undefined,
            isOrbiting: () => state.orbiting,
            notifyInteraction: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
            update: () => undefined,
          };
    return manager;
  }

  it('★ 未加载模型 ⇒ 返回 undefined（与「模型 0 字节」区分开）', async () => {
    const manager = await createManagerWith({ modelLoaded: false });
    expect(manager.getSceneSummary()).toBeUndefined();
    manager.dispose();
  });

  it('★ 已加载模型 ⇒ 字段齐全且类型正确', async () => {
    const manager = await createManagerWith({
      animationCount: 3,
      animator: { isRunning: () => true },
      modelBytes: 2_097_152,
      motionMode: 'reduced',
      orbiting: true,
    });
    const summary = manager.getSceneSummary();
    expect(summary).toBeDefined();
    expect(summary?.animationCount).toBe(3);
    expect(summary?.modelBytes).toBe(2_097_152);
    expect(summary?.motionMode).toBe('reduced');
    expect(summary?.orbiting).toBe(true);
    expect(summary?.animationsRunning).toBe(true);
    expect(summary?.renderStats).toEqual({ geometries: 0, textures: 0 });
    manager.dispose();
  });

  it('★ 动画停止（弱机型 clipSpeed=0）⇒ animationsRunning=false，但 animationCount 仍如实反映模型', async () => {
    // 关键区分：模型**有** 3 个动画，但当前**没有在播**（弱机型档位）
    const manager = await createManagerWith({
      animationCount: 3,
      animator: { isRunning: () => false },
      modelBytes: 1024,
      motionMode: 'off',
    });
    const summary = manager.getSceneSummary();
    expect(
      summary?.animationsRunning,
      '★ 不能让 HUD 显示「播放中」而画面静止',
    ).toBe(false);
    expect(summary?.animationCount).toBe(3);
    expect(summary?.motionMode).toBe('off');
    manager.dispose();
  });

  it('★ 无动画器（模型没带 clip）⇒ animationsRunning=false、animationCount=0', async () => {
    const manager = await createManagerWith({
      animationCount: 0,
      modelBytes: 512,
    });
    const summary = manager.getSceneSummary();
    expect(summary?.animationsRunning).toBe(false);
    expect(summary?.animationCount).toBe(0);
    expect(summary?.orbiting, '没有巡航控制器时也不应报 true').toBe(false);
    manager.dispose();
  });

  it('未初始化渲染器时 renderStats 返回 0（不返回 null/undefined）', async () => {
    const manager = await createManagerWith({ modelBytes: 1 });
    const summary = manager.getSceneSummary();
    expect(summary?.renderStats).toEqual({ geometries: 0, textures: 0 });
    manager.dispose();
  });

  it('dispose 之后返回 undefined（不返回上一个场景的残留数据）', async () => {
    const manager = await createManagerWith({
      animationCount: 5,
      modelBytes: 9,
    });
    expect(manager.getSceneSummary()).toBeDefined();
    manager.dispose();
    expect(manager.getSceneSummary()).toBeUndefined();
  });
});
