import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMessageStore } from './message';

const api = vi.hoisted(() => ({
  deleteMessage: vi.fn(),
  getMessageList: vi.fn(),
  getRecentMessages: vi.fn(),
  getSseTicket: vi.fn(),
  getUnreadCount: vi.fn(),
  markAllMessagesRead: vi.fn(),
  markMessageRead: vi.fn(),
}));

vi.mock('@vben/hooks', () => ({
  useAppConfig: () => ({ apiURL: 'http://api.example.test' }),
}));
vi.mock('@vben/stores', () => ({
  useUserStore: () => ({ userInfo: { userId: '1' } }),
}));
vi.mock('#/api/system/message', () => api);

/**
 * 最小 EventSource 替身（happy-dom 不提供）。
 *
 * 只实现消息中心用到的部分：`addEventListener` / `close` / dispatch。
 */
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  closed = false;
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

/**
 * 取第 n 个替身实例（不存在直接失败，替代非空断言 —— 本仓 lint 禁止 `!`）。
 *
 * @param index 序号
 * @returns 替身实例
 */
function sourceAt(index: number): FakeEventSource {
  const source = FakeEventSource.instances[index];
  if (!source) {
    throw new Error(`第 ${index} 个 EventSource 替身不存在`);
  }
  return source;
}

describe('message store', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('retries ticket acquisition failure until it connects', async () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const store = useMessageStore();
    api.getSseTicket
      .mockRejectedValueOnce(new Error('ticket failed'))
      .mockResolvedValueOnce({ ticket: 'new-ticket' });

    await store.startSse();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.getSseTicket).toHaveBeenCalledTimes(2);
    store.closeSse();
    vi.useRealTimers();
  });

  it('cancels pending SSE retry on close', async () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const store = useMessageStore();
    api.getSseTicket.mockRejectedValueOnce(new Error('ticket failed'));

    await store.startSse();
    expect(api.getSseTicket).toHaveBeenCalledTimes(1);

    store.closeSse();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.getSseTicket).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('synchronizes recent messages and unread count after a single read', async () => {
    setActivePinia(createPinia());
    const store = useMessageStore();
    api.getRecentMessages.mockResolvedValue([
      {
        content: '<p>content</p>',
        createTime: '2026-08-10 10:00:00',
        id: '1',
        messageType: 1,
        readStatus: 1,
        title: 'title',
      },
    ]);
    api.getUnreadCount.mockResolvedValue(0);
    api.markMessageRead.mockResolvedValue(undefined);

    await store.markRead('1');

    expect(api.markMessageRead).toHaveBeenCalledWith('1');
    expect(store.unreadCount).toBe(0);
    expect(store.notifications[0]).toMatchObject({ id: '1', isRead: true });
  });
});

describe('message store：SSE 主动关闭不产生错误日志', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    FakeEventSource.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('★ 主动 closeSse 后触发的 error 事件：不打印 error、不排重连', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    setActivePinia(createPinia());
    const store = useMessageStore();
    api.getSseTicket.mockResolvedValue({ ticket: 't1' });
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    await store.startSse();
    const source = sourceAt(0);
    // 主动关闭（典型场景：页面切换/登出），随后浏览器派发 error
    store.closeSse();
    source.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(errorSpy).not.toHaveBeenCalled();
    // 不应因为「主动关闭」触发重连的告警
    expect(warnSpy).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(api.getSseTicket).toHaveBeenCalledTimes(1);
  });

  it('★ 正常断线（未主动关闭）：打印 warn 并按退避重连', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    setActivePinia(createPinia());
    const store = useMessageStore();
    api.getSseTicket.mockResolvedValue({ ticket: 't1' });
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    await store.startSse();
    const source = sourceAt(0);
    source.dispatchEvent(new Event('error'));
    expect(warnSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeEventSource.instances.length).toBeGreaterThan(1);
    store.closeSse();
  });
});
