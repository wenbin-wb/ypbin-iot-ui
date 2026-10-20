import type { IotPageResult } from './page';

import { requestClient } from '#/api/request';

/**
 * IoT 在线调试（下行命令实例）API。
 *
 * 后端 `IotCommandController`（见 ypbin-iot 的在线调试设计）：
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
 * 7. 业务失败走 **HTTP 200 + `R.code`** 信封；`writeDesired` 仅 `property_set` 支持
 *    （其它 kind 置 `true` 由后端显式拒绝，不是静默忽略，见字段注释）。
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
     * 是否**同时**把该值写入设备影子 `desired`（后端 `CommandSendReq.writeDesired`）。
     *
     * ⚠️ 契约要点（以 `ypbin-iot` 后端一手代码为准，勿按旧注释理解）：
     * - **只对 `property_set` 有效**；`property_get`/`service_call` 置 `true` 会被后端
     *   `requireWriteDesiredScope` **显式拒绝**（业务错误，不是静默忽略）；
     * - 生效时点 = 命令**投递成功**（`statusCode=sent`）后，把 `{identifier: params.value}`
     *   合并进影子 desired；设备离线（`NO_SUBSCRIBER`）时**不写**（不制造假期望）；
     * - 写 desired 失败会抛业务错误（命令已投递），不会静默成功。
     */
    writeDesired?: boolean;
  }

  /**
   * 逐设备结果里的**三态**已由后端两个字段表达，前端**不得**把两者合并成一个 ok：
   * - accepted = 平台已受理（命令实例已落库，可查询/可重发）；
   * - ok = 设备确实收到（statusCode = sent）。
   *
   * 因此 response 里的单条结果保留两个布尔位，展示层按
   * accepted+ok / accepted+!ok / !accepted 三态渲染（见 views/iot/devices/modules/batch-command-state.ts）。
   */
  export interface CommandBatchItemResult {
    deviceId: number | string;
    /** 平台是否受理成功（实例已创建）。 */
    accepted?: boolean;
    /** 是否投递成功（statusCode=sent）。accepted=true 且 ok=false ⇒ 已提交未送达，可重发。 */
    ok?: boolean;
    /** 命令实例请求 ID（受理成功时必有；前端据此重发）。 */
    requestId?: string;
    /** 实例状态码：pending | sent | failed。 */
    statusCode?: string;
    /** 投递失败原因码：NO_SUBSCRIBER | EMQX_ERROR | …（成功时为空）。 */
    errorCode?: string;
    /**
     * **未受理**原因码（受理成功时为空）：
     * DEVICE_NOT_FOUND | DEVICE_DISABLED | DEVICE_WITHOUT_PRODUCT | THING_MODEL_EMPTY |
     * THING_MODEL_LOAD_FAILED | COMMAND_REJECTED | BATCH_BUDGET_EXCEEDED | INTERNAL_ERROR。
     */
    code?: string;
    /** 人话说明（未受理原因或投递结果说明），后端已写好，前端原样展示。 */
    message?: string;
  }

  /** 批量下发请求（后端 `CommandBatchSendReq`：**一个命令模板 + 多台设备**）。 */
  export interface CommandBatchSendReq {
    /**
     * 设备主键清单。
     *
     * ⚠️ **契约上后端是 `List<Long>`**，本仓「Long 全程字符串」的口径（铁律 9）在这里**不适用**：
     * Jackson 接受 JSON 字符串形式的数字并转成 Long，但**前端不应依赖这种隐式转换**——设备 id
     * 来自后端响应（已是字符串），我们只在**发送前**显式转成 number，且要求它是安全整数。
     * 这是本仓唯一的例外，故在此显式说明理由，不做「反正能过」的静默处理。
     */
    deviceIds: number[];
    /** 命令模板（原样应用到每一台设备）。 */
    command: CommandSendReq;
    /**
     * 请求级幂等键（可选）。**批量下后端会逐设备派生**为 `<本字段>:<deviceId>`，
     * 因此同一批重复提交不会二次下发；为空则不启用幂等。
     */
    clientRequestId?: string;
  }

  /** 批量下发响应（后端 `CommandBatchResp`：逐设备结果 + 四个计数）。 */
  export interface CommandBatchResp {
    /** 去重后的设备总数。 */
    total: number | string;
    /** 受理成功台数（实例已创建）。 */
    accepted: number | string;
    /** 未受理台数（未创建实例）。 */
    rejected: number | string;
    /** 受理且投递成功台数（statusCode = sent）。 */
    delivered: number | string;
    /** 逐台结果（与去重后的入参顺序一致）。 */
    results?: CommandBatchItemResult[];
  }

  /** 历史查询条件（后端 `CommandQuery`，排序固定为最新优先）。 */
  export interface CommandQuery {
    /** 状态码过滤；省略 = 全部（未知状态码后端会明确报错，不静默当全部）。 */
    statusCode?: string;
    page?: number;
    pageSize?: number;
  }

  /**
   * 分页信封（后端 `PageResult`）。**唯一定义**见 `./page` 的 {@link IotPageResult}；
   * `total/page/pageSize` 在后端是 `long` ⇒ 真实返回为 `number | string`，
   * 消费方必须用 `#/utils/backend-number` 的 `toBackendNumber` 显式转数（禁止 `as number`）。
   */
  export type PageResult<T> = IotPageResult<T>;

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
const TERMINAL_STATUSES = new Set<string>([
  'cancelled',
  'failed',
  'succeeded',
  'timeout',
]);

