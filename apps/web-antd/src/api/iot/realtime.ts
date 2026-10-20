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
 * - `event: alert`         `data: { action, instanceIds, ruleIds, count, minutes }`
 *   （`IotRealtimeService.AlertEvent`，2026-10-20 核实；前端只把它当「告警发生变化」的刷新信号）
 * - 心跳是 `:hb` 这类注释行（无 data ⇒ 不派发事件），后端每 15s 发一次
 *
 * 连接策略：
 * - 断线指数退避自动重连（默认 1s→2s→…→上限 30s，带 ±20% 抖动）；
 * - `401/403` 不重连也不自动登出：状态置 `unauthorized` 并回调 `onAuthError(status)`。
 *   为什么不在客户端直接登出：登出会触发页面重订阅 → 新流再次 401 的循环，
 *   且 403 是「该角色无实时权限」而非会话过期，登出并不能解决问题。页面据此给出
 *   可见提示 + 「重新登录」入口（401）或权限说明（403）。
 * - 心跳看门狗：超过 `heartbeatTimeoutMs`（默认 45s = 3 × 后端 15s 心跳）**没有任何字节**
 *   （心跳注释也算）即中止当前流并按既有退避重连——半开连接（休眠/代理静默丢包）时
 *   `reader.read()` 永不返回，没有看门狗就会永远停在「实时」假活状态；
 * - 建连超时：`connectTimeoutMs`（默认 15s）内没拿到响应头即中止并退避重连，
 *   避免网络黑洞时永远停在 `connecting`；
 * - `dispose()` 中止在途 fetch、清掉重连定时器与看门狗，之后不再有任何网络动作；
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

/**
 * 连接状态。
 *
 * - `closed`：未连接 / 已 disposed；
 * - `connecting`：首连中；
 * - `live`：流已打开；
 * - `reconnecting`：断线等待或重连中；
 * - `unauthorized`：鉴权失败（401/403）。**不再自动重连**（重试不会让 token/权限变好），
 *   也不自动登出；由页面渲染可见提示并在 401 时提供「重新登录」入口。
 */
export type RealtimeConnectionState =
  | 'closed'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'unauthorized';

/** 鉴权失败状态码：401=会话过期/未登录，403=已登录但无该端点权限。 */
export type RealtimeAuthStatus = 401 | 403;

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
 * `alert` 事件：**告警状态变化信号**，不是告警实例快照。
 *
 * 后端契约（`IotRealtimeService.AlertEvent`，2026-10-20 对照后端源码更正）：
 * `action` ∈ `ack`（确认）/ `silence`（静默）/ `resolve`（收口），
 * `instanceIds` 为涉及的告警实例 id（收口时为 `null`），
 * `ruleIds` 为涉及的规则 id（确认/静默时为 `null`），
 * `count` 为本次生效条数，`minutes` 仅静默动作有值。
 *
 * 关键事实：**该事件不带 deviceId/deviceIds**，因此严格意义上的「按设备精确刷新」
 * 在该事件上做不到；前端只把它当「告警列表/规则/摘要需要刷新」的信号（保守刷新）。
 * 类型仍保留宽松的 `deviceId/deviceIds` 与索引签名：既兼容历史负载/并行开发期的别名，
 * 也避免后端将来加字段时前端整条流失效——宽松不等于把不确定当确定，消费方必须按
 * {@link alertTouchesDevice} 的保守规则处理。
 */
