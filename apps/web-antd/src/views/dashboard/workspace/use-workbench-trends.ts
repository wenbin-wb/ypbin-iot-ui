import type { Ref } from 'vue';

import type { WorkbenchTrendItem } from '@vben/common-ui';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { computed } from 'vue';

import { $t } from '#/locales';

/** 动态条目头像池（与工作台其它演示元素共用 svg 头像） */
const DEMO_AVATARS = [
  'svg:avatar-1',
  'svg:avatar-2',
  'svg:avatar-3',
  'svg:avatar-4',
];

/**
 * 工作台「最近告警动态」域：把运行总览的 recentAlerts 映射成动态流。
 *
 * severity/state 与告警中心同一码值口径（`page.iot.alert.severity.*` /
 * `page.iot.alert.state.*`），保证两处文案一致。数据源为
 * useIotOverview —— 真实接口缺位时即演示数据兜底，`usingDemo` 由总览侧统一标注。
 */
export function useWorkbenchTrends(
  overview: Ref<IotDashboardApi.Overview | null>,
) {
  const trendItems = computed<WorkbenchTrendItem[]>(() => {
    const data = overview.value;
    if (!data) return [];
    return data.recentAlerts.map((alert, index) => ({
      avatar: DEMO_AVATARS[index % (DEMO_AVATARS.length ?? 1)] as string,
      content: `[${$t(`page.iot.alert.severity.${alert.severity}`)}] ${alert.ruleName} · ${$t(`page.iot.alert.state.${alert.state}`)}`,
      date: alert.triggeredAt,
      title: alert.deviceName,
    }));
  });

  return { trendItems };
}
