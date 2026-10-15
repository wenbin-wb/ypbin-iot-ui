/**
 * IoT 实时事件流客户端（SSE over fetch + ReadableStream）。
 *
 * 为什么不用 `EventSource`：它无法携带 `Authorization` 头，而实时流与其它 `/iot`
 * 接口共用 Bearer 鉴权 ⇒ 必须用 fetch 手动读流并自行按 SSE 协议分帧。
 *
 * 后端契约（`IotRealtimeController`，网关去 `/iot` 前缀）：
 * - `event: latest`        `data: { deviceId, propertyId, value, quality, ts }`
 * - `event: device-status` `data: { deviceId, status }`（单台启停）/ `{ deviceIds, status }`
 *   （批量启停）/ `{ deviceIds }`（批量删除；同时兼容 `deletedIds` 别名）
 * - `event: alert`         `data: { ...发布点上下文 }`（前端只把它当「告警发生变化」的刷新信号）
 * - 心跳是 `:hb` 这类注释行（无 data ⇒ 不派发事件）
 *
 * 连接策略：
 * - 断线指数退避自动重连（默认 1s→2s→…→上限 30s，带 ±20% 抖动）；
 * - `401/403` 不重连（token/权限不会靠重试变好，重试只会打爆日志）；
 * - `dispose()` 中止在途 fetch 并清掉重连定时器，之后不再有任何网络动作；
 * - 连接失败通过 `onError` + `onStateChange('reconnecting')` 暴露，
 *   调用方（composable / 页面）**必须**把它变成用户可见提示，不得静默。
 */
import { useAppConfig } from '@vben/hooks';
import { preferences } from '@vben/preferences';
import { useAccessStore } from '@vben/stores';

/** 后端会推送的事件名（未知事件名只 warn，不让整条流失效）。 */
export const IOT_REALTIME_EVENTS = [
  'alert',
  'device-status',
  'latest',
] as const;

export type IotRealtimeEventName = (typeof IOT_REALTIME_EVENTS)[number];

/** 连接状态：closed=未连接/disposed，connecting=首连中，live=流已打开，reconnecting=断线等待/重连中。 */
export type RealtimeConnectionState =
  | 'closed'
  | 'connecting'
  | 'live'
  | 'reconnecting';

/** `latest` 事件：一条点位最新值（`deviceId` 为后端 Long 的字符串形态）。 */
export interface IotRealtimeLatestPayload {
  deviceId?: null | number | string;
  propertyId?: null | string;
  quality?: null | string;
  ts?: null | number | string;
  value?: null | string;
  [key: string]: unknown;
}

/**
 * `device-status` 事件：设备启停/在线状态变化。
 *
 * 后端三类事件共用该事件名（`IotRealtimeService`）：
 * - 单台启停：`{ deviceId, status }`（`DeviceStatusEvent`）；
 * - 批量启停：`{ deviceIds, status }`（`DeviceStatusBatchEvent`）；
 * - 批量删除：`{ deviceIds }`（`DeviceDeletedBatchEvent`）。
 *
 * 同时容忍 `deletedIds` 别名（并行开发/未来契约调整时前端不因字段改名失联），
 * 页面用 {@link deviceStatusTouchesDevices} 统一判断是否命中当前可见行。
 */
export interface IotRealtimeDeviceStatusPayload {
  deviceId?: null | number | string;
  deviceIds?: Array<null | number | string> | null;
  deletedIds?: Array<null | number | string> | null;
  status?: null | number | string;
  [key: string]: unknown;
}

/**
 * `alert` 事件：后端发布点不同，可能只带单个 `deviceId`、也可能带 `deviceIds` 列表，
 * 甚至不带设备上下文 ⇒ 类型保持宽松，由 `alertTouchesDevice()` 统一判定。
 */
export interface IotRealtimeAlertPayload {
  deviceId?: null | number | string;
  deviceIds?: Array<null | number | string> | null;
  [key: string]: unknown;
}

