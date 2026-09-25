import { requestClient } from '#/api/request';

/**
 * 设备运行期事件 API（G6）。
 *
 * 物模型 `iot_event` 是事件的**定义**（挂服务），本模块读的是运行期**实例**：
 * `GET /iot/devices/{deviceId}/events`（后端 `IotDeviceEventController`，权限沿用 `iot:device:list`）。
 */
export namespace IotEventApi {
  /** 事件级别码（后端 `EventLevel`）：info | warn | error。 */
  export type EventLevelCode = 'error' | 'info' | 'warn';

  /** 单条运行期事件（后端 `EventLogResp`；Long 全局转字符串）。 */
  export interface EventLogResp {
    id: string;
    deviceId: string;
    /** 事件标识（对应物模型事件 identifier；无定义时是上报方自定码）。 */
    eventCode: string;
    /** 事件名称（可能为空）。 */
    eventName?: string;
    /** info | warn | error。 */
    level: string;
    /** 事件参数（JSON 文本，可能为空）。 */
    params?: string;
    /** 事件发生时刻（`yyyy-MM-dd HH:mm:ss`）。 */
    eventTs?: string;
    /** 入库时刻。 */
    createTime?: string;
  }

  /** 查询条件：时间范围**左闭右开**（from 含、to 不含），与后端口径一致。 */
  export interface EventQuery {
    from?: string;
    to?: string;
    level?: string;
    page?: number;
    pageSize?: number;
  }

  export interface PageResult<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
  }
}

/** 分页查询某设备的运行期事件（按发生时刻倒序，最新优先）。 */
export async function getDeviceEvents(
  deviceId: string,
  params: IotEventApi.EventQuery = {},
) {
  return requestClient.get<IotEventApi.PageResult<IotEventApi.EventLogResp>>(
    `/iot/devices/${deviceId}/events`,
    { params },
  );
}
