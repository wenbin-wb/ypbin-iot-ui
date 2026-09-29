import { requestClient } from '#/api/request';

/**
 * 设备「消息跟踪」API（看板 #8，设计 `docs/MESSAGE-TRACE-DESIGN.md` §5）。
 *
 * 网关路由 `/iot/**`（StripPrefix=1），服务内路径是 `/devices/{deviceId}/messages`。
 *
 * ⚠️ **权限码是 `iot:debug:get` 而不是 `iot:device:list`**：本接口返回的条目含下行命令
 * 标识、归因码与"设备回执原文"的入口，这些数据在既有系统里由 `iot:debug:get` 守着
 * （`GET /iot/devices/{id}/commands`）。设备列表页的菜单级权限范围宽得多，
 * 用它返回命令侧数据是权限降级。页面入口因此要按 `iot:debug:get` 做显示门禁。
 */
export namespace IotDeviceTraceApi {
  /** 阶段码（与后端 `TraceStage` 对齐的具名常量）。 */
  export const TRACE_STAGE = {
    DOWN_ENQUEUED: 'down-enqueued',
    DOWN_PUBLISHED: 'down-published',
    DOWN_ACK: 'down-ack',
    UP_RECEIVED: 'up-received',
    EVENT_REPORTED: 'event-reported',
    DEVICE_OFFLINE: 'device-offline',
  } as const;

  /** 方向码。 */
  export const TRACE_DIRECTION = {
    UP: 'up',
    DOWN: 'down',
    INTERNAL: 'internal',
  } as const;

  /** 结果码。 */
  export const TRACE_OUTCOME = {
    OK: 'ok',
    FAILED: 'failed',
    TIMEOUT: 'timeout',
    UNKNOWN: 'unknown',
  } as const;

  /** 定位建议（后端 `TraceAdvice`）。 */
  export interface Advice {
    /** 规则标识（稳定；用户报障时可直接指认）。 */
    ruleId: string;
    /** 一句话结论。 */
    summary: string;
    /** 可执行动作（后端保证非空）。 */
    actions: string[];
  }

  /** 时间线的一条。 */
  export interface Item {
    occurredAt?: string;
    stage?: string;
    stageDesc?: string;
    direction?: string;
    outcome?: string;
    title?: string;
    source?: string;
    sourceId?: number | string;
    /** 归因码——**即使没有建议也必须显示**，它是用户排障的原始依据。 */
    errorCode?: null | string;
    errorMsg?: null | string;
    advice?: Advice | null;
    retryCount?: null | number;
    /** 是否发生过重发（重发会就地覆写时间戳，前端必须提示）。 */
    historyOverwritten?: boolean;
    enqueuedAt?: string;
    publishedAt?: string;
    ackedAt?: string;
  }

  /** 时间线响应。 */
  export interface TimelineResp {
    deviceId: number | string;
    from?: string;
    to?: string;
    /** 空集合而非 null。 */
    items: Item[];
    matched: number;
    /** 是否被截断（前端必须显示"结果已截断，请缩小时间窗"）。 */
    truncated: boolean;
    /** 能力边界：上行链路有看不见的断点（**永远为 true**，如实告知）。 */
    upstreamTraceUnavailable: boolean;
    upstreamTraceNote?: string;
  }

  /** 查询条件。 */
  export interface Query {
    /** 时间窗起点（ISO 字符串；不传则后端回落"当前时刻往前 1 小时"）。 */
    from?: string;
    to?: string;
    /** 阶段筛选。 */
    stage?: string;
    /** 方向筛选。 */
    direction?: string;
    /** 结果筛选。 */
    outcome?: string;
  }
}

/**
 * 查询某设备的消息时间线。
 *
 * @param deviceId 设备主键
 * @param query    时间窗与筛选条件
 */
export async function getDeviceTrace(
  deviceId: number | string,
  query: IotDeviceTraceApi.Query = {},
) {
  return requestClient.get<IotDeviceTraceApi.TimelineResp>(
    `/iot/devices/${deviceId}/messages`,
    { params: query },
  );
}
