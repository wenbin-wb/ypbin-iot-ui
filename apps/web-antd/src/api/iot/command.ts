import { requestClient } from '#/api/request';

/**
 * IoT 在线调试（下行命令实例）API。
 *
 * 后端 `IotCommandController`（`ypbin-iot`，设计 §7.4 / §7.6）：
 * - `POST /iot/devices/{deviceId}/commands` —— 下发（权限 `iot:debug:send`）；
 * - `GET  /iot/devices/{deviceId}/commands` —— 分页查询下发/回执记录（权限 `iot:debug:get`）；
 * - `POST /iot/devices/{deviceId}/commands/{requestId}/resend` —— 人工重发（权限 `iot:debug:send`）。
 *
 * ⚠️ **契约要点（写页面时必须照做，不能自行发挥）**：
 * 1. `params` 是 **JSON 对象**（不是字符串也不是数组）；`property_set` 的形状是
 *    `{value: <值>}`，服务端据此生成下行 `properties:{identifier: value}`；
 * 2. **一条指令只接受一个 `identifier`**（`CommandPayloads` 对 `property_get` 只放一个元素）
 *    ⇒ 多点位只能拆成多条指令（各自 `requestId`，各自可重发）；
 * 3. `property_get` 的 `identifier` 可空 ⇒ **空 = 该设备全部可读属性**（`properties: []`）；
 * 4. 状态六态 `pending|sent|succeeded|failed|timeout|cancelled`；回执 `code == 0` 判成功，
 *    非 0 由后端**原样保存**设备的 `code`/`message`（页面因此必须能展示设备原始回执）；
 * 5. `NO_SUBSCRIBER` = EMQX 无订阅者 ⇒ **不等超时**立即判 `failed`，页面对应「设备未连接」；
 * 6. 重发**不生成新 `requestId`**（`retry_count+1`），且只有 `failed`/`timeout` 可重发；
 * 7. 业务失败走 **HTTP 200 + `R.code`** 信封（`writeDesired=true` 被显式拒绝，不是静默忽略）。
 */
export namespace IotCommandApi {
  /** 动作类型码（后端 `CommandKind`）。 */
  export type CommandKindCode =
    | 'property_get'
    | 'property_set'
    | 'service_call';

  /** 实例状态码（后端 `CommandInstanceStatus`，六态穷举）。 */
  export type CommandStatusCode =
    | 'cancelled'
    | 'failed'
    | 'pending'
    | 'sent'
    | 'succeeded'
    | 'timeout';

  /** 失败原因码（后端 `CommandErrorCode`；判据见设计与集成文档）。 */
  export type CommandErrorCode =
    | 'DEVICE_OFFLINE'
    | 'DEVICE_REJECTED'
    | 'EMQX_ERROR'
    | 'NO_SUBSCRIBER'
    | 'TIMEOUT';

  /** 指令来源码（后端 `CommandSource`）。 */
  export type CommandSourceCode = 'api' | 'console' | 'rule';

  /** 一条命令实例（下发响应与历史列表共用；后端 `CommandInstanceResp`）。 */
  export interface CommandInstanceResp {
    id: string;
    deviceId: string;
    /** `property_set | property_get | service_call`。 */
    kind: string;
    /** 目标标识（`property_get` 读全部时后端记审计标签 `all-properties`）。 */
    identifier: string;
    /** 幂等键；**重发不变**。 */
    requestId: string;
    /** 下行主题（`down/property/set` 等）。 */
    topic?: string;
    /** 下行报文体（JSON 文本）。 */
    payload?: string;
    /** 上行回执体（JSON 文本，**后端原样保存**）。 */
    replyPayload?: string;
    /** 状态码（六态）。 */
    statusCode: string;
    /** 失败原因码（成功时为空）。 */
    errorCode?: string;
    /** 失败说明（面向人的文案）。 */
    errorMsg?: string;
    timeoutMs?: number;
    /** 已重发次数（仅人工重发计数）。 */
    retryCount?: number;
    /** EMQX publish 返回的消息 ID（溯源用）。 */
    emqxMessageId?: string;
    /** 来源码。 */
    source?: string;
    operatorUserId?: string;
    /** 投递到 EMQX 的时刻（`yyyy-MM-dd HH:mm:ss`）。 */
    sentAt?: string;
    /** 终态时刻（平台时间）。 */
    finishedAt?: string;
    /** 创建时刻。 */
    createTime?: string;
  }