/** 事件名 → payload 类型（composable 据此给页面 handler 推导）。 */
export interface IotRealtimeEventMap {
  alert: IotRealtimeAlertPayload;
  'device-status': IotRealtimeDeviceStatusPayload;
  latest: IotRealtimeLatestPayload;
}

/** 判定字符串是否为已知事件名。 */
export function isIotRealtimeEventName(
  value: string,
): value is IotRealtimeEventName {
  return (IOT_REALTIME_EVENTS as readonly string[]).includes(value);
}

/**
 * `device-status` 事件是否命中给定的一批设备 id。
 *
 * 规则（与 `alertTouchesDevice` 同口径）：
 * - payload 里所有 `deviceId` / `deviceIds` / `deletedIds` 归一化成字符串后与可见 id 求交集；
 * - 有交集 ⇒ true；
 * - 事件**完全不带**设备上下文（脏数据/契约变更）⇒ true（保守刷新：宁可多刷一次，不可漏刷）；
 * - 可见 id 为空（表格没有行）⇒ false（没有可刷新的目标）。
 */
export function deviceStatusTouchesDevices(
  payload: IotRealtimeDeviceStatusPayload | null | undefined,
  visibleDeviceIds: Iterable<null | number | string>,
): boolean {
  const visible = new Set<string>();
  for (const id of visibleDeviceIds) {
    const text = String(id ?? '').trim();
    if (text !== '') {
      visible.add(text);
    }
  }
  if (visible.size === 0) {
    return false;
  }
  if (!payload) {
    return true;
  }

  const touched: string[] = [];
  const collect = (value: null | number | string | undefined) => {
    const text = String(value ?? '').trim();
    if (text !== '') {
      touched.push(text);
    }
  };
  collect(payload.deviceId);
  for (const value of payload.deviceIds ?? []) {
    collect(value);
  }
  for (const value of payload.deletedIds ?? []) {
    collect(value);
  }
  if (touched.length === 0) {
    return true;
  }
  return touched.some((id) => visible.has(id));
}

/**
 * `alert` 事件是否与某个设备有关。
 *
 * - 事件带 `deviceId` / `deviceIds` ⇒ 精确匹配；
 * - 事件不带任何设备上下文 ⇒ 返回 true（保守刷新：宁可多刷一次，不可漏刷）；
 * - `deviceId` 为空（详情未打开）⇒ false。
 */
export function alertTouchesDevice(
  payload: IotRealtimeAlertPayload | null | undefined,
  deviceId: string,
): boolean {
  if (!deviceId) {
    return false;
  }
  if (!payload) {
    return true;
  }
  const ids: string[] = [];
  if (payload.deviceId !== undefined && payload.deviceId !== null) {
    ids.push(String(payload.deviceId));
  }
  for (const value of payload.deviceIds ?? []) {
    if (value !== undefined && value !== null && String(value) !== '') {
      ids.push(String(value));
    }
  }
  if (ids.length === 0) {
    return true;
  }
  return ids.includes(String(deviceId));
}

// ==================== SSE 分帧 ====================

