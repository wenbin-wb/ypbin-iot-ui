import { requestClient } from '#/api/request';

/**
 * 租户接入台账 API（把后端已就绪的 `iot:ledger:*` 权限码接上页面）。
 *
 * 后端契约（已实测，唯一事实来源；本模块**只有这两个端点**）：
 * - `GET  /iot/tenant-ledger`                       权限 `iot:ledger:list`   → `TenantLedgerResp[]`
 * - `PUT  /iot/tenant-ledger/{tenantId}/assignable` 权限 `iot:ledger:update` → `TenantLedgerResp`
 *
 * ⚠️ `deviceCount` / `lastReportAt` / `hasCredential` 属于**并行开发中的聚合字段**：
 * 旧后端可能不返回 ⇒ 展示方按字段是否 `undefined` 区分「真实值」与「待接入」，
 * 缺失时标注「待接入」，**不得在本文件里补造/猜测**。
 * 租户名称仍不在本接口（由页面调用系统租户接口批量解析）。
 */
export namespace IotLedgerApi {
  export interface LedgerResp {
    /** `Long` 全局序列化为字符串 ⇒ 前端一律按 `string` 处理（同 `IotProductApi` 的 `id`）。 */
    tenantId: string;
    /** 该租户当前是否可接入（后端 `Boolean`，可能缺省）。 */
    assignable?: boolean;
    /** 配置代次（`Long` → 字符串）。 */
    configEpoch?: string;
    /**
     * **仅写入口回填**：`created`（首次接入）/ `revived`（恢复接入）/ `updated`（仅更新开关）。
     * 列表接口恒不返回（`null`）⇒ 不做成列，只在写成功后按返回值提示。
     */
    change?: string;
    /** 更新时间，`yyyy-MM-dd HH:mm:ss`。 */
    updateTime?: string;
    /** 该租户设备数（后端 `Long` → 全局序列化为 number | string；0 是有效值）。 */
    deviceCount?: number | string;
    /**
     * 最近上报时间（`yyyy-MM-dd HH:mm:ss` 或 ISO）。
     * 字段缺失 = 后端尚未提供该聚合；字段为空串 = 确实没有上报记录 ⇒ 展示 `-`。
     */
    lastReportAt?: string;
    /** 该租户是否已有接入凭据（字段缺失 = 后端尚未提供）。 */
    hasCredential?: boolean;
  }

  export interface LedgerAssignableReq {
    /** 目标状态（后端 `@NotNull`）：`true` = 可接入，`false` = 暂停接入。 */
    assignable: boolean;
  }
}

/** 列出全部租户的接入台账（平台级；接口无分页参数，也无查询参数）。 */
export async function getTenantLedgerList() {
  return requestClient.get<IotLedgerApi.LedgerResp[]>('/iot/tenant-ledger');
}

/** 设置某租户是否可接入；返回更新后的台账行（写入口会回填 `change`）。 */
export async function updateTenantLedgerAssignable(
  tenantId: string,
  assignable: boolean,
) {
  const data: IotLedgerApi.LedgerAssignableReq = { assignable };
  return requestClient.put<IotLedgerApi.LedgerResp>(
    `/iot/tenant-ledger/${tenantId}/assignable`,
    data,
  );
}
