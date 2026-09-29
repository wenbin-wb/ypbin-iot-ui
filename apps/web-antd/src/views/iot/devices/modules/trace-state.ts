import type { IotDeviceTraceApi } from '#/api/iot';

/**
 * 消息跟踪页的**纯逻辑**（状态映射 + 空态/失败态判定 + 边界提示）。
 *
 * 为什么单独抽出来：这些判断决定用户「看到的是真相还是误判」——
 * 「这批到底是没消息还是查询失败」「上行没有条目是不是说明设备没上报」。
 * 它们零依赖（不 import vue / antdv），因此可以直接跑用例；页面只负责渲染结论。
 *
 * 🔴 两条来自本仓既有事故的防线在这里被**结构化**：
 * 1. **失败态与空态分离**：请求失败绝不能画成「这台设备最近没有消息」
 *    （与设备台账、批量导入页同一判据）；
 * 2. **能力边界必须显式**：上行链路有看不见的断点（一期无痕迹），
 *    页面必须把这件事说清楚，不能让"没有上行条目"被读成"设备没上报"。
 */

/** 时间线列表的加载态（三分：加载中、失败、空）。 */
export type TraceListState = 'empty' | 'error' | 'loading' | 'ready';

/**
 * 判定列表该显示哪种状态。
 *
 * 🔴 顺序有意：**失败优先于空**。先判 error 再判空，页面才不会在请求失败时
 * 显示「这台设备最近没有消息」——那是把失败画成了事实。
 *
 * @param loading 是否正在加载
 * @param errorMessage 加载失败原因（非空即失败）
 * @param itemCount 已拿到的条目数
 * @returns 列表状态
 */
export function resolveTraceListState(
  loading: boolean,
  errorMessage: string,
  itemCount: number,
): TraceListState {
  if (loading) {
    return 'loading';
  }
  if (errorMessage) {
    return 'error';
  }
  return itemCount > 0 ? 'ready' : 'empty';
}

/**
 * 结果码 → antdv Tag 颜色。
 *
 * @param outcome 结果码
 * @returns Tag 颜色
 */
export function outcomeColor(outcome?: string): string {
  switch (outcome) {
    case 'failed': {
      return 'error';
    }
    case 'ok': {
      return 'success';
    }
    case 'timeout': {
      return 'warning';
    }
    default: {
      // 未知≠失败：一期"上行已受理"就是 unknown，标红会让用户以为出错了
      return 'default';
    }
  }
}

/**
 * 结果码 → i18n 键。
 *
 * @param outcome 结果码
 * @returns i18n 键；未知回落到 unknown（**绝不返回空串**：空标签比"未知"更糟）
 */
export function outcomeLabelKey(outcome?: string): string {
  switch (outcome) {
    case 'failed': {
      return 'page.iot.device.trace.outcomeFailed';
    }
    case 'ok': {
      return 'page.iot.device.trace.outcomeOk';
    }
    case 'timeout': {
      return 'page.iot.device.trace.outcomeTimeout';
    }
    default: {
      return 'page.iot.device.trace.outcomeUnknown';
    }
  }
}

/**
 * 方向码 → i18n 键。
 *
 * @param direction 方向码
 * @returns i18n 键
 */
export function directionLabelKey(direction?: string): string {
  switch (direction) {
    case 'down': {
      return 'page.iot.device.trace.directionDown';
    }
    case 'up': {
      return 'page.iot.device.trace.directionUp';
    }
    default: {
      return 'page.iot.device.trace.directionInternal';
    }
  }
}

/**
 * 阶段码 → i18n 键。
 *
 * @param stage 阶段码
 * @returns i18n 键
 */
export function stageLabelKey(stage?: string): string {
  switch (stage) {
    case 'device-offline': {
      return 'page.iot.device.trace.stageDeviceOffline';
    }
    case 'down-ack': {
      return 'page.iot.device.trace.stageDownAck';
    }
    case 'down-enqueued': {
      return 'page.iot.device.trace.stageDownEnqueued';
    }
    case 'down-published': {
      return 'page.iot.device.trace.stageDownPublished';
    }
    case 'event-reported': {
      return 'page.iot.device.trace.stageEventReported';
    }
    case 'up-received': {
      return 'page.iot.device.trace.stageUpReceived';
    }
    default: {
      return 'page.iot.device.trace.stageUnknown';
    }
  }
}

/**
 * 是否需要给这条提示「已重发 N 次（历史时刻已被覆盖）」。
 *
 * 🔴 判据取**服务端给的 `historyOverwritten`**，而不是本地看 `retryCount > 0`：
 * 后端已经按"重发会就地覆写 sent_at/finished_at"的事实算好了，两边各算一次必然漂移。
 * 但**缺失该字段时要能回落到 retryCount**（老后端/字段被裁时仍要提示，宁可多提示）。
 *
 * @param item 条目
 * @returns 需要提示返回 true
 */
export function needsRetryHint(item: IotDeviceTraceApi.Item): boolean {
  if (item.historyOverwritten === true) {
    return true;
  }
  const retry = Number(item.retryCount ?? 0);
  return Number.isFinite(retry) && retry > 0;
}

/**
 * 是否有可展示的定位建议（有 summary 且有至少一条动作）。
 *
 * 判据是"有没有**动作**"而不是"有没有 advice 对象"：一条没有动作的建议等于没有建议，
 * 展示出来只会占地方。
 *
 * @param item 条目
 * @returns 可展示返回 true
 */
export function hasAdvice(item: IotDeviceTraceApi.Item): boolean {
  const advice = item.advice;
  return Boolean(advice && advice.summary && (advice.actions?.length ?? 0) > 0);
}

/**
 * 是否要显示"结果被截断"的提示。
 *
 * @param resp 响应（可能为空）
 * @returns 显示返回 true
 */
export function showsTruncationHint(
  resp?: IotDeviceTraceApi.TimelineResp | null,
): boolean {
  return resp?.truncated === true;
}

/**
 * 是否有"该条目需要用户关注"（失败/超时/未知且没有归因码）。
 *
 * 用途是给失败条目加视觉强调；**不含 unknown 的普通上行条目**——
 * 上行受理是一期无法判定的正常态，染红会让用户以为每次上报都出错。
 *
 * @param item 条目
 * @returns 需要关注返回 true
 */
export function needsAttention(item: IotDeviceTraceApi.Item): boolean {
  return item.outcome === 'failed' || item.outcome === 'timeout';
}

/**
 * 把 ISO 时间字符串安全地转成显示文本。
 *
 * 为什么不用 `new Date(x).toLocaleString()` 直接算：后端可能给 `null`/空串/非法值，
 * 那会渲染成 `Invalid Date`，比空白更难排查。
 *
 * @param value ISO 字符串（可空）
 * @returns 显示文本；无法解析时返回占位符
 */
export function formatTraceTime(value?: null | string): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
