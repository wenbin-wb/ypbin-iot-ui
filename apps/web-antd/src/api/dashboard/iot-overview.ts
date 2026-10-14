import { requestClient } from '#/api/request';

/**
 * IoT 运行总览 API（首页分析页 / 工作台共用）。
 *
 * 契约：后端 `GET /iot/dashboard/overview` 一次返回全部统计（网关 `/iot/**` StripPrefix=1）。
 * 页面数据源走 `#/views/dashboard/shared/use-iot-overview.ts`：先试本接口，失败/未就绪
 * 自动回落演示数据并在页面标注「演示数据」；本文件字段为前后端共同契约。
 *
 * 趋势增强字段 `alertTrend` / `deviceGrowthTrend` / `alertRuleTop` 由后端并行补齐，
 * 消费方（analytics 页）对数组字段按「缺失 = 空数组」容错，旧响应也不会崩图表。
 */
export namespace IotDashboardApi {
  /** 通用「名称-数值」分布项（协议分布、告警级别分布、产品 TOP 等） */
  export interface NameValue {
    name: string;
    value: number;
  }

  /** 按日消息量趋势点（上行 = 设备上报，下行 = 平台指令/回读） */
  export interface MessageTrendPoint {
    /** yyyy-MM-dd */
    date: string;
    uplink: number;
    downlink: number;
  }

  /** 按日在线/离线设备趋势点 */
  export interface OnlineTrendPoint {
    /** yyyy-MM-dd */
    date: string;
    online: number;
    offline: number;
  }

  /** 按日告警趋势点：当天各级别新建告警数（后端已按天补 0） */
  export interface AlertTrendPoint {
    /** yyyy-MM-dd */
    date: string;
    critical: number;
    info: number;
    warning: number;
  }

  /** 按日设备增长趋势点 */
  export interface DeviceGrowthPoint {
    /** yyyy-MM-dd */
    date: string;
    /** 当日新增设备数 */
    added: number;
  }

  /** 最近告警条目（severity/state 取告警中心同一**小写**码值，前端按 page.iot.alert.* 翻译） */
  export interface RecentAlert {
    id: string;
    deviceName: string;
    ruleName: string;
    severity: string;
    state: string;
    /** yyyy-MM-dd HH:mm */
    triggeredAt: string;
  }

  /** 运行总览（一次拉齐，避免首屏多个统计请求） */
  export interface Overview {
    /** 设备总数 */
    deviceTotal: number;
    /** 在线设备数 */
    deviceOnline: number;
    /** 离线设备数 */
    deviceOffline: number;
    /** 停用（禁用采集）设备数 */
    deviceDisabled: number;
    /** 在线率（0-100，按 在线/(在线+离线) 口径） */
    onlineRate: number;
    /** 产品数 */
    productTotal: number;
    /** 物模型点位总数 */
    pointTotal: number;
    /** 近 7 日新增接入设备数 */
    newDevicesWeek: number;
    /** 今日消息总量 */
    messageToday: number;
    /** 今日上行消息量 */
    messageUplinkToday: number;
    /** 今日下行消息量 */
    messageDownlinkToday: number;
    /** 待处理告警数（pending + firing） */
    alertPending: number;
    /** 今日新增告警数 */
    alertToday: number;
    /** 今日已恢复告警数 */
    alertResolvedToday: number;
    /** 近 30 日消息趋势 */
    messageTrend: MessageTrendPoint[];
    /** 近 14 日在线趋势 */
    onlineTrend: OnlineTrendPoint[];
    /** 近 30 日告警趋势（按天、按严重级别，后端已补 0） */
    alertTrend: AlertTrendPoint[];
    /** 近 14 日设备增长（每日新增设备数） */
    deviceGrowthTrend: DeviceGrowthPoint[];
    /** 接入协议分布（按设备数）。`name` 是**协议码**（modbus/tcp/mqtt/opcua），展示层须经 protocolLabel 翻译 */
    protocolDistribution: NameValue[];
    /** 待处理告警级别分布。`name` 是**级别码**（critical/warning/info，小写，与告警中心同口径） */
    severityDistribution: NameValue[];
    /** 设备数 TOP 产品。`name` 是产品名（已是展示名，不做码值翻译） */
    productTop: NameValue[];
    /** 近 30 日告警数 TOP 规则。`name` 是规则名（后端已解析，非 ruleId） */
    alertRuleTop: NameValue[];
    /** 最近告警列表 */
    recentAlerts: RecentAlert[];
  }
}

/**
 * 获取 IoT 运行总览。
 *
 * 预留端点：`GET /iot/dashboard/overview`（网关 `/iot/**` StripPrefix=1）。
 * 后端未上线时由演示数据兜底，见 use-iot-overview。
 */
async function getIotOverview() {
  return requestClient.get<IotDashboardApi.Overview>('/iot/dashboard/overview');
}

export { getIotOverview };
