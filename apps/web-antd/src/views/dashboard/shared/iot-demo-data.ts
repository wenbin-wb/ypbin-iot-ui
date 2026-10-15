import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

/**
 * IoT 运行总览演示数据。
 *
 * 后端 `/iot/dashboard/overview` 统计端点尚未提供（本任务只做前端），这里用
 * **确定性伪随机**（固定种子）生成一版视觉饱满、量级自洽的演示数据：同一天多次
 * 打开页面数字稳定，便于回归与演示。接入真实接口后本文件即不再被消费。
 *
 * 量级口径全部自洽（在线 + 离线 + 停用 = 总数；上行 + 下行 = 今日消息；
 * 待处理告警 = 级别分布之和；告警趋势最后一天 = 今日新增告警；
 * 设备增长近 7 天之和 = 近 7 日新增设备），前端图表可直接交叉校验。
 */

/**
 * Park-Miller LCG：轻量确定性 PRNG，避免每次刷新数字跳动。
 * 全程只用乘加取模（中间值 < 2^53，无位运算），oxlint 友好。
 */
function seeded(seed: number) {
  let a = seed % 2_147_483_646;
  if (a <= 0) {
    a += 2_147_483_646;
  }
  return () => {
    a = (a * 16_807) % 2_147_483_647;
    return (a - 1) / 2_147_483_646;
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

function fmtDate(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 生成近 N 天日期序列（升序，末位为基准日；默认基准日 = 今天） */
function lastNDates(n: number, base: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    out.push(fmtDate(d));
  }
  return out;
}

/** 固定基准量，确保在线 + 离线 + 停用与总数自洽 */
const DEVICE_TOTAL = 2148;
const DEVICE_ONLINE = 1976;
const DEVICE_DISABLED = 37;
const DEVICE_OFFLINE = DEVICE_TOTAL - DEVICE_ONLINE - DEVICE_DISABLED;

const UPLINK_TODAY = 1_284_506;
const DOWNLINK_TODAY = 96_420;

// 与真实接口同口径：`name` 存**协议码**（后端 `protocolDistribution.name`），
// 展示层由 analytics-visits-data.vue 走 shared/display.protocolLabel 统一翻译——
// 演示数据若直接写中文名，会让映射逻辑在演示态下被绕过、真实态才暴露英文码。
const PROTOCOL_BASE: Array<[string, number]> = [
  ['mqtt', 986],
  ['modbus', 512],
  ['opcua', 268],
  ['tcp', 174],
];

const PRODUCT_BASE: Array<[string, number]> = [
  ['智能电表 · 三相', 428],
  ['温湿度传感器', 386],
  ['光伏逆变器', 312],
  ['水泵控制器', 264],
  ['电梯物联网网关', 220],
  ['环境空气质量站', 188],
  ['冷链温度记录仪', 162],
  ['工业振动传感器', 108],
];

/** 告警级别基数（待处理） */
const SEVERITY_BASE: Record<string, number> = {
  critical: 7,
  warning: 23,
  info: 41,
};

/** 今日新增告警（锚定 `alertToday`）；趋势最后一天按此拆分，保证图与指标卡对得上。 */
const ALERT_TODAY = 58;
const ALERT_TODAY_SPLIT = { critical: 8, info: 28, warning: 22 };

/** 近 7 日新增设备（锚定 `newDevicesWeek`）；增长趋势最后 7 天按此取值，保证和值一致。 */
const NEW_DEVICES_WEEK = 96;
const GROWTH_LAST_WEEK = [12, 14, 15, 13, 16, 14, 12];

/** 近 30 日告警数 TOP 规则（已按告警数降序；name 是解析后的展示名） */
const RULE_TOP_BASE: Array<[string, number]> = [
  ['电流超上限', 62],
  ['温度越上限(>8℃)', 47],
  ['离线超时(>5min)', 35],
  ['振动幅值越限', 24],
  ['湿度越上限', 18],
];

/**
 * 最近告警演示条目（设备名 / 规则名与产品/物模型语义一致）。
 * 触发时间相对当前时刻向前偏移，呈现「刚发生」的观感。
 */
const ALERT_SEEDS: Array<{
  device: string;
  minutesAgo: number;
  rule: string;
  severity: keyof typeof SEVERITY_BASE;
  state: string;
}> = [
  {
    device: '电表-A3-0172',
    rule: '电流超上限',
    severity: 'critical',
    state: 'firing',
    minutesAgo: 4,
  },
  {
    device: '冷链-仓B-008',
    rule: '温度越上限(>8℃)',
    severity: 'critical',
    state: 'firing',
    minutesAgo: 18,
  },
  {
    device: '水泵-西区-021',
    rule: '离线超时(>5min)',
    severity: 'warning',
    state: 'firing',
    minutesAgo: 42,
  },
  {
    device: '逆变器-光伏-114',
    rule: '发电功率骤降',
    severity: 'warning',
    state: 'acked',
    minutesAgo: 96,
  },
  {
    device: '电梯-1号楼-2',
    rule: '振动幅值越限',
    severity: 'warning',
    state: 'firing',
    minutesAgo: 150,
  },
  {
    device: '空气站-高新区',
    rule: 'PM2.5 超标',
    severity: 'info',
    state: 'resolved',
    minutesAgo: 210,
  },
  {
    device: '温湿度-车间7',
    rule: '湿度越上限',
    severity: 'info',
    state: 'firing',
    minutesAgo: 300,
  },
];

/**
 * 构造运行总览演示数据。
 *
 * 可选传入基准时刻（默认当前时间），方便测试断言。
 */
export function buildDemoOverview(
  now: Date = new Date(),
): IotDashboardApi.Overview {
  const rand = seeded(20_260_101);

  // 近 30 日上/下行趋势：以今日值为锚，向前围绕基线做平滑波动 + 周内节律
  const messageDates = lastNDates(30, now);
  const messageTrend: IotDashboardApi.MessageTrendPoint[] = messageDates.map(
    (date, idx) => {
      const day = new Date(date).getDay();
      // 工作日流量高、周末回落，制造真实节律
      const weekendFactor = day === 0 || day === 6 ? 0.72 : 1;
      const drift = 0.86 + (idx / messageDates.length) * 0.28; // 缓慢爬升
      const jitter = 0.9 + rand() * 0.2;
      const uplink = Math.round(
        (UPLINK_TODAY / 30) * 3 * weekendFactor * drift * jitter,
      );
      const downlink = Math.round(uplink * (0.06 + rand() * 0.03));
      return { date, downlink, uplink };
    },
  );

  // 近 14 日在线/离线趋势：围绕当前在线量小幅波动
  const onlineDates = lastNDates(14, now);
  const onlineTrend: IotDashboardApi.OnlineTrendPoint[] = onlineDates.map(
    (date) => {
      const rate = 0.9 + rand() * 0.07; // 90%~97%
      const online = Math.round(DEVICE_TOTAL * rate);
      return {
        date,
        offline: DEVICE_TOTAL - online,
        online,
      };
    },
  );

  // 近 30 日告警趋势：工作日多、周末少；最后一天严格等于 alertToday 的三级拆分
  const alertDates = lastNDates(30, now);
  const alertTrend: IotDashboardApi.AlertTrendPoint[] = alertDates.map(
    (date, idx) => {
      if (idx === alertDates.length - 1) {
        return { date, ...ALERT_TODAY_SPLIT };
      }
      const day = new Date(date).getDay();
      const weekendFactor = day === 0 || day === 6 ? 0.7 : 1;
      const total = Math.round(52 * weekendFactor * (0.85 + rand() * 0.3));
      const critical = Math.round(total * 0.14);
      const warning = Math.round(total * 0.38);
      return { critical, date, info: total - critical - warning, warning };
    },
  );

  // 近 14 日设备增长：最后 7 天用固定序列（和 = newDevicesWeek），更早 7 天走确定性伪随机
  const growthDates = lastNDates(14, now);
  const growthSeedStart = growthDates.length - GROWTH_LAST_WEEK.length;
  const deviceGrowthTrend: IotDashboardApi.DeviceGrowthPoint[] =
    growthDates.map((date, idx) => ({
      added:
        idx >= growthSeedStart
          ? (GROWTH_LAST_WEEK[idx - growthSeedStart] ?? 0)
          : Math.round(8 + rand() * 10),
      date,
    }));

  const protocolDistribution: IotDashboardApi.NameValue[] = PROTOCOL_BASE.map(
    ([name, value]) => ({ name, value }),
  );

  const severityDistribution: IotDashboardApi.NameValue[] = [
    { name: 'critical', value: SEVERITY_BASE.critical ?? 0 },
    { name: 'warning', value: SEVERITY_BASE.warning ?? 0 },
    { name: 'info', value: SEVERITY_BASE.info ?? 0 },
  ];

  const productTop: IotDashboardApi.NameValue[] = PRODUCT_BASE.map(
    ([name, value]) => ({ name, value }),
  );

  const alertRuleTop: IotDashboardApi.NameValue[] = RULE_TOP_BASE.map(
    ([name, value]) => ({ name, value }),
  );

  const recentAlerts: IotDashboardApi.RecentAlert[] = ALERT_SEEDS.map(
    (a, i) => {
      const t = new Date(now.getTime() - a.minutesAgo * 60_000);
      return {
        deviceName: a.device,
        id: `demo-alert-${i + 1}`,
        ruleName: a.rule,
        severity: a.severity,
        state: a.state,
        triggeredAt: `${fmtDate(t)} ${pad(t.getHours())}:${pad(t.getMinutes())}`,
      };
    },
  );

  return {
    // 待处理口径 = 三级级别分布之和（含提示级积压），与饼图交叉自洽
    alertPending: Object.values(SEVERITY_BASE).reduce((acc, v) => acc + v, 0),
    alertResolvedToday: 34,
    alertRuleTop,
    alertToday: ALERT_TODAY,
    alertTrend,
    deviceDisabled: DEVICE_DISABLED,
    deviceGrowthTrend,
    deviceOffline: DEVICE_OFFLINE,
    deviceOnline: DEVICE_ONLINE,
    deviceTotal: DEVICE_TOTAL,
    messageDownlinkToday: DOWNLINK_TODAY,
    messageTrend,
    messageToday: UPLINK_TODAY + DOWNLINK_TODAY,
    messageUplinkToday: UPLINK_TODAY,
    newDevicesWeek: NEW_DEVICES_WEEK,
    onlineRate: Number(
      ((DEVICE_ONLINE / (DEVICE_TOTAL - DEVICE_DISABLED)) * 100).toFixed(1),
    ),
    onlineTrend,
    pointTotal: 8642,
    productTop,
    productTotal: 48,
    protocolDistribution,
    recentAlerts,
    severityDistribution,
  };
}