/** 一个解析完的 SSE 帧（心跳注释不产生帧）。 */
export interface SseFrame {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

export type SseFrameListener = (frame: SseFrame) => void;

export interface SseStreamParser {
  /** 喂一段（已解码的）文本；可能 0 个或多个完整帧。 */
  feed(chunk: string): void;
  /** 丢弃当前未完成帧（连接重建时清空解析状态）。 */
  reset(): void;
}

/**
 * 创建增量 SSE 解析器（跨 chunk 缓冲）。
 *
 * 只实现本平台用到的字段：`event:` / `data:`（多行以 `\n` 连接）/ `id:` / `retry:`；
 * `:` 开头是注释（心跳）；空行结束一帧。行分隔符兼容 `\n`、`\r\n`、`\r`
 * （末尾单个 `\r` 会留到下一个 chunk，避免把拆开的 `\r\n` 记成两行）。
 */
export function createSseFrameParser(
  onFrame: SseFrameListener,
): SseStreamParser {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName = '';
  let lastId = '';
  let retry: number | undefined;

  function resetFrame() {
    dataLines = [];
    eventName = '';
    retry = undefined;
  }

  function dispatch() {
    // 只有 data 的帧才是事件；纯注释/纯 event 行不派发（SSE 规范语义）
    if (dataLines.length === 0) {
      resetFrame();
      return;
    }
    const frame: SseFrame = { data: dataLines.join('\n') };
    if (eventName !== '') {
      frame.event = eventName;
    }
    if (lastId !== '') {
      frame.id = lastId;
    }
    if (retry !== undefined) {
      frame.retry = retry;
    }
    onFrame(frame);
    resetFrame();
  }

  function consumeLine(line: string) {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) {
      // 注释行 = 心跳；不派发但证明连接还活着
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    switch (field) {
      case 'data': {
        dataLines.push(value);
        break;
      }
      case 'event': {
        eventName = value;
        break;
      }
      case 'id': {
        // 含 NUL 的 id 按 SSE 规范忽略
        if (!value.includes('\0')) {
          lastId = value;
        }
        break;
      }
      case 'retry': {
        if (/^\d+$/.test(value)) {
          retry = Number(value);
        }
        break;
      }
      default: {
        // 未知字段（如后端将来加的自定义字段）按规范忽略
        break;
      }
    }
  }

  return {
    feed(chunk: string) {
      buffer += chunk;
      while (true) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) {
          return;
        }
        // 末尾孤立 \r 可能是被拆开的 \r\n 前半个 ⇒ 等下一块
        if (match[0] === '\r' && match.index === buffer.length - 1) {
          return;
        }
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        consumeLine(line);
      }
    },
    reset() {
      buffer = '';
      dataLines = [];
      eventName = '';
      retry = undefined;
    },
  };
}

// ==================== 断线退避 ====================

export interface RealtimeBackoffOptions {
  /** 首次重连延迟（默认 1000ms）。 */
  baseMs?: number;
  /** 重连延迟上限（默认 30_000ms）。 */
  maxMs?: number;
  /** 抖动比例（默认 0.2 = 延迟最多下调 20%，防止多标签页同时重连）。 */
  jitter?: number;
}

export const DEFAULT_REALTIME_BACKOFF: Required<RealtimeBackoffOptions> = {
  baseMs: 1000,
  jitter: 0.2,
  maxMs: 30_000,
};

/**
 * 第 `attempt` 次重连的等待毫秒数：`min(max, base × 2^attempt)`，再乘抖动系数
 * `[1-jitter, 1]`（jitter=0 时完全确定，便于用例锁死行为）。
 */
export function reconnectDelayMs(
  attempt: number,
  options?: RealtimeBackoffOptions,
): number {
  const baseMs = options?.baseMs ?? DEFAULT_REALTIME_BACKOFF.baseMs;
  const maxMs = options?.maxMs ?? DEFAULT_REALTIME_BACKOFF.maxMs;
  const jitter = options?.jitter ?? DEFAULT_REALTIME_BACKOFF.jitter;
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const capped = Math.min(maxMs, baseMs * 2 ** safeAttempt);
  if (jitter <= 0) {
    return Math.round(capped);
  }
  const factor = 1 - jitter * Math.random();
  return Math.max(0, Math.round(capped * factor));
}

// ==================== 去抖 ====================

export interface TrailingDebounce {
  (): void;
  cancel(): void;
}

/** 尾部去抖：`waitMs` 内的多次调用只执行最后一次；`cancel()` 清掉待执行任务。 */
export function createTrailingDebounce(
  fn: () => void,
  waitMs: number,
): TrailingDebounce {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, waitMs);
  }) as TrailingDebounce;
  debounced.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return debounced;
}

// ==================== 客户端 ====================

