import type { AnchorRuntimeState } from './types';

import type { IotTwinApi } from '#/api/iot';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TwinRuntimeStore } from './runtime-store';

/**
 * 运行态合并与节流。
 *
 * 用 `vi.stubGlobal('requestAnimationFrame', ...)` 把 rAF 变成同步可控，
 * 这样「一帧内多次事件只提交一次」的行为可以被确定性验证。
 */
describe('twinRuntimeStore', () => {
  let flushes: Array<Map<string, AnchorRuntimeState>>;
  let store: TwinRuntimeStore;

  beforeEach(() => {
    flushes = [];
    // 同步执行 rAF 回调，便于断言「提交了几次」。
    // ⚠️ 回调必须在**返回句柄之前**执行，且不能真的返回一个「永不清除」的句柄：
    //    实现里的 scheduleFlush 用 `if (this.flushHandle) return` 做合并，
    //    若 stub 返回 1 而从不被 cancelAnimationFrame 清零，后续所有 scheduleFlush
    //    都会被这个残留句柄短路 ⇒ 测试表现为「只剩第一次 flush」。这里返回 0 表示
    //    「本帧已同步完成」，与浏览器语义（回调执行后句柄作废）一致。
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    store = new TwinRuntimeStore({
      onFlush: (states) => {
        flushes.push(states);
      },
    });
  });

  afterEach(() => {
    store.dispose();
    vi.unstubAllGlobals();
  });

  function snapshot(): IotTwinApi.RuntimeResp {
    return {
      pointCount: 1,
      points: [
        {
          alertCount: 0,
          deviceId: '4101',
          deviceName: '3 号泵',
          onlineStatus: 'online',
          pointId: '5002',
          status: 1,
          values: {},
        },
      ],
      sceneId: '5001',
      serverTime: '2026-10-21 10:30:00',
      truncated: false,
    };
  }

  function bindings(): Map<string, IotTwinApi.BindingResp[]> {
    return new Map([
      [
        '5002',
        [
          {
            decimals: 1,
            displayRole: 'primary',
            displayType: 'value',
            id: '1',
            propertyIdentifier: 'temperature',
            propertyName: '温度',
            serviceIdentifier: 'Environment',
            stale: false,
            unit: '℃',
          },
        ],
      ],
    ]);
  }

  it('快照替换后提交一次，无数据时 hasValue=false（不是 0）', () => {
    store.replaceSnapshot(snapshot(), bindings());
    expect(flushes).toHaveLength(1);
    const state = [...(flushes[0]?.values() ?? [])][0];
    expect(state?.hasValue).toBe(false);
    expect(state?.primaryText).toBe('');
  });

  it('latest 事件命中主展示属性时更新文本并带单位与小数位', () => {
    store.replaceSnapshot(snapshot(), bindings());
    flushes.length = 0;
    store.applyLatestEvent({
      deviceId: '4101',
      propertyId: 'temperature',
      ts: 1000,
      value: '26.54',
    });
    const state = [...(flushes[0]?.values() ?? [])][0];
    expect(state?.hasValue).toBe(true);
    expect(state?.primaryText).toBe('26.5 ℃');
  });

  it('★ 旧 ts 的读数不覆盖新值（SSE 乱序时不回跳）', () => {
    store.replaceSnapshot(snapshot(), bindings());
    store.applyLatestEvent({
      deviceId: '4101',
      propertyId: 'temperature',
      ts: 2000,
      value: '30',
    });
    flushes.length = 0;
    store.applyLatestEvent({
      deviceId: '4101',
      propertyId: 'temperature',
      ts: 1000,
      value: '10',
    });
    // 旧值被丢弃 ⇒ 没有 dirty ⇒ 没有新的 flush
    expect(flushes).toHaveLength(0);
  });

  it('非本场景设备的事件被忽略（不产生 flush）', () => {
    store.replaceSnapshot(snapshot(), bindings());
    flushes.length = 0;
    store.applyLatestEvent({
      deviceId: '9999',
      propertyId: 'temperature',
      ts: 1000,
      value: '1',
    });
    expect(flushes).toHaveLength(0);
  });

  it('★ 未绑定属性的事件被忽略（只关心本场景绑定的属性）', () => {
    store.replaceSnapshot(snapshot(), bindings());
    flushes.length = 0;
    store.applyLatestEvent({
      deviceId: '4101',
      propertyId: 'notBound',
      ts: 1000,
      value: '1',
    });
    expect(flushes).toHaveLength(0);
  });

  it('device-status 数字 status 视为启停位，字符串视为在线状态', () => {
    store.replaceSnapshot(snapshot(), bindings());
    flushes.length = 0;
    store.applyDeviceStatusEvent({ deviceId: '4101', status: 0 });
    expect([...(flushes[0]?.values() ?? [])][0]?.status).toBe(0);

    flushes.length = 0;
    store.applyDeviceStatusEvent({ deviceId: '4101', status: 'offline' });
    expect([...(flushes[0]?.values() ?? [])][0]?.onlineStatus).toBe('offline');
  });

  it('device-status 批量形态（deviceIds）也生效', () => {
    store.replaceSnapshot(snapshot(), bindings());
    flushes.length = 0;
    store.applyDeviceStatusEvent({ deviceIds: ['4101'], status: 0 });
    expect([...(flushes[0]?.values() ?? [])][0]?.status).toBe(0);
  });

  it('applyAlertCounts 只对变化的设备产生 flush', () => {
    store.replaceSnapshot(snapshot(), bindings());
    flushes.length = 0;
    store.applyAlertCounts(new Map([['4101', 0]]));
    expect(flushes).toHaveLength(0);

    store.applyAlertCounts(new Map([['4101', 3]]));
    expect([...(flushes[0]?.values() ?? [])][0]?.alertCount).toBe(3);
  });

  it('★ 非数字值不做小数位格式化（枚举/字符串属性原样展示）', () => {
    store.replaceSnapshot(snapshot(), bindings());
    flushes.length = 0;
    store.applyLatestEvent({
      deviceId: '4101',
      propertyId: 'temperature',
      ts: 1000,
      value: 'running',
    });
    expect([...(flushes[0]?.values() ?? [])][0]?.primaryText).toBe('running ℃');
  });

  it('dispose 后不再提交', () => {
    store.replaceSnapshot(snapshot(), bindings());
    store.dispose();
    flushes.length = 0;
    store.applyLatestEvent({
      deviceId: '4101',
      propertyId: 'temperature',
      ts: 1000,
      value: '1',
    });
    expect(flushes).toHaveLength(0);
  });
});
