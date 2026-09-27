import { requestClient } from '#/api/request';

/**
 * 告警与阈值 API（段 C1/C2 后端契约：`ypbin-iot` 的 `/iot/alerts/**` 与 `/iot/devices/{id}/alerts/**`）。
 *
 * ⚠️ 两条**必须遵守**的仓内口径：
 * 1. 后端把 Long/BigDecimal 全局序列化成**字符串** ⇒ 所有 ID/时间戳/计数在 JSON 里是字符串，
 *    分页 `total/page/pageSize` 亦然；消费方必须显式转数（`#/utils/backend-number` 的 `toBackendNumber`），
 *    禁止 `as number` 把分歧藏起来（口径与 `api/iot/device.ts`、`command.ts` 完全一致）。
 * 2. 阈值/回差在后端是 `DECIMAL` ⇒ 契约里按**字符串**声明（前后端都不做隐式浮点转换）。
 *
 * 权限码：`iot:alert:list`（查）| `iot:alert:ack`（确认与静默）|
 * `iot:alert:rule-list`（查规则）| `iot:alert:rule-save`（建/改/启停规则）。
 */
export namespace IotAlertApi {
  /** 状态码（后端 `AlertState`）：PENDING | FIRING | ACKED | RESOLVED。 */
  export type AlertState = 'ACKED' | 'FIRING' | 'PENDING' | 'RESOLVED';

  /** 级别码（后端 `AlertSeverity`）：INFO | WARNING | CRITICAL。 */
  export type AlertSeverity = 'CRITICAL' | 'INFO' | 'WARNING';

  /** 抖动抑制模式码（后端 `AlertTriggerMode`）。 */
  export type TriggerMode = 'CONSECUTIVE_COUNT' | 'DURATION' | 'IMMEDIATE';

  /** 作用域码（后端 `AlertScopeType`）：最具体者优先 POINT > DEVICE > PRODUCT > TENANT。 */
  export type ScopeType = 'DEVICE' | 'POINT' | 'PRODUCT' | 'TENANT';

  /** 比较符码（后端 `AlertOperator`）。 */
  export type Operator = 'EQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'NE';

  /** 比较域码（后端 `AlertValueType`）。 */
  export type ValueType = 'BOOLEAN' | 'NUMERIC';

  /** 通知渠道码（后端 `AlertChannel`）：Webhook 本期不做。 */
  export type Channel = 'EMAIL' | 'INBOX';

  /** 投递状态码（后端 `AlertNotifyStatus`）。 */
  export type NotifyStatus = 'FAILED' | 'GIVEN_UP' | 'PENDING' | 'SENT';

  /** 通知事件码（后端 `AlertNotifyEvent`）。 */
  export type NotifyEvent = 'ACKED' | 'FIRING' | 'REPEAT' | 'RESOLVED';

  /** 一条通知投递记录（展开行展示「站内信/邮件记录」）。 */
  export interface NotificationResp {
    id: string;
    channel: string;
    target: string;
    event: string;
    /** PENDING | SENT | FAILED | GIVEN_UP。 */
    notifyStatus: string;
    attempt?: number | string;
    nextRetryTs?: string;
    /** 最近一次错误（**原样**展示，不美化）。 */
    lastError?: string;
    createTime?: string;
  }

  /** 告警实例（全局列表 / 设备页签 / 展开行共用同一份）。 */
  export interface InstanceResp {
    id: string;
    /** 断档类为 `"0"`（保留值）。 */
    ruleId: string;
    /** 规则名（断档类为 null，页面显示「设备离线」）。 */
    ruleName?: string;
    /** 是否断档类（`ruleId == 0`）。 */
    outage?: boolean;
    deviceId: string;
    deviceName?: string;
    deviceCode?: string;
    productId?: string;
    /** 点位标识（设备级/断档类为空）。 */
    propertyId?: string;
    severity: string;
    state: string;
    /** 触发时读到的**原始值**（字符串，不美化）。 */
    triggerValue?: string;
    /** 触发时的阈值快照（规则改了阈值也不影响「当时为何报警」）。 */
    thresholdSnapshot?: string;
    startTs?: string;
    firingTs?: string;
    resolvedTs?: string;
    ackedTs?: string;
    ackedBy?: string;
    lastNotifiedTs?: string;
    notifyCount?: number | string;
    /** 结束原因码：RECOVERED | RULE_DISABLED | OUTAGE_RECOVERED。 */
    reason?: string;
    /** 实例级静默截止时刻（可空）。 */
    silenceUntil?: string;
    durationSeconds?: number | string;
    notifications?: NotificationResp[];
    createTime?: string;
  }

