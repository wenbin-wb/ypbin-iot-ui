import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `shared/use-iot-realtime.ts` 的鉴权失败自愈契约（P1-1）。
 *
 * 守门的不变量（每一条都对应一个会真实伤人的失败模式）：
 * 1. 401/403 ⇒ `authError` 置 `unauthorized`/`forbidden`（页面据此渲染常驻提示）；
 * 2. 鉴权失败 ⇒ **销毁旧 client 并置空**，下一次 `subscribe()` 必须重建连接
 *    —— 否则用户重新登录后单例仍停在旧 client 上，实时数据永远不恢复；
 * 3. 连接成功（`live`）⇒ 清空 authError（避免重登成功后还挂着旧横幅）；
 * 4. 心跳超时错误 ⇒ 映射成 i18n key（UI 层文案，不是英文原始串）；
 * 5. 最后一个订阅者退订 ⇒ 销毁 client 并清空状态（不会把流挂在后台）。
 *
 * 用模块级动态导入 + `vi.resetModules()`：composable 的 hub 是单例，必须每个用例拿干净实例。
 */

const { clients, tokenState } = vi.hoisted(() => ({
  clients: [] as any[],
  tokenState: { value: 'token-1' as null | string },
}));

vi.mock('#/api/iot/realtime', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  class FakeClient {
    connect = vi.fn();

    dispose = vi.fn();

    options: Record<string, any>;

    constructor(options: Record<string, any>) {
      this.options = options;
      clients.push(this);
    }
  }
  return { ...actual, IotRealtimeClient: FakeClient };
});

vi.mock('@vben/stores', () => ({
  useAccessStore: () => ({
    get accessToken() {
      return tokenState.value;
    },
  }),
}));

/** 真实 i18n 不参与本用例（只断言键名映射），避免引入语言包初始化开销。 */
vi.mock('#/locales', () => ({
  $t: (key: string) => key,
}));

type RealtimeModule = typeof import('../shared/use-iot-realtime');

async function loadComposable(): Promise<RealtimeModule> {
  vi.resetModules();
  return import('../shared/use-iot-realtime');
}

async function flushAsync() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  clients.length = 0;
  tokenState.value = 'token-1';
  vi.resetModules();
});

describe('useIotRealtime：鉴权失败后销毁单例并允许下次订阅重建', () => {
  it('★ 401 ⇒ authError=unauthorized，旧 client 被 dispose；再次订阅会重建新 client', async () => {
    const { useIotRealtime } = await loadComposable();
    const realtime = useIotRealtime();
    const off = realtime.onEvent('alert', () => {});
    await flushAsync();
    expect(clients).toHaveLength(1);
    expect(clients[0]?.connect).toHaveBeenCalledTimes(1);

    // 客户端上报 401（真实实现里由 fetch 响应的 401/403 触发）
    clients[0]?.options.onAuthError?.(401);
    await flushAsync();
    expect(realtime.authError.value).toBe('unauthorized');
    expect(clients[0]?.dispose).toHaveBeenCalledTimes(1);

    // 「重新登录后」页面再次订阅 ⇒ 必须能重建连接（旧实现 client 不置空 ⇒ 这里恒为 1 个）
    const offSecond = realtime.onEvent('latest', () => {});
    await flushAsync();
    expect(clients).toHaveLength(2);
    expect(clients[1]?.connect).toHaveBeenCalledTimes(1);

    // 新连接进入 live ⇒ 鉴权失败横幅清除
    clients[1]?.options.onStateChange?.('live');
    expect(realtime.authError.value).toBe('');

    off();
    offSecond();
    expect(clients[1]?.dispose).toHaveBeenCalledTimes(1);
    expect(realtime.state.value).toBe('closed');
    expect(realtime.authError.value).toBe('');
  });

  it('★ 403 ⇒ authError=forbidden（与 401 区分：登出解决不了权限缺失）', async () => {
    const { useIotRealtime } = await loadComposable();
    const realtime = useIotRealtime();
    const off = realtime.onEvent('alert', () => {});
    await flushAsync();

    clients[0]?.options.onAuthError?.(403);
    await flushAsync();
    expect(realtime.authError.value).toBe('forbidden');
    expect(clients[0]?.dispose).toHaveBeenCalledTimes(1);

    off();
  });

  it('★ 心跳超时错误映射成 i18n key（页面展示可读文案，不是英文原始串）', async () => {
    const { useIotRealtime } = await loadComposable();
    const { IotRealtimeTimeoutError } = await import('#/api/iot/realtime');
    const realtime = useIotRealtime();
    const off = realtime.onEvent('alert', () => {});
    await flushAsync();

    clients[0]?.options.onError?.(
      new IotRealtimeTimeoutError('heartbeat-timeout'),
    );
    expect(realtime.error.value).toBe('page.iot.realtime.heartbeatTimeout');

    // 其它错误仍展示原始 message（例如 HTTP 502 的排障信息）
    clients[0]?.options.onError?.(new Error('realtime stream HTTP 502'));
    expect(realtime.error.value).toBe('realtime stream HTTP 502');

    off();
  });

  it('未登录（无 token）时不建连；token 就绪后订阅会补偿建连', async () => {
    tokenState.value = null;
    const { useIotRealtime } = await loadComposable();
    const realtime = useIotRealtime();
    const off = realtime.onEvent('alert', () => {});
    await flushAsync();
    expect(clients).toHaveLength(0);

    // 登录完成后 token 就绪，另一个组件订阅 ⇒ 建连（注释承诺的「补偿建连」）
    tokenState.value = 'token-after-login';
    const offSecond = realtime.onEvent('latest', () => {});
    await flushAsync();
    expect(clients).toHaveLength(1);

    off();
    offSecond();
  });
});
