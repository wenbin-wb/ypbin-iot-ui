import { requestClient } from '#/api/request';

/**
 * IoT 设备影子 API（后端 GET|PUT /iot/devices/{deviceId}/shadow）。
 *
 * reported 由上报链路写入（后端 `AvailabilityServiceImpl` → `ShadowReportedWriter`，
 * 值统一为读数原值字符串）；为空只表示「当前没有可展示的上报记录」，页面**不得**推断成
 * 「设备没上报」。merged = desired 打底、reported 覆盖；delta 见下。
 */
export namespace IotShadowApi {
  export interface ShadowResp {
    deviceId: string;
    /** 设备上报值（键=属性标识；值为上报原值，后端统一存字符串）。 */
    reported: Record<string, unknown>;
    /** 平台期望值。 */
    desired: Record<string, unknown>;
    /** 合并视图（reported 优先，无则 desired）。 */
    merged: Record<string, unknown>;
    /**
     * 期望与上报的差异 `desired \ reported`（后端 `IotShadowServiceImpl#delta`）：
     * 仅含「desired 有、reported 缺该键或值不等价」的键，**值取 desired**；
     * reported 里多出来的键与两侧一致的键都不在其中。
     * 判等口径是后端 `ShadowValueComparator`（类型宽容，`"25.0"` == `25`）。
     */
    delta?: Record<string, unknown>;
    reportTs?: string;
    desiredTs?: string;
  }

  /** 影子「期望值」更新请求（后端 IotShadowReq：desired 整体替换）。 */
  export interface ShadowUpdateReq {
    desired: Record<string, unknown>;
  }
}

/** 读取设备影子（reported 优先，无则回退 desired）。 */
export async function getDeviceShadow(deviceId: string) {
  return requestClient.get<IotShadowApi.ShadowResp>(
    `/iot/devices/${deviceId}/shadow`,
  );
}

/**
 * 写设备影子「期望值」（desired，整体替换）。
 *
 * 后端契约（ypbin-iot IotShadowController PUT /devices/{deviceId}/shadow，权限 iot:shadow:update）：
 * req.desired 是 Map<String,Object>，平台把 desired 作为目标配置下发。
 * 一键应用（以上报为准）也走这一支，语义就是「把 reported 当最终 desired 传进来」。
 */
export async function updateDeviceShadow(
  deviceId: string,
  desired: Record<string, unknown>,
) {
  return requestClient.put<null>(`/iot/devices/${deviceId}/shadow`, {
    desired,
  } satisfies IotShadowApi.ShadowUpdateReq);
}
