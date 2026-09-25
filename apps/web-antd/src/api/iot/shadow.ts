import { requestClient } from '#/api/request';

/**
 * IoT 设备影子 API（后端 `GET|PUT /iot/devices/{deviceId}/shadow`）。
 *
 * ⚠️ 已知半实现（方案 G2）：`reported` 在生产代码里**没有写入方** ⇒ 恒为空，
 * `merged` 实际等于 `desired`。页面必须显式说明，不能把空 reported 显示成「设备没上报」。
 */
export namespace IotShadowApi {
  export interface ShadowResp {
    deviceId: string;
    /** 设备上报值（键=属性标识）——当前恒为空。 */
    reported: Record<string, unknown>;
    /** 平台期望值。 */
    desired: Record<string, unknown>;
    /** 合并视图（reported 优先，无则 desired）。 */
    merged: Record<string, unknown>;
    reportTs?: string;
    desiredTs?: string;
  }
}

/** 读取设备影子（reported 优先，无则回退 desired）。 */
export async function getDeviceShadow(deviceId: string) {
  return requestClient.get<IotShadowApi.ShadowResp>(
    `/iot/devices/${deviceId}/shadow`,
  );
}
