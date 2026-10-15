import type { SseFrame } from './realtime';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  alertTouchesDevice,
  createSseFrameParser,
  createTrailingDebounce,
  IOT_REALTIME_EVENTS,
  IotRealtimeClient,
  isIotRealtimeEventName,
  reconnectDelayMs,
} from './realtime';

/** 增量 SSE 解析 / 断线退避 / dispose 的用例（不启真实网络）。 */

/**
 * `IotRealtimeClient` 默认从 access store 取 Bearer token、从 preferences 取语言；
 * 用例里必须先把 pinia store 初始化，否则连 headers 都构造不出来（更别提 fetch）。
 */
beforeAll(async () => {
  const { createApp } = await import('vue');
  const { initStores } = await import('@vben/stores');
  await initStores(createApp({ render: () => null }), {
    namespace: 'realtime-test',
  });
});

function collectFrames() {
  const frames: SseFrame[] = [];
  const parser = createSseFrameParser((frame) => frames.push(frame));
  return { frames, parser };
}

const encoder = new TextEncoder();

/** 用 chunk 列表造一个「读两次就结束」的响应桩，避免依赖真实 ReadableStream 实现。 */
function responseFromChunks(chunks: string[]): Response {
  let index = 0;
  const reader = {
    read: async () => {
      if (index >= chunks.length) {
        return { done: true as const, value: undefined };
      }
      const value = encoder.encode(chunks[index] ?? '');
      index += 1;
      return { done: false as const, value };
    },
    releaseLock: () => {},
  };
  return {
    body: { getReader: () => reader },
    ok: true,
    status: 200,
  } as unknown as Response;
}

