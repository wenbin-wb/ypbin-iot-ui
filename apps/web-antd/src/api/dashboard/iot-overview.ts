import { requestClient } from '#/api/request';

/**
 * IoT 运行总览 API（首页分析页 / 工作台共用）。
 *
 * ⚠️ 后端目前**没有** `/iot/dashboard/overview` 统计端点；页面数据源走
 * `#/views/dashboard/shared/use-iot-overview.ts`：先试本接口，失败（含 404）
 * 自动回落演示数据并在页面标注「演示数据」。后端补齐端点后无需改前端即切真实数据，
 * 字段口径以下列类型为准。
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

  /** 最近告警条目（severity/state 取告警中心同一码值，前端按 page.iot.alert.* 翻译） */
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
    /** 接入协议分布（按设备数） */
    protocolDistribution: NameValue[];
    /** 待处理告警级别分布 */
    severityDistribution: NameValue[];
    /** 设备数 TOP 产品 */
    productTop: NameValue[];
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
