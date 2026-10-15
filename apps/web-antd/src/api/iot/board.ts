import { requestClient } from '#/api/request';

/**
 * 组态看板配置 API（按租户共享持久化）。
 *
 * 契约（后端 `ypbin-iot` `IotDashboardController`，网关 `Path=/iot/**` + `StripPrefix=1`）：
 * - `GET /iot/dashboard/board` → `{ widgets: [...] }`；**从未配置时 widgets 是空数组，不是 null**
 *   （空数组 = 无配置，不是「配置损坏」）；
 * - `PUT /iot/dashboard/board` body `{ widgets: [...] }`：**整体替换**本租户配置，
 *   清空看板要传 `[]`（传 null 会被后端 400 拒绝）。
 *
 * 组件字段由前端定义（后端只按租户存取、原样透传）：核心 `id/type/title/deviceId/propertyId`
 * 必填且租户内唯一；`type` 后端不做白名单，前端加新组件类型无需后端发版。
 * 限制：`widgets` ≤ 50、`config_json` ≤ 64KB（前端另有更严的看板自身上限）。
 *
 * 鉴权：两个接口都是 `@SaCheckLogin`（**无权限码**）⇒ 前端不得用 `useAccess` 权限码门控。
 */
export namespace IotBoardApi {
  /**
   * 持久化的单个组件。
   *
   * 故意用 `Record<string, unknown>` 而不是逐字段接口：字段集合由前端组件类型决定，
   * 后端原样存取；在这里钉死字段会让「前端加字段」变成两仓契约变更。
   * 调用方应传 `board-utils` 的 `toBoardPayloadWidget` 产物（已做字段白名单与清洗）。
   */
  export type BoardWidgetPayload = Record<string, unknown>;

  /** `GET /iot/dashboard/board` 响应体。 */
  export interface BoardResp {
    /** 组件列表；无配置时为空数组（永不为 null）。 */
    widgets: BoardWidgetPayload[];
  }
}

/** 读取本租户看板配置（无配置返回 `{ widgets: [] }`）。 */
export async function getDashboardBoard() {
  return requestClient.get<IotBoardApi.BoardResp>('/iot/dashboard/board');
}

/**
 * 整体替换本租户看板配置。
 *
 * 失败（网络/业务码）会 reject，调用方**必须如实提示并保留本地草稿**，不得静默降级。
 */
export async function saveDashboardBoard(
  widgets: IotBoardApi.BoardWidgetPayload[],
) {
  return requestClient.put<null>('/iot/dashboard/board', { widgets });
}
