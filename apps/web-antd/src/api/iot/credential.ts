import { requestClient } from '#/api/request';

/**
 * IoT 设备凭据与连接信息 API（看板 #13 死能力接线）。
 *
 * 后端（DeviceCredentialController，权限 iot:credential:issue/get/revoke）：
 *   POST /devices/{id}/credential    签发（明文 password 仅本响应返回一次）
 *   GET  /devices/{id}/credential    查看（只返回元信息，**不回读明文**——哈希存储）
 *   DELETE /devices/{id}/credential  吊销
 *   GET  /devices/{id}/connection    连接参数（broker/clientId/主题前缀）
 */
export namespace IotCredentialApi {
  /** 查看凭据（无明文）。 */
  export interface CredentialResp {
    deviceId: string;
    username: string;
    credentialVersion: number;
    credentialIssuedAt?: string;
    credentialRevokedAt?: string;
    /** 是否签发过。 */
    issued: boolean;
    /** 当前是否有效（吊销后为 false）。 */
    valid: boolean;
  }

  /** 签发结果：password 是**仅此一次**的明文，页面必须提示。 */
  export interface IssuedResp {
    deviceId: string;
    username: string;
    credentialVersion: number;
    credentialIssuedAt?: string;
    password: string;
  }

  /** 设备连接参数（帮助设备侧配置。 */
  export interface ConnectionResp {
    deviceId: string;
    username: string;
    clientId: string;
    topicUpPrefix: string;
    topicDownPrefix: string;
    credentialIssued: boolean;
    credentialVersion?: number;
    credentialValid?: boolean;
    emqxEnabled: boolean;
    brokerHost: string;
    brokerPort: number;
    brokerTlsEnabled: boolean;
  }
}

/** 签发设备凭据：返回的 password 仅此一次，页面必须明确提示并支持复制。 */
export async function issueDeviceCredential(deviceId: string) {
  return requestClient.post<IotCredentialApi.IssuedResp>(
    `/iot/devices/${deviceId}/credential`,
  );
}

/** 查看凭据（无明文；仅元信息）。 */
export async function getDeviceCredential(deviceId: string) {
  return requestClient.get<IotCredentialApi.CredentialResp>(
    `/iot/devices/${deviceId}/credential`,
  );
}

/** 吊销凭据（设备将无法再用旧用户名/密码接入）。 */
export async function revokeDeviceCredential(deviceId: string) {
  return requestClient.delete<null>(`/iot/devices/${deviceId}/credential`);
}

/** 读取设备连接参数（broker/clientId/主题前缀）。 */
export async function getDeviceConnection(deviceId: string) {
  return requestClient.get<IotCredentialApi.ConnectionResp>(
    `/iot/devices/${deviceId}/connection`,
  );
}