export interface IotRealtimeClientOptions {
  backoff?: RealtimeBackoffOptions;
  /** 测试/特殊部署可注入 fetch；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  onError?: (error: Error) => void;
  onEvent?: (event: IotRealtimeEventName, payload: unknown) => void;
  /** 单帧 JSON 解析失败：只 warn/上报，**不断开流**（一帧坏数据不代表连接坏了）。 */
  onParseError?: (error: Error, frame: SseFrame) => void;
  onStateChange?: (state: RealtimeConnectionState) => void;
  /** 默认 `${apiURL}/iot/realtime/stream`；测试可覆盖。 */
  url?: string;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * SSE 客户端：`connect()` 后保持「断线 → 退避 → 重连」循环，直到 `dispose()`。
 *
 * 不自动重连的失败：`401/403`（鉴权/权限问题重试无意义，且会在日志里刷屏）。
 */
export class IotRealtimeClient {
  get connectionState(): RealtimeConnectionState {
    return this.state;
  }

  private abortController?: AbortController;

  private disposed = false;

  private readonly options: IotRealtimeClientOptions;

  private reconnectAttempt = 0;

  private reconnectTimer?: ReturnType<typeof setTimeout>;

  private state: RealtimeConnectionState = 'closed';

  constructor(options: IotRealtimeClientOptions = {}) {
    this.options = options;
  }

  /** 幂等：connecting/live 时重复调用不创建第二条连接。 */
  connect(): void {
    if (this.disposed || this.state === 'connecting' || this.state === 'live') {
      return;
    }
    void this.run();
  }

  /** 关闭连接与重连定时器；再次 `connect()` 不会生效（需新建实例）。 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearReconnectTimer();
    const controller = this.abortController;
    this.abortController = undefined;
    controller?.abort();
    this.setState('closed');
  }

  private buildHeaders(): Record<string, string> {
    const accessStore = useAccessStore();
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Accept-Language': preferences.app.locale,
      'Cache-Control': 'no-cache',
    };
    if (accessStore.accessToken) {
      headers.Authorization = `Bearer ${accessStore.accessToken}`;
    }
    return headers;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private handleFrame(frame: SseFrame): void {
    const event = frame.event;
    if (!event || !isIotRealtimeEventName(event)) {
      // 未知事件名不静默：warn 一次，方便后端新增事件时排障；但不断流。
      console.warn(`[iot/realtime] 忽略未知事件：${event ?? '(未命名)'}`);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data) as unknown;
    } catch (error) {
      this.options.onParseError?.(toError(error), frame);
      return;
    }
    this.options.onEvent?.(event, payload);
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseFrameParser((frame) => this.handleFrame(frame));
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
      // 冲刷多字节字符残片；未以空行结束的帧按 SSE 规范丢弃
      parser.feed(decoder.decode());
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // abort 后锁可能已被释放；这里不需要额外处理
      }
    }
  }

  private resolveUrl(): string {
    if (this.options.url) {
      return this.options.url;
    }
    const { apiURL } = useAppConfig(import.meta.env, import.meta.env.PROD);
    return `${apiURL}/iot/realtime/stream`;
  }

  private async run(): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    const fetchImpl = this.options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(this.resolveUrl(), {
        headers: this.buildHeaders(),
        method: 'GET',
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        this.options.onError?.(
          new Error(`realtime stream unauthorized (HTTP ${response.status})`),
        );
        this.setState('closed');
        return;
      }
      if (!response.ok) {
        throw new Error(`realtime stream HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new Error('realtime stream has no body');
      }
      this.setState('live');
      // 成功建立了连接 ⇒ 退避重新从 base 起算（长时间稳定后的偶发断线不背历史次数）
      this.reconnectAttempt = 0;
      await this.readStream(response.body);
      if (!this.disposed) {
        // 服务端正常关流（部署/网关超时）：仍按断线处理，自动重连
        this.scheduleReconnect();
      }
    } catch (error) {
      if (this.disposed || controller.signal.aborted) {
        return;
      }
      this.options.onError?.(toError(error));
      this.scheduleReconnect();
    } finally {
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) {
      return;
    }
    this.setState('reconnecting');
    const delayMs = reconnectDelayMs(
      this.reconnectAttempt,
      this.options.backoff,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.run();
    }, delayMs);
  }

  private setState(next: RealtimeConnectionState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.options.onStateChange?.(next);
  }
}
