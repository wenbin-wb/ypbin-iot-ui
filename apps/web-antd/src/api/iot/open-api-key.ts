import { requestClient } from '#/api/request';

/**
 * 开放 API Key 管理 API。
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
    /**
     * 来源 IP 白名单（逗号分隔的 IP/CIDR；空/缺席 = 不限来源）。
     *
     * 后端 `OpenApiKeyService.normalizeIpWhitelist` 会在创建时逐条校验，
     * **非法条目直接拒绝建 Key**（不静默降级），前端 `parseIpWhitelist` 已先拦一遍。
     */
    ipWhitelist?: string;
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
    /** 当日已用次数（null/缺席 = 未知；后端 Long 序列化为字符串，见 state 归一化）。 */
    usedToday?: null | number | string;
    rateLimitQps?: number;
    /** 日配额（0 = 不限）。 */
    dailyQuota?: number;
    /**
     * 来源 IP 白名单（前向兼容字段）。
     *
     * ⚠️ 后端 `ListItemResp` **当前不返回**该字段（2026-10-20 对照 `OpenApiKeyDtos` 核实），
     * 故列表里 `undefined` = 「后端未提供」而不是「不限来源」，展示必须区分（见 state）。
     * 后端补齐该字段后此列无需再改。
     */
    ipWhitelist?: null | string;
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
