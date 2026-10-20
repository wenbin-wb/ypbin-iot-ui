import type { ListState } from '../../shared/list-state';

import type { IotDeviceTraceApi } from '#/api/iot';

import { resolveListState } from '../../shared/list-state';

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
export type TraceListState = ListState;

/**
 * 判定列表该显示哪种状态。
 *
 * 判据已收口到 `../../shared/list-state`（`resolveListState`）：本函数只保留原导出名与
 * 位置参数签名，行为零漂移。顺序仍是「loading > error > empty/ready」——
 * **失败优先于空**（请求失败时显示「这台设备最近没有消息」就是把失败画成了事实），
 * 由公共用例守门。
 */
export function resolveTraceListState(
  loading: boolean,
  errorMessage: string,
  itemCount: number,
): TraceListState {
  return resolveListState({ errorMessage, itemCount, loading });
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
    case 'up-discarded': {
      return 'page.iot.device.trace.stageUpDiscarded';
    }
    case 'up-persisted': {
      return 'page.iot.device.trace.stageUpPersisted';
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

// ---------------------------------------------------------------------------
// 二批（上行结构化补齐）：落库/丢弃展示与原因码定位规则
// ---------------------------------------------------------------------------

/** 二批：上行回执行性质码（与后端 `receipt_status` 逐字一致）。 */
export const RECEIPT_STATUS = {
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
} as const;

/**
 * 二批：丢弃原因码中**本页规则会用到**的两个（后端 `MqttIngestRejectReason`）。
 *
 * 只列规则用到的码，其余 12 码不在此处映射——规则不命中时返回 null，
 * 由页面显式显示「暂无定位建议」+ 原始 `discardReason`（**不硬凑建议**）。
 */
export const DISCARD_REASON = {
  /** 整批读数都未通过点位映射校验。 */
  NO_ACCEPTED_ITEM: 'NO_ACCEPTED_ITEM',
  /** 报文声明的设备不存在。 */
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
} as const;

/** 二批：定位建议规则 id（与后端 `advice.ruleId` 同一命名空间）。 */
export const TRACE_RULE = {
  /** 整批被拒，原因=点位未映射。 */
  UP_REJECTED_MAP: 'UP_REJECTED_MAP',
  /** 已受理但部分丢弃。 */
  UP_PARTIAL: 'UP_PARTIAL',
  /** 设备不存在。 */
  UP_DEVICE_NOT_FOUND: 'UP_DEVICE_NOT_FOUND',
} as const;

/** 二批：前端可自行推导的定位建议（只含 i18n 键，文案不在逻辑层硬编码）。 */
export interface DerivedAdvice {
  /** 规则标识（与后端 advice.ruleId 同口径，便于用户指认）。 */
  ruleId: string;
  /** 一句话结论的 i18n 键。 */
  summaryKey: string;
  /** 可执行动作的 i18n 键（非空）。 */
  actionKeys: string[];
}

/**
 * 是否要显示「落库与批次」这一格。
 *
 * 判据是**有没有任一二批字段**；都没有说明这是下行/事件条目或老后端，
 * 显示空格而不是「已受理 0 条」这类可能失真的默认值。
 *
 * @param item 条目
 * @returns 需要显示返回 true
 */
export function hasBatchInfo(item: IotDeviceTraceApi.Item): boolean {
  return (
    isProvided(item.receiptStatus) ||
    isProvided(item.receivedCount) ||
    isProvided(item.persistedRows) ||
    isProvided(item.discardReason) ||
    isProvided(item.discardDetail)
  );
}

/**
 * 值是否已给出（不为 null/undefined）。
 *
 * 不用 `!= null`：本仓 lint 禁宽松相等；且 **0 与空串算已给出**——
 * `receivedCount=0` 是有意义的批次事实，不能当缺失处理。
 *
 * @param value 待判定的值
 * @returns 已给出返回 true
 */
function isProvided(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * 回执行性质 → i18n 键。
 *
 * @param status 回执行性质
 * @returns i18n 键；未知回落到「批次信息未知」（绝不返回空串）
 */
export function receiptStatusLabelKey(status?: null | string): string {
  switch (status) {
    case RECEIPT_STATUS.ACCEPTED: {
      return 'page.iot.device.trace.receiptAccepted';
    }
    case RECEIPT_STATUS.REJECTED: {
      return 'page.iot.device.trace.receiptRejected';
    }
    default: {
      return 'page.iot.device.trace.receiptUnknown';
    }
  }
}

/**
 * 回执行性质 → antdv Tag 颜色。
 *
 * @param status 回执行性质
 * @returns Tag 颜色
 */
export function receiptStatusColor(status?: null | string): string {
  switch (status) {
    case RECEIPT_STATUS.ACCEPTED: {
      return 'success';
    }
    case RECEIPT_STATUS.REJECTED: {
      return 'error';
    }
    default: {
      return 'default';
    }
  }
}

/**
 * 落库时刻的显示文本。
 *
 * 🔴 **只用 `persistedAt`**：为空/非法一律返回占位符，**绝不回退到
 * `occurredAt`/`publishedAt`/`createTime`**——那会把「落库时刻不可得」画成一个假时间。
 *
 * @param item 条目
 * @returns 显示文本；不可得时为占位符
 */
export function formatPersistedAt(item: IotDeviceTraceApi.Item): string {
  return formatTraceTime(item.persistedAt);
}

/**
 * 丢弃明细的显示文本。
 *
 * 🔴 **原样透传**：后端已按「前 8 个 pointId 逗号连接 + `,...(+N)`」截断，
 * 前端不再截断、不再拆分、不再重算后缀（二次加工会与后端口径漂移）。
 *
 * @param value 后端给的 discardDetail（可空）
 * @returns 原样文本；空值返回空串（由页面决定是否渲染整行）
 */
export function formatDiscardDetail(value?: null | string): string {
  return value ?? '';
}

/**
 * 从二批结构化字段推导「定位建议」（仅当前端/后端都未给 advice 时的兜底）。
 *
 * 规则表（**纯函数、无 IO、可单测**）：
 * 1. `receiptStatus=rejected` 且 `discardReason=DEVICE_NOT_FOUND` ⇒ `UP_DEVICE_NOT_FOUND`；
 * 2. `receiptStatus=rejected` 且 `discardReason=NO_ACCEPTED_ITEM` ⇒ `UP_REJECTED_MAP`；
 * 3. `receiptStatus=accepted` 且 `receivedCount > persistedRows` ⇒ `UP_PARTIAL`。
 *
 * **不命中一律返回 null**（宁可显示「暂无定位建议」，也不硬凑一条可能是错的建议）；
 * 规则只认结构化枚举，不猜测自由文本。
 *
 * @param item 条目
 * @returns 推导出的建议；无匹配返回 null
 */
export function resolveDiscardAdvice(
  item: IotDeviceTraceApi.Item,
): DerivedAdvice | null {
  const rejected = item.receiptStatus === RECEIPT_STATUS.REJECTED;

  if (rejected && item.discardReason === DISCARD_REASON.DEVICE_NOT_FOUND) {
    return {
      ruleId: TRACE_RULE.UP_DEVICE_NOT_FOUND,
      summaryKey: 'page.iot.device.trace.adviceUpDeviceNotFoundSummary',
      actionKeys: ['page.iot.device.trace.adviceUpDeviceNotFoundAction1'],
    };
  }

  if (rejected && item.discardReason === DISCARD_REASON.NO_ACCEPTED_ITEM) {
    return {
      ruleId: TRACE_RULE.UP_REJECTED_MAP,
      summaryKey: 'page.iot.device.trace.adviceUpRejectedMapSummary',
      actionKeys: [
        'page.iot.device.trace.adviceUpRejectedMapAction1',
        'page.iot.device.trace.adviceUpRejectedMapAction2',
      ],
    };
  }

  if (item.receiptStatus === RECEIPT_STATUS.ACCEPTED) {
    const received = Number(item.receivedCount);
    const persisted = Number(item.persistedRows);
    if (
      Number.isFinite(received) &&
      Number.isFinite(persisted) &&
      received > persisted
    ) {
      return {
        ruleId: TRACE_RULE.UP_PARTIAL,
        summaryKey: 'page.iot.device.trace.adviceUpPartialSummary',
        actionKeys: [
          'page.iot.device.trace.adviceUpPartialAction1',
          'page.iot.device.trace.adviceUpPartialAction2',
        ],
      };
    }
  }

  return null;
}
