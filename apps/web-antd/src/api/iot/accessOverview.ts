/**
 * 接入侧只读运维概览（后端 `/access-overview`，平台级权限 `iot:ledger:list`）。
 *
 * 网关口径与 `api/iot/ledger.ts` 一致：前端打 `/iot/**`，网关 StripPrefix=1 后到服务端
 * ⇒ 这里必须是 `/iot/access-overview`（**不是** `/access-overview`，否则 404）。
 *
 * ⚠️ `Long` 全局序列化为字符串（同 `IotLedgerApi` 口径）⇒ 计数字段按 `null | number | string`
 * 处理，展示前用 `toText()` 归一，**不得直接当 number 运算**。
 */
import { requestClient } from '#/api/request';

/** 后端不返回这些字段时为 null（如 access 还没上报过指标）。 */
type Nullable<T> = null | T;
/** Long 序列化结果：可能是 string 也可能是 number，取用时统一转文本。 */
type Num = number | string;

export interface AccessNodeOverview {
  accessNode: string;
  maxTenants?: Nullable<Num>;
  holdingCount?: Nullable<Num>;
  /**
   * ⚠️ 不是心跳：只在 access 注册/复活时写，续约（20s）不更新它。
   * 节点是否活着请看 `leaseAlive` / `leaseRemainingSec`（由租约到期时刻推导）。
   */
  lastRegisteredAt?: Nullable<string>;
  leaseExpireMin?: Nullable<string>;
  /** 租约是否仍有效（还在续约 ⇒ 活着）；`null` = 无租约。 */
  leaseAlive?: Nullable<boolean>;
  /** 距最早租约到期的秒数（负 = 已过期）。 */
  leaseRemainingSec?: Nullable<Num>;
}

export interface AccessOverview {
  nodes: AccessNodeOverview[];
  metrics: {
    egressPendingCount?: Nullable<Num>;
    nodeFencedCount?: Nullable<Num>;
    reconcileDeferredCount?: Nullable<Num>;
    reconcileDurationMaxMs?: Nullable<Num>;
    renewFailureCount?: Nullable<Num>;
    reported: boolean;
    reportLagMs: Num;
    selfFencedCount?: Nullable<Num>;
    specLoadDurationMaxMs?: Nullable<Num>;
    tickDurationMaxMs?: Nullable<Num>;
  };
}

/** 拉取一次概览（平台管理员；接口无分页与查询参数）。 */
export async function getAccessOverview() {
  return requestClient.get<AccessOverview>('/iot/access-overview');
}
