import { requestClient } from '#/api/request';

/**
 * 可用率与断档 API（M-2）。
 *
 * 注意：后端 Long/BigDecimal 全局按**字符串**序列化 ⇒ 秒数与可用率在 JSON 里是字符串，
 * 页面显示时必须 `Number(...)` 转换（见 `views/iot/device/modules/availability.vue`）。
 */
export namespace IotAvailabilityApi {
  export interface OutageEventResp {
    id: string;
    deviceId: string;
    startTs: string;
    endTs?: string;
    durationSec?: string;
    reason: string;
  }

  export interface MaintenanceWindowDto {
    id: string;
    deviceId?: string;
    startTs: string;
    endTs?: string;
    source: string;
    reason?: string;
  }

  export interface AvailabilityResp {
    deviceId: string;
    from: string;
    to: string;
    /** 统计窗口（墙钟，秒） */
    windowSeconds: string;
    /** 统计总时长（= 窗口 − 维护窗口，秒）：可用率的分母 */
    effectiveWindowSeconds: string;
    maintenanceSeconds: string;
    outageInMaintenanceSeconds: string;
    outageSeconds: string;
    longestOutageSeconds: string;
    outageCount: number;
    availability: string;
    meetsTarget: boolean;
    targetAvailability: string;
    maxAllowedOutageSeconds: string;
    truncated: boolean;
    outages: OutageEventResp[];
    maintenanceWindows: MaintenanceWindowDto[];
  }
}

/** 查询某设备在窗口内的可用率与断档（窗口给反后端会报错，不静默交换）。 */
export async function getDeviceAvailability(
  deviceId: string,
  from?: string,
  to?: string,
) {
  return requestClient.get<IotAvailabilityApi.AvailabilityResp>(
    `/iot/devices/${deviceId}/availability`,
    { params: { from, to } },
  );
}
