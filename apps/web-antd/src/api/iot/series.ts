import { requestClient } from '#/api/request';

/**
 * 历史时序查询 API（数据面；后端 §5.2.1 查询路径）。
 *
 * 契约以后端 `TimeSeriesQueryReq` / `TimeSeriesPointResp` 为准（`ypbin-iot` PR #34）：
 * 点位 `propertyId` 必填；`from`/`to` 为 **epoch 毫秒**（可空）；`limit` 1~5000（后端默认 1000）。
 *
 * ⚠️ 两点容易踩：
 * 1. 后端 Long 全局按**字符串**序列化 ⇒ `ts`（epoch 毫秒）在 JSON 里是字符串，参与运算/格式化前必须 `Number()`；
 * 2. 时序库（IoTDB）未启用时后端返回的是**业务错误**（HTTP 200 但 `R.code != 200`，message 含「未启用」），
 *    **不是**空列表 ⇒ 调用方必须如实展示该 message，不得显示成「没有数据」。
 */
export namespace IotSeriesApi {
  /** 一个时序点。 */
  export interface TimeSeriesPointResp {
    /** 读数时刻（epoch 毫秒；后端 Long 序列化为字符串，展示前 `Number()`） */
    ts: number | string;
    /** 读数原值（一律字符串化；文本点位读不到值时可能为 null） */
    value: null | string;
    /** 质量码（后端可能给 null） */
    quality: null | string;
  }

  export interface TimeSeriesQuery {
    /** 点位标识（必填） */
    propertyId: string;
    /** 起始时刻（epoch 毫秒，含） */
    from?: number;
    /** 结束时刻（epoch 毫秒，含） */
    to?: number;
    /** 返回条数上限（默认 {@link IOT_SERIES_DEFAULT_LIMIT}，最大 {@link IOT_SERIES_MAX_LIMIT}） */
    limit?: number;
  }
}

/** 单次查询默认返回条数（与后端 `TimeSeriesQueryReq.DEFAULT_LIMIT` 对齐）。 */
export const IOT_SERIES_DEFAULT_LIMIT = 1000;

/** 单次查询最大返回条数（与后端 `TimeSeriesQueryReq.MAX_LIMIT` 对齐）。 */
export const IOT_SERIES_MAX_LIMIT = 5000;

/**
 * 查询某设备某点位的历史时序（后端升序返回；该时间范围内无数据时为空数组）。
 *
 * 注意：后端在「时序库未启用」等场景抛业务错误 ⇒ 本函数会 reject，调用方需要区分
 * 「失败」与「没有数据」，不得把 reject 兜成空数组。
 */
export async function getDeviceSeries(
  deviceId: string,
  params: IotSeriesApi.TimeSeriesQuery,
) {
  return requestClient.get<IotSeriesApi.TimeSeriesPointResp[]>(
    `/iot/devices/${deviceId}/series`,
    { params },
  );
}
