import { requestClient } from '#/api/request';

/**
 * 维护窗口 API（spec §12.5：统计总时长排除计划停机）。
 */
export namespace IotMaintenanceApi {
  export interface MaintenanceWindowDto {
    id: string;
    deviceId?: string;
    startTs: string;
    endTs?: string;
    source: string;
    reason?: string;
  }

  export interface MaintenanceWindowReq {
    deviceId?: string;
    startTs?: string;
    endTs?: string;
    reason?: string;
  }
}

export async function getMaintenanceWindowList(params: {
  deviceId?: string;
  from?: string;
  to?: string;
}) {
  return requestClient.get<IotMaintenanceApi.MaintenanceWindowDto[]>(
    '/iot/maintenance/windows',
    { params },
  );
}

export async function openMaintenanceWindow(
  data: IotMaintenanceApi.MaintenanceWindowReq,
) {
  return requestClient.post<number>('/iot/maintenance/windows', data);
}

export async function closeMaintenanceWindow(id: string) {
  return requestClient.post<number>(`/iot/maintenance/windows/${id}/close`);
}