  /** 规则的点位条件行。 */
  export interface RulePointResp {
    id: string;
    propertyId: string;
    operator: string;
    /** 阈值（**字符串**形态的十进制数）。 */
    threshold: string;
    valueType: string;
    /** 回差（字符串形态；可空）。 */
    deadband?: string;
  }

  /** 告警规则。 */
  export interface RuleResp {
    id: string;
    ruleName: string;
    scopeType: string;
    scopeProductId?: string;
    scopeDeviceId?: string;
    productName?: string;
    deviceName?: string;
    deviceCode?: string;
    severity: string;
    enabled: boolean;
    triggerMode: string;
    triggerThreshold?: number | string;
    pendingTtlSec?: number | string;
    repeatIntervalSec?: number | string;
    silenceStart?: string;
    silenceEnd?: string;
    notifyChannels?: string;
    notifyTargets?: string;
    description?: string;
    points?: RulePointResp[];
    /** 该规则当前活动告警数。 */
    activeCount?: number | string;
    createTime?: string;
    updateTime?: string;
  }

  /** 一键预设模板（后端只给默认值 + i18n 键，标题/说明由前端按语言渲染）。 */
  export interface PresetResp {
    code: string;
    /** 标题 i18n 键（如 `page.iot.alert.preset.aboveUpper`）。 */
    i18nKey: string;
    defaultScopeType: string;
    defaultOperator?: string;
    /** 是否需要用户填「点位 + 阈值」。 */
    needsPointCondition: boolean;
    defaultSeverity: string;
    defaultTriggerMode: string;
    defaultTriggerThreshold?: number | string;
    defaultPendingTtlSec?: number | string;
    defaultRepeatIntervalSec?: number | string;
    defaultNotifyChannels?: string;
  }

  /** 概览摘要（设备概览页签一行 + 全局列表顶部计数）。 */
  export interface SummaryResp {
    activeCount: number | string;
    pendingCount: number | string;
    firingCount: number | string;
    ackedCount: number | string;
    criticalCount: number | string;
    warningCount: number | string;
    infoCount: number | string;
    resolvedLast24h: number | string;
  }

  /** 分页信封（后端 `PageResult`；计数与页码是**字符串**）。 */
  export interface PageResult<T> {
    items: T[];
    total: number | string;
    page: number | string;
    pageSize: number | string;
  }

  /** 告警实例查询条件。 */
  export interface InstanceQuery {
    page?: number;
    pageSize?: number;
    /** 状态码，多值逗号分隔（如 `FIRING,ACKED`）。 */
    state?: string;
    activeOnly?: boolean;
    severity?: string;
    deviceId?: string;
    productId?: string;
    propertyId?: string;
    ruleId?: string;
    from?: string;
    to?: string;
  }

  /** 规则查询条件。 */
  export interface RuleQuery {
    page?: number;
    pageSize?: number;
    scopeType?: string;
    /** 1 启用 / 0 停用。 */
    enabled?: number;
    severity?: string;
    keyword?: string;
    deviceId?: string;
    productId?: string;
  }

  /** 点位条件保存项。 */
  export interface RulePointSaveReq {
    propertyId: string;
    operator: string;
    /** 阈值（字符串；前端已即时校验为数字）。 */
    threshold: string;
    valueType?: string;
    deadband?: string;
  }