  /** 下发请求（后端 `CommandSendReq`）。 */
  export interface CommandSendReq {
    kind: string;
    /** 目标标识；`property_get` 可省略（省略 = 全部可读属性）。 */
    identifier?: string;
    /** **必须是 JSON 对象**；`property_set` 形如 `{value: 25}`。 */
    params?: Record<string, unknown>;
    /** 超时（毫秒，1 ~ 3600000）；省略用平台默认。 */
    timeoutMs?: number;
    /**
     * 本轮**不支持**：置 `true` 会被后端显式拒绝（U-B1）。
     * 页面不提供该开关，字段保留仅为对齐后端契约。
     */
    writeDesired?: boolean;
  }

  /** 历史查询条件（后端 `CommandQuery`，排序固定为最新优先）。 */
  export interface CommandQuery {
    /** 状态码过滤；省略 = 全部（未知状态码后端会明确报错，不静默当全部）。 */
    statusCode?: string;
    page?: number;
    pageSize?: number;
  }

  /**
   * 分页信封（后端 `PageResult`）。
   *
   * ⚠️ **计数与页码是字符串**：后端把 Long 全局序列化成字符串，实测
   * `GET /iot/devices/{id}/commands` 回 `{"total":"17","page":"1","pageSize":"10","pages":"2"}`
   * ⇒ 这里按**真实返回**声明为 `number | string`，消费方负责显式转换
   * （不许用 `as number` 把分歧藏起来）。`pages` 后端也回，但本页不使用。
   */
  export interface PageResult<T> {
    items: T[];
    total: number | string;
    page: number | string;
    pageSize: number | string;
  }

  /** 回执体（`replyPayload` 反序列化后的形态；解析失败时页面回退展示原始文本）。 */
  export interface ReplyPayload {
    deviceId?: number | string;
    requestId?: string;
    /** 设备回执结果码（`0` = 成功；其余原样展示）。 */
    code?: number | string;
    /** 设备回执说明（**原样**，不由平台改写）。 */
    message?: string;
    /** 服务输出/属性值等（平台**原样存储不解析**）。 */
    data?: unknown;
    /** 设备时间（epoch 毫秒，Long 序列化成字符串）。 */
    ts?: number | string;
    /** 平台落库时刻（ISO-8601）。 */
    receivedAt?: string;
  }
}

/** 终态：自动转换已停止（`failed`/`timeout` 仍可被**人工**重发，故不等于「不可再变」）。 */
const TERMINAL_STATUSES: string[] = [
  'succeeded',
  'failed',
  'timeout',
  'cancelled',
];

/** 可人工重发的来源态（后端 `CommandInstanceStatus.RESENDABLE`，与页面按钮文案同源）。 */
const RESENDABLE_STATUSES: string[] = ['failed', 'timeout'];

/** 是否终态（页面据此决定「还要不要继续轮询」）。 */
export function isTerminalStatus(statusCode?: string): boolean {
  return (
    typeof statusCode === 'string' && TERMINAL_STATUSES.includes(statusCode)
  );
}

/** 是否可人工重发（页面据此决定重发按钮是否可用；后端仍会二次校验）。 */
export function isResendableStatus(statusCode?: string): boolean {
  return (
    typeof statusCode === 'string' && RESENDABLE_STATUSES.includes(statusCode)
  );
}

/** 下发命令/属性设置（返回 `requestId` 与初始状态）。 */
export async function sendDeviceCommand(
  deviceId: string,
  data: IotCommandApi.CommandSendReq,
) {
  return requestClient.post<IotCommandApi.CommandInstanceResp>(
    `/iot/devices/${deviceId}/commands`,
    data,
  );
}

/** 分页查询某设备的下发/回执记录（按创建时刻倒序，最新优先）。 */
export async function getDeviceCommands(
  deviceId: string,
  params: IotCommandApi.CommandQuery = {},
) {
  return requestClient.get<
    IotCommandApi.PageResult<IotCommandApi.CommandInstanceResp>
  >(`/iot/devices/${deviceId}/commands`, { params });
}

/**
 * 人工重发**同一条**指令（同一 `requestId`，`retry_count+1`）。
 *
 * `requestId` 进 URL 路径，统一 `encodeURIComponent`（后端形态已过白名单，这里只防拼接污染）。
 */
export async function resendDeviceCommand(
  deviceId: string,
  requestId: string,
) {
  return requestClient.post<IotCommandApi.CommandInstanceResp>(
    `/iot/devices/${deviceId}/commands/${encodeURIComponent(requestId)}/resend`,
  );
}
