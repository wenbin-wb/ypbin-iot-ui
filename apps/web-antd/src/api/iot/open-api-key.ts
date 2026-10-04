import { requestClient } from '#/api/request';

/**
 * 开放 API Key 管理 API（看板 #11 第 3 批）。
 *
 * 后端（OpenApiKeyController，权限 iot:openapi:key-*）：
 *   POST /iot/open-api-keys            创建（明文 secret 仅本响应返回一次）
 *   GET  /iot/open-api-keys            列表（只回 secretPrefix，不给明文）
 *   POST /iot/open-api-keys/{id}/revoke 吊销（禁用即生效）
 *
 * 安全契约：
 *   ① secret 明文只出现在创建响应当次 —— 前端不持久化、不二次回读；
 *   ② 列表/详情绝不回显明文（后端只存 HMAC 哈希）；
 *   ③ 吊销为破坏性动作，UI 必须 Popconfirm 二次确认。
 */
export namespace IotOpenApiKeyApi {
  /** 创建请求（与后端 OpenApiKeyDtos.CreateReq 对齐）。 */
  export interface CreateReq {
    appName: string;
    /** 作用域逗号分隔，每个值必须在后端白名单内。 */
    scopes: string;
    rateLimitQps?: number;
    dailyQuota?: number;
    expireAt?: string;
  }

  /** 创建响应：secret 是仅此一次的明文。 */
  export interface CreateResp {
    id: string;
    accessKeyId: string;
    secret: string;
    secretPrefix: string;
    scopes: string[];
    expireAt?: string;
  }

  /** 列表项（只回 prefix）。 */
  export interface KeyItem {
    id: string;
    appName: string;
    accessKeyId: string;
    secretPrefix: string;
    scopes: string[];
    /** 后端 EntityStatus 码：1=启用，0=停用（吊销后）。 */
    status: number;
    expireAt?: string;
    lastUsedAt?: string;
    createTime?: string;
    /** 当日已用次数（null/缺席 = 未知，如 Redis 不可用）。 */
    usedToday?: null | number;
    rateLimitQps?: number;
    /** 日配额（0 = 不限）。 */
    dailyQuota?: number;
  }
}

/** Key 列表（只回 prefix）。 */
export async function getOpenApiKeys() {
  return requestClient.get<IotOpenApiKeyApi.KeyItem[]>('/iot/open-api-keys');
}

/** 签发 Key：返回的 secret 仅此一次，页面必须明确提示并支持复制。 */
export async function createOpenApiKey(payload: IotOpenApiKeyApi.CreateReq) {
  return requestClient.post<IotOpenApiKeyApi.CreateResp>(
    '/iot/open-api-keys',
    payload,
  );
}

/** 吊销 Key（禁用即生效，吊销后该 Key 立即 401）。 */
export async function revokeOpenApiKey(id: string) {
  return requestClient.post<null>(`/iot/open-api-keys/${id}/revoke`);
}