/** 可人工重发的来源态（后端 `CommandInstanceStatus.RESENDABLE`，与页面按钮文案同源）。 */
const RESENDABLE_STATUSES = new Set<string>(['failed', 'timeout']);

/** 是否终态（页面据此决定「还要不要继续轮询」）。 */
export function isTerminalStatus(statusCode?: string): boolean {
  return typeof statusCode === 'string' && TERMINAL_STATUSES.has(statusCode);
}

/** 是否可人工重发（页面据此决定重发按钮是否可用；后端仍会二次校验）。 */
export function isResendableStatus(statusCode?: string): boolean {
  return typeof statusCode === 'string' && RESENDABLE_STATUSES.has(statusCode);
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
 * 批量下发：**一个命令模板**应用到多台设备，返回逐设备结果。
 *
 * 后端 `POST /iot/devices/commands/batch`（权限 `iot:debug:send`，与单台同一权限码、
 * 同一份物模型校验与下发链路；不新造权限码）。
 *
 * ⚠️ **两处与单台端点不同的语义**（照做，不要自行「统一」）：
 * 1. **部分失败不整体失败**：设备不存在/已停用/无物模型/被拒都进 `results` 逐条返回
 *    （`accepted=false` 且带 `code`+`message`），只有「请求本身不成立」才整批报错
 *    （deviceIds 空/含 null/超上限、命令模板缺失或形态非法）——调用方必须能分辨这两种失败；
 * 2. **设备离线不是失败**：平台受理成功但投递失败时 `accepted=true, ok=false`（实例已落库、
 *    `requestId` 可重发），页面**不得**把它画成失败或成功，而应展示「已提交未送达，可重发」。
 *
 * 批量会**明确拒绝停用设备**（`DEVICE_DISABLED`，单台端点不拒，这是后端有意为之）。
 *
 * `deviceIds` 的转数责任在调用方：本函数只做「原样发送」，不在 API 层做隐式字符串转换——
 * 见 {@link IotCommandApi.CommandBatchSendReq.deviceIds} 的口径说明。
 */
export async function sendBatchDeviceCommands(
  data: IotCommandApi.CommandBatchSendReq,
) {
  return requestClient.post<IotCommandApi.CommandBatchResp>(
    '/iot/devices/commands/batch',
    data,
  );
}

/**
 * 人工重发**同一条**指令（同一 `requestId`，`retry_count+1`）。
 *
 * `requestId` 进 URL 路径，统一 `encodeURIComponent`（后端形态已过白名单，这里只防拼接污染）。
 */
export async function resendDeviceCommand(deviceId: string, requestId: string) {
  return requestClient.post<IotCommandApi.CommandInstanceResp>(
    `/iot/devices/${deviceId}/commands/${encodeURIComponent(requestId)}/resend`,
  );
}
