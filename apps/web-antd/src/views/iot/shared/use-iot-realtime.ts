/**
 * IoT 实时事件订阅 composable：**模块级单例连接 + 页面级订阅/自动清理**。
 *
 * 设计取舍：
 * - 一个标签页只开一条 SSE（后端按租户推流），多个页面/组件共享同一连接；
 * - 订阅计数控制连接生命周期：第一个订阅者建立连接，最后一个取消后 `dispose()`，
 *   离开页面不会把流挂在后台；
 * - 无 accessToken 时不建连（SSE 同样要 Bearer 鉴权；也避免登录页/单测打无意义请求）；
 * - 连接失败：`state` 变 `reconnecting`、`error` 记最近错误、`console.warn` 留痕；
 *   页面据此渲染「实时连接中断」可见提示（不得静默）；
 * - 鉴权失败（401/403）：`authError` 置 `unauthorized`/`forbidden` 并把**旧 client 销毁**，
 *   让下一次订阅能重建连接（否则 ATT 过期/重登后单例永远停在 `unauthorized`，不自愈）。
 *   客户端本身不自动登出（避免登出→重订阅→再 401 的循环），页面据此给「重新登录」入口。
 *
 * 用法：
 * ```ts
 * const { onEvent, state: realtimeState, error: realtimeError } = useIotRealtime();
 * onEvent('alert', () => scheduleRefresh());
 * onScopeDispose/组件卸载时自动退订（内部用 onScopeDispose，无需手工 off）。
 * ```
 */
import type { Ref } from 'vue';

import type {
  IotRealtimeEventMap,
  IotRealtimeEventName,
  RealtimeAuthStatus,
  RealtimeConnectionState,
} from '#/api/iot/realtime';

import { getCurrentScope, onScopeDispose, ref } from 'vue';

import { useAccessStore } from '@vben/stores';

import { IotRealtimeClient, IotRealtimeTimeoutError } from '#/api/iot/realtime';
import { $t } from '#/locales';

export type IotRealtimeHandler<K extends IotRealtimeEventName> = (
  payload: IotRealtimeEventMap[K],
) => void;

/** 鉴权失败态：空串=无鉴权问题；401 → `unauthorized`，403 → `forbidden`。 */
export type IotRealtimeAuthError = '' | 'forbidden' | 'unauthorized';

interface RealtimeHub {
  authError: Ref<IotRealtimeAuthError>;
  error: Ref<string>;
  onEvent: <K extends IotRealtimeEventName>(
    event: K,
    handler: IotRealtimeHandler<K>,
  ) => () => void;
  state: Ref<RealtimeConnectionState>;
}

let hub: RealtimeHub | undefined;

/** 未登录（或 store 未初始化）时不建立匿名 SSE。 */
function hasAccessToken(): boolean {
  try {
    return Boolean(useAccessStore().accessToken);
  } catch {
    return false;
  }
}

/** 401/403 → 页面展示用的鉴权失败类型（403 是权限问题，不该引导「重新登录」）。 */
function toAuthError(status: RealtimeAuthStatus): IotRealtimeAuthError {
  return status === 403 ? 'forbidden' : 'unauthorized';
}

function createHub(): RealtimeHub {
  const authError = ref<IotRealtimeAuthError>('');
  const error = ref('');
  const state = ref<RealtimeConnectionState>('closed');
  const handlers = new Map<
    IotRealtimeEventName,
    Set<(payload: unknown) => void>
  >();
  let client: IotRealtimeClient | undefined;
  let subscriberCount = 0;

  /**
   * 鉴权失败后销毁旧 client（并置空），使下一次 `subscribe()` 能重新建连。
   *
   * 为什么必须置空：`ensureClient()` 用 `client !== undefined` 短路，旧 client 停在
   * `unauthorized` 时不会再产生任何网络动作 ⇒ 用户重新登录后仍然没有实时数据。
   */
  function resetClientAfterAuthFailure() {
    const failed = client;
    client = undefined;
    failed?.dispose();
  }

  function ensureClient() {
    if (client !== undefined || !hasAccessToken()) {
      return;
    }
    client = new IotRealtimeClient({
      onAuthError: (status) => {
        authError.value = toAuthError(status);
        resetClientAfterAuthFailure();
      },
      onError: (err) => {
        // 超时类错误在上层给用户可读文案（API 层不引 i18n，见 realtime.ts 注释）
        const heartbeatTimeout =
          err instanceof IotRealtimeTimeoutError &&
          err.reason === 'heartbeat-timeout';
        error.value = heartbeatTimeout
          ? $t('page.iot.realtime.heartbeatTimeout')
          : err.message;
        console.warn('[iot/realtime] 实时连接异常，页面将自动重连：', err);
      },
      onEvent: (event, payload) => {
        for (const handler of handlers.get(event) ?? []) {
          handler(payload);
        }
      },
      onStateChange: (next) => {
        state.value = next;
        if (next === 'live') {
          // 连接成功 = 鉴权已通过；清掉鉴权失败横幅（避免重登成功后还挂着旧告警）
          authError.value = '';
        }
      },
    });
    client.connect();
  }

  function subscribe<K extends IotRealtimeEventName>(
    event: K,
    handler: IotRealtimeHandler<K>,
  ): () => void {
    // 每次订阅都尝试拉起连接：首次订阅时 token 尚未就绪、后续组件再订阅时应补偿建连；
    // 鉴权失败后旧 client 已被置空 ⇒ 这里的订阅就是自愈入口
    ensureClient();
    subscriberCount += 1;
    const wrapped = (payload: unknown) => {
      handler(payload as IotRealtimeEventMap[K]);
    };
    const listeners = handlers.get(event) ?? new Set();
    listeners.add(wrapped);
    handlers.set(event, listeners);
    return () => {
      listeners.delete(wrapped);
      if (listeners.size === 0) {
        handlers.delete(event);
      }
      subscriberCount = Math.max(0, subscriberCount - 1);
      if (subscriberCount === 0) {
        client?.dispose();
        client = undefined;
        authError.value = '';
        error.value = '';
        state.value = 'closed';
      }
    };
  }

  return { authError, error, onEvent: subscribe, state };
}

/**
 * 在组件 setup 中订阅实时事件；组件卸载（scope dispose）时自动退订。
 * 返回的 `state/error/authError` 是模块级 ref，页面直接用于展示连接状态。
 */
export function useIotRealtime() {
  hub ??= createHub();
  const current = hub;
  const cleanups: Array<() => void> = [];
  if (getCurrentScope()) {
    onScopeDispose(() => {
      while (cleanups.length > 0) {
        cleanups.pop()?.();
      }
    });
  }

  function onEvent<K extends IotRealtimeEventName>(
    event: K,
    handler: IotRealtimeHandler<K>,
  ): () => void {
    const off = current.onEvent(event, handler);
    cleanups.push(off);
    return () => {
      off();
      const index = cleanups.indexOf(off);
      if (index !== -1) {
        cleanups.splice(index, 1);
      }
    };
  }

  return {
    authError: current.authError,
    error: current.error,
    onEvent,
    state: current.state,
  };
}