export interface IotRealtimeAlertPayload {
  /** 动作：ack / silence / resolve。 */
  action?: null | string;
  /** 本次生效条数。 */
  count?: null | number;
  /** 涉及的告警实例 id（收口时为 null）。 */
  instanceIds?: Array<null | number | string> | null;
  /** 静默分钟数（仅 silence 动作有值）。 */
  minutes?: null | number;
  /** 涉及的规则 id（确认/静默时为 null）。 */
  ruleIds?: Array<null | number | string> | null;
  /** 历史/别名兼容字段（当前后端不发送，见上方契约说明）。 */
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

// ==================== 心跳 / 建连超时 ====================

/**
 * 心跳看门狗判定阈值（默认 45s）。
 *
 * 为什么是 45s：后端心跳间隔 15s（`ypbin.sse.heartbeat-interval-seconds`），3 个心跳周期内
 * 一个字节都没收到，即可判定连接已半开（休眠/NAT 空闲超时/代理静默丢弃），而不是偶发抖动。
 */
export const DEFAULT_REALTIME_HEARTBEAT_TIMEOUT_MS = 45_000;

/** 建连超时（默认 15s）：超过这个时间没拿到响应头，视为网络黑洞，中止后走退避重连。 */
export const DEFAULT_REALTIME_CONNECT_TIMEOUT_MS = 15_000;

/** 看门狗检查间隔（默认 5s）：只做廉价时间比较，不必每个心跳周期都查。 */
export const REALTIME_HEARTBEAT_CHECK_INTERVAL_MS = 5000;

/** 超时原因：`connect-timeout`=建连超时，`heartbeat-timeout`=心跳/空闲超时。 */
export type IotRealtimeTimeoutReason = 'connect-timeout' | 'heartbeat-timeout';

/**
 * 实时流超时错误。
 *
 * 为什么带结构化 `reason`：API 层不引 i18n（`api/**` 零 `$t` 约定），但页面需要把
 * 「心跳超时」翻译成用户能懂的话（`page.iot.realtime.heartbeatTimeout`）；
 * 用 `instanceof + reason` 让 UI 层映射文案，而不是让页面去 `includes` 英文错误串。
 */
export class IotRealtimeTimeoutError extends Error {
  readonly reason: IotRealtimeTimeoutReason;

  constructor(reason: IotRealtimeTimeoutReason) {
    super(`realtime stream ${reason}`);
    this.name = 'IotRealtimeTimeoutError';
    this.reason = reason;
  }
}

// ==================== 客户端 ====================

export interface IotRealtimeClientOptions {
  backoff?: RealtimeBackoffOptions;
  /** 建连超时（默认 {@link DEFAULT_REALTIME_CONNECT_TIMEOUT_MS}）；`<=0` 表示关闭。 */
  connectTimeoutMs?: number;
  /** 测试/特殊部署可注入 fetch；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 心跳/空闲超时（默认 {@link DEFAULT_REALTIME_HEARTBEAT_TIMEOUT_MS}）；`<=0` 表示关闭看门狗。 */
  heartbeatTimeoutMs?: number;
  /**
   * 鉴权失败（401/403）回调：回调时连接状态已是 `unauthorized`、且**不会**自动重连。
   * 客户端刻意不自动登出（见模块头注释），由调用方决定展示什么、是否引导重新登录。
   */
  onAuthError?: (status: RealtimeAuthStatus) => void;
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
 * 不自动重连的失败：`401/403`（鉴权/权限问题重试无意义，且会在日志里刷屏）——
 * 状态置 `unauthorized`、回调 `onAuthError`，**不自动登出**（避免登出/重订阅循环）。
 */
export class IotRealtimeClient {
  get connectionState(): RealtimeConnectionState {
    return this.state;
  }

  private abortController?: AbortController;

  private disposed = false;

  /** 心跳看门狗定时器（仅 live 期间存在）。 */
  private heartbeatWatchdog?: ReturnType<typeof setInterval>;

  /** 最后一次收到任意字节（含心跳注释）的时刻；看门狗据此判定半开连接。 */
  private lastActivityAt = 0;

  private readonly options: IotRealtimeClientOptions;

  private reconnectAttempt = 0;

  private reconnectTimer?: ReturnType<typeof setTimeout>;

  private state: RealtimeConnectionState = 'closed';

  constructor(options: IotRealtimeClientOptions = {}) {
    this.options = options;
  }

  /**
   * 幂等：connecting/live/reconnecting 时重复调用不会创建第二条流。
   *
   * `reconnecting` 必须一起守住：该状态下已排好重连定时器，再 `connect()` 会立刻
   * 起第二条流并覆盖 `abortController`（第一条失去中止句柄 ⇒ dispose 也杀不掉，泄漏连接）。
   * `unauthorized` 允许显式 `connect()`：鉴权失败后不自动重试，但页面/调用方在重新登录后
   * 可以主动重连（仍然只建一条流，因为 `run()` 会先覆盖 `abortController` 并置 connecting）。
   */
  connect(): void {
    if (
      this.disposed ||
      this.state === 'connecting' ||
      this.state === 'live' ||
      this.state === 'reconnecting'
    ) {
      return;
    }
    void this.run();
  }