  /** 规则保存请求。 */
  export interface RuleSaveReq {
    ruleName: string;
    scopeType: string;
    scopeProductId?: string;
    scopeDeviceId?: string;
    severity?: string;
    enabled?: boolean;
    triggerMode?: string;
    triggerThreshold?: number;
    pendingTtlSec?: number;
    repeatIntervalSec?: number;
    silenceStart?: string;
    silenceEnd?: string;
    notifyChannels?: string;
    notifyTargets?: string;
    description?: string;
    /** **可以为空**：空表示「设备离线/数据中断」类规则（判定复用平台断档链路）。 */
    points?: RulePointSaveReq[];
  }
}

/** 分页查询告警（全局）。 */
export async function getAlertPage(params: IotAlertApi.InstanceQuery) {
  return requestClient.get<IotAlertApi.PageResult<IotAlertApi.InstanceResp>>(
    '/iot/alerts',
    { params },
  );
}

/** 分页查询某设备的告警（设备详情「告警」页签）。 */
export async function getDeviceAlertPage(
  deviceId: string,
  params: IotAlertApi.InstanceQuery = {},
) {
  return requestClient.get<IotAlertApi.PageResult<IotAlertApi.InstanceResp>>(
    `/iot/devices/${deviceId}/alerts`,
    { params },
  );
}

/** 告警详情（含投递记录）。 */
export async function getAlertDetail(id: string) {
  return requestClient.get<IotAlertApi.InstanceResp>(`/iot/alerts/${id}`);
}

/** 租户级告警摘要。 */
export async function getAlertSummary() {
  return requestClient.get<IotAlertApi.SummaryResp>('/iot/alerts/summary');
}

/** 设备级告警摘要（概览页签的一行摘要）。 */
export async function getDeviceAlertSummary(deviceId: string) {
  return requestClient.get<IotAlertApi.SummaryResp>(
    `/iot/devices/${deviceId}/alerts/summary`,
  );
}

/**
 * 批量取设备的活动告警数（设备台账列表的标记列）。
 *
 * ⚠️ 传**逗号分隔的单个参数**而不是数组：后端是 `@RequestParam List<Long>`，
 * Spring 对单值逗号分隔的绑定是稳定的；数组形态则依赖 axios 的 paramsSerializer 配置
 * （默认会序列化成 `deviceIds[]=1`，后端不认）。
 */
export async function getActiveAlertCounts(deviceIds: string[]) {
  if (deviceIds.length === 0) {
    return {};
  }
  return requestClient.get<Record<string, number | string>>(
    '/iot/alerts/active-counts',
    { params: { deviceIds: deviceIds.join(',') } },
  );
}

/** 一键确认（单个也传一个元素）。 */
export async function ackAlerts(ids: string[]) {
  return requestClient.post<number>('/iot/alerts/ack', { ids });
}

/** 一键静默（**不是状态**：只推迟通知，判定与状态机不受影响）。 */
export async function silenceAlerts(ids: string[], minutes = 60) {
  return requestClient.post<number>('/iot/alerts/silence', { ids, minutes });
}

/** 一键预设模板清单。 */
export async function getAlertPresets() {
  return requestClient.get<IotAlertApi.PresetResp[]>('/iot/alerts/presets');
}

/** 分页查询规则。 */
export async function getAlertRulePage(params: IotAlertApi.RuleQuery) {
  return requestClient.get<IotAlertApi.PageResult<IotAlertApi.RuleResp>>(
    '/iot/alerts/rules',
    { params },
  );
}

/** 规则详情。 */
export async function getAlertRule(id: string) {
  return requestClient.get<IotAlertApi.RuleResp>(`/iot/alerts/rules/${id}`);
}

/** 新建规则。 */
export async function createAlertRule(data: IotAlertApi.RuleSaveReq) {
  return requestClient.post<IotAlertApi.RuleResp>('/iot/alerts/rules', data);
}

/** 修改规则（不影响已产生的实例）。 */
export async function updateAlertRule(
  id: string,
  data: IotAlertApi.RuleSaveReq,
) {
  return requestClient.put<IotAlertApi.RuleResp>(`/iot/alerts/rules/${id}`, data);
}

/** 批量启用/停用规则（停用会收口该规则的活动实例）。 */
export async function setAlertRulesEnabled(ids: string[], enabled: boolean) {
  return requestClient.post<number>('/iot/alerts/rules/enabled', { ids, enabled });
}
