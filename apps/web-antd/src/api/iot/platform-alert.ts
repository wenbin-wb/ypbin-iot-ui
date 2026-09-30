import { requestClient } from '#/api/request';

/**
 * 平台告警 API（看板 #10 二批；后端 GET /iot/platform-alerts，权限 iot:alert:list）。
 */
export namespace IotPlatformAlertApi {
  /** 平台告警条目（读模型，不含敏感字段）。 */
  export interface PlatformAlertResp {
    id: string;
    /** 规则码（如 PLATFORM_EVALUATOR_STALLED）。 */
    ruleCode: string;
    /** 级别码：WARNING | CRITICAL。 */
    severity: string;
    /** 状态码：PENDING | FIRING | RESOLVED。 */
    state: string;
    /** 一句话概要。 */
    summary: string;
    /** 判定时刻指标快照（JSON 文本）。 */
    metricSnapshot?: string;
    startTs?: string;
    firingTs?: string;
    resolvedTs?: string;
    observedRounds?: number;
  }

  /** 分页查询（后端 PageResult；计数与页码为字符串）。 */
  export interface PlatformAlertQuery {
    page: number;
    pageSize: number;
    state?: string;
    severity?: string;
  }

  /** 分页信封（与 IotAlertApi.PageResult 同构）。 */
  export interface PageResult<T> {
    items: T[];
    total: number | string;
    page: number | string;
    pageSize: number | string;
  }
}

/** 平台告警分页列表。 */
export async function getPlatformAlerts(
  params: IotPlatformAlertApi.PlatformAlertQuery,
) {
  return requestClient.get<
    IotPlatformAlertApi.PageResult<IotPlatformAlertApi.PlatformAlertResp>
  >('/iot/platform-alerts', { params });
}