  /** 关闭连接、重连定时器与心跳看门狗；再次 `connect()` 不会生效（需新建实例）。 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearReconnectTimer();
    this.stopHeartbeatWatchdog();
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

  /** 收到任意字节（含心跳注释）即刷新活动时间；看门狗只看「多久没动静」。 */
  private markActivity(): void {
    this.lastActivityAt = Date.now();
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
        // 收到任意字节都算「活着」：心跳是一行注释，解析器不派发事件，但看门狗必须知道它到了
        this.markActivity();
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
    const connectTimeoutMs =
      this.options.connectTimeoutMs ?? DEFAULT_REALTIME_CONNECT_TIMEOUT_MS;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let connectTimedOut = false;
    const clearConnectTimer = () => {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    };
    if (connectTimeoutMs > 0) {
      // 建连超时只覆盖「等响应头」这一段：拿到响应后立即清表，不能误伤长连接的事件流
      connectTimer = setTimeout(() => {
        connectTimer = undefined;
        connectTimedOut = true;
        controller.abort();
      }, connectTimeoutMs);
    }
    try {
      const response = await fetchImpl(this.resolveUrl(), {
        headers: this.buildHeaders(),
        method: 'GET',
        signal: controller.signal,
      });
      clearConnectTimer();
      if (response.status === 401 || response.status === 403) {
        // 401=会话过期，403=无实时端点权限：两者都不自动重连、也不自动登出，
        // 交给页面渲染可见提示（并在 401 时提供「重新登录」入口）。
        const status: RealtimeAuthStatus = response.status;
        this.options.onError?.(
          new Error(
            status === 401
              ? 'realtime stream unauthorized (HTTP 401)'
              : 'realtime stream forbidden (HTTP 403)',
          ),
        );
        this.setState('unauthorized');
        this.options.onAuthError?.(status);
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
      this.startHeartbeatWatchdog(controller);
      await this.readStream(response.body);
      this.stopHeartbeatWatchdog();
      if (!this.disposed) {
        // 服务端正常关流（部署/网关超时）：仍按断线处理，自动重连
        this.scheduleReconnect();
      }
    } catch (error) {
      this.stopHeartbeatWatchdog();
      if (this.disposed) {
        return;
      }
      if (controller.signal.aborted) {
        if (connectTimedOut) {
          // 建连超时是我们自己 abort 的：必须上报 + 继续退避，不能像 dispose 一样静默
          this.options.onError?.(
            new IotRealtimeTimeoutError('connect-timeout'),
          );
          this.scheduleReconnect();
        }
        // 心跳超时的重连已由看门狗排好；dispose 则不需要任何后续动作
        return;
      }
      this.options.onError?.(toError(error));
      this.scheduleReconnect();
    } finally {
      clearConnectTimer();
      this.stopHeartbeatWatchdog();
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

  /**
   * 启动心跳看门狗（仅 live 期间）。
   *
   * 用固定间隔轮询 `lastActivityAt` 而不是给每次 read 单独设超时：`reader.read()` 在
   * TCP 半开时既不 resolve 也不 reject，只能靠外部定时器发现「长时间没有任何字节」。
   * 超时后先停表再 abort，避免 abort 触发的 catch 里重复上报/重复排重连。
   */
  private startHeartbeatWatchdog(controller: AbortController): void {
    this.stopHeartbeatWatchdog();
    const timeoutMs =
      this.options.heartbeatTimeoutMs ?? DEFAULT_REALTIME_HEARTBEAT_TIMEOUT_MS;
    // <=0 显式关闭看门狗（特殊部署/测试需要完全静止的流）
    if (timeoutMs <= 0) {
      return;
    }
    this.markActivity();
    this.heartbeatWatchdog = setInterval(() => {
      if (Date.now() - this.lastActivityAt < timeoutMs) {
        return;
      }
      this.stopHeartbeatWatchdog();
      this.options.onError?.(new IotRealtimeTimeoutError('heartbeat-timeout'));
      controller.abort();
      // abort 让 readStream 以 AbortError 退出；catch 见到 aborted 会静默返回，
      // 所以这里必须显式排重连（否则半开连接 abort 后就再也不连了）。
      this.scheduleReconnect();
    }, REALTIME_HEARTBEAT_CHECK_INTERVAL_MS);
  }

  private stopHeartbeatWatchdog(): void {
    if (this.heartbeatWatchdog !== undefined) {
      clearInterval(this.heartbeatWatchdog);
      this.heartbeatWatchdog = undefined;
    }
  }
}
