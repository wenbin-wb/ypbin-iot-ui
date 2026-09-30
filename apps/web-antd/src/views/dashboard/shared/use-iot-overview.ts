import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { onMounted, ref } from 'vue';

import { getIotOverview } from '#/api/dashboard/iot-overview';

import { buildDemoOverview } from './iot-demo-data';

/**
 * IoT 运行总览数据域（分析页 + 工作台共用）。
 *
 * 策略：先尝试真实接口 `GET /iot/dashboard/overview`；该端点后端尚未提供，
 * 失败时**自动回落**到确定性演示数据，并用 `usingDemo` 标记，页面上可据此
 * 展示「演示数据」徽标，避免把假数据当真实指标误导运维。
 *
 * 后端补齐端点后无需改前端：真实数据返回即用，`usingDemo` 自然变 false。
 */
export function useIotOverview() {
  const overview = ref<IotDashboardApi.Overview | null>(null);
  const loading = ref(true);
  const usingDemo = ref(false);
  const failed = ref(false);

  async function load() {
    loading.value = true;
    failed.value = false;
    try {
      const data = await getIotOverview();
      // 结构防御：字段缺失视为回落演示数据，避免图表读到 undefined 崩渲染
      if (!data || typeof data.deviceTotal !== 'number') {
        throw new Error('incomplete overview payload');
      }
      overview.value = data;
      usingDemo.value = false;
    } catch (error) {
      console.error('Failed to load IoT overview, using demo data:', error);
      overview.value = buildDemoOverview();
      usingDemo.value = true;
      failed.value = true;
    } finally {
      loading.value = false;
    }
  }

  onMounted(load);

  return { failed, load, loading, overview, usingDemo };
}