async function flushAsync() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('createSseFrameParser（分帧 / 多行 data / 心跳注释 / CRLF）', () => {
  it('一帧跨多个 chunk 时缓冲到空行才派发', () => {
    const { frames, parser } = collectFrames();

    parser.feed('event: latest\ndata: {"deviceId":"1",');
    expect(frames).toHaveLength(0);

    parser.feed('"propertyId":"temp"}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe('latest');
    expect(JSON.parse(frames[0]?.data ?? '')).toEqual({
      deviceId: '1',
      propertyId: 'temp',
    });
  });

  it('多行 data 以换行连接（JSON 跨行也能还原）', () => {
    const { frames, parser } = collectFrames();
    parser.feed('event: alert\ndata: {"count":\ndata: 2}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe('{"count":\n2}');
    expect(JSON.parse(frames[0]?.data ?? '')).toEqual({ count: 2 });
  });

  it('心跳注释不派发；注释后的正常帧照常派发', () => {
    const { frames, parser } = collectFrames();
    parser.feed(': hb\n\n');
    expect(frames).toHaveLength(0);

    parser.feed(': keep-alive\n\nevent: latest\ndata: {}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe('latest');
  });

  it(String.raw`兼容 CRLF；被拆开的 \r\n 不会被记成两行`, () => {
    const { frames, parser } = collectFrames();
    parser.feed('event: latest\r');
    expect(frames).toHaveLength(0);
    parser.feed('\ndata: {"x":1}\r\n\r\n');
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]?.data ?? '')).toEqual({ x: 1 });
  });

  it('解析 id/retry 字段；未知字段忽略；无 data 的 event 帧不派发', () => {
    const { frames, parser } = collectFrames();
    parser.feed('event: alert\nid: 7\nretry: 5000\nfoo: bar\n\n');
    expect(frames).toHaveLength(0);

    parser.feed('data: payload\nid: 8\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ data: 'payload', id: '8' });
  });

  it('只暴露已知事件名判定（未知事件名交调用方 warn，不猜）', () => {
    expect(IOT_REALTIME_EVENTS).toEqual(['alert', 'device-status', 'latest']);
    expect(isIotRealtimeEventName('latest')).toBe(true);
    expect(isIotRealtimeEventName('bogus')).toBe(false);
  });
});

describe('reconnectDelayMs（指数退避 + 上限 + 抖动）', () => {
  it('jitter=0 时严格按 base×2^n，且封顶 max', () => {
    const options = { baseMs: 1000, jitter: 0, maxMs: 4000 };
    expect(reconnectDelayMs(0, options)).toBe(1000);
    expect(reconnectDelayMs(1, options)).toBe(2000);
    expect(reconnectDelayMs(2, options)).toBe(4000);
    expect(reconnectDelayMs(9, options)).toBe(4000);
  });

  it('抖动只下调（[1-jitter, 1] 倍），不会超过上限也不会负', () => {
    const options = { baseMs: 1000, jitter: 0.5, maxMs: 2000 };
    for (let i = 0; i < 50; i += 1) {
      const delay = reconnectDelayMs(1, options);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });
});

describe('alertTouchesDevice（alert 事件与设备的关联判定）', () => {
  it('单 deviceId / deviceIds 列表都能精确匹配（Long 字符串）', () => {
    expect(alertTouchesDevice({ deviceId: '1001' }, '1001')).toBe(true);
    expect(alertTouchesDevice({ deviceId: '1001' }, '1002')).toBe(false);
    expect(alertTouchesDevice({ deviceIds: ['1001', '1002'] }, '1002')).toBe(
      true,
    );
    expect(alertTouchesDevice({ deviceIds: ['1001'] }, '1002')).toBe(false);
  });

  it('没有设备上下文 ⇒ 保守刷新（宁可多刷不可漏刷）', () => {
    expect(alertTouchesDevice({}, '1001')).toBe(true);
    expect(alertTouchesDevice({ deviceId: null }, '1001')).toBe(true);
    expect(alertTouchesDevice(undefined, '1001')).toBe(true);
  });

  it('设备未打开（deviceId 为空）⇒ 一律不刷新', () => {
    expect(alertTouchesDevice({}, '')).toBe(false);
    expect(alertTouchesDevice({ deviceId: '1001' }, '')).toBe(false);
  });
});

describe('createTrailingDebounce（去抖合并）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('窗口内多次调用只执行最后一次；cancel 取消未执行任务', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = createTrailingDebounce(fn, 300);

    debounced();
    vi.advanceTimersByTime(299);
    debounced();
    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);

    debounced();
    debounced.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('客户端 IotRealtimeClient：重连 / 派发 / dispose', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('首连 HTTP 失败 ⇒ 退避重连；恢复后进入 live 并派发解析好的事件', async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const states: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response)
      .mockResolvedValue(
        responseFromChunks(['event: alert\ndata: {"n":1}\n\n']),
      );

    const client = new IotRealtimeClient({
      backoff: { baseMs: 1000, jitter: 0, maxMs: 8000 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      url: 'http://localhost/api/iot/realtime/stream',
      onEvent,
      onStateChange: (state) => states.push(state),
    });

    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(states).toContain('reconnecting');

    // 第一次退避 1000ms 之前不得重连
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await flushAsync();
    expect(states).toContain('live');
    expect(onEvent).toHaveBeenCalledWith('alert', { n: 1 });

    client.dispose();
  });

  it('401/403 不重连（重试不会把 token/权限变好），只上报一次错误', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 401 }) as unknown as Response,
    );
    const client = new IotRealtimeClient({
      backoff: { jitter: 0 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onError,
      url: 'http://localhost/api/iot/realtime/stream',
    });

    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.connectionState).toBe('closed');

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('单个坏 JSON 帧只上报解析错误，不断流；后续帧照常派发', async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const onParseError = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        responseFromChunks([
          'event: alert\ndata: {bad\n\nevent: latest\ndata: {"x":1}\n\n',
        ]),
      );
    const client = new IotRealtimeClient({
      backoff: { baseMs: 1000, jitter: 0 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent,
      onParseError,
      url: 'http://localhost/api/iot/realtime/stream',
    });

    client.connect();
    await flushAsync();
    await vi.advanceTimersByTimeAsync(0);
    await flushAsync();

    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith('latest', { x: 1 });
    client.dispose();
  });

  it('dispose 中止在途流、清掉重连定时器，之后无任何网络动作也不误报错误', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const onError = vi.fn();
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      const reader = {
        read: () =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
        releaseLock: () => {},
      };
      return {
        body: { getReader: () => reader },
        ok: true,
        status: 200,
      } as unknown as Response;
    });
    const client = new IotRealtimeClient({
      backoff: { jitter: 0 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onError,
      url: 'http://localhost/api/iot/realtime/stream',
    });

    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    client.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(client.connectionState).toBe('closed');
  });

  it('connect 幂等：连接中重复调用不会开第二条流', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => {
      const reader = {
        read: () => new Promise(() => {}),
        releaseLock: () => {},
      };
      return {
        body: { getReader: () => reader },
        ok: true,
        status: 200,
      } as unknown as Response;
    });
    const client = new IotRealtimeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      url: 'http://localhost/api/iot/realtime/stream',
    });

    client.connect();
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});
