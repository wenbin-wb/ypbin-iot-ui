import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { computed, onMounted, ref } from 'vue';

import { getIotOverview } from '#/api/dashboard/iot-overview';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { buildDemoOverview } from './iot-demo-data';

/**
 * IoT 运行总览数据域（分析页 + 工作台共用）。
 *
 * **失败口径（2026-10 审查后修订）**：以前 `catch` 里无条件把整屏换成演示数据，
 * 而 `failed` 两个消费方都没接、失败原因只进 console 与一个 hover tooltip
 * ⇒ 生产后端 5xx/超时时，运维会拿「2148 台设备」这种**伪造 KPI**当真实指标判断
 * 「今天很太平」（`review-20261020/04-uiux-visual.md` 唯一 P0）。
 *
 * 现在的规则：
 * - **生产（`import.meta.env.PROD`）失败不回落演示数据**：`overview` 保持 `null`、
 *   `failed = true`、`demoReason` 记「可展示的失败原因」，由页面渲染常驻错误态 + 重试；
 * - **非生产才允许演示兜底**（本地/联调需要页面上有内容可看），但 `usingDemo = true`
 *   且 `demoReason` 同样有值，页面必须常驻提示「当前是演示数据」——不再是 hover 才看得见；
 * - 失败原因统一走 `extractErrorMessage`（优先后端 message），不吞异常、不只进 console。
 *
 * 判断为什么放在调用时而不是模块加载时：`import.meta.env.PROD` 在单测里可被
 * `vi.stubEnv` 改写，写在模块顶层会被 import 那一刻固化，PROD 分支就永远测不到。
 */

/** 生产环境是否允许用演示数据兜底（生产必须为 false）。 */
function demoFallbackAllowed(): boolean {
  return !import.meta.env.PROD;
}

/** 失败/演示态的展示模型（页面原样交给 `ListErrorAlert`，不各自拼文案）。 */
export interface OverviewNotice {
  /** 具体原因（含后端 message），作为 Alert 的正文。 */
  error: string;
  /** 标题：生产是「加载失败」，非生产兜底是「当前是演示数据」。 */
  title: string;
  type: 'error' | 'warning';
}

export function useIotOverview() {
  const overview = ref<IotDashboardApi.Overview | null>(null);
  const loading = ref(true);
  const usingDemo = ref(false);
  /** 是否处于失败态（页面据此渲染常驻错误提示；与 `usingDemo` 正交）。 */
  const failed = ref(false);
  /** 失败原因（可直接展示；失败态与演示态都非空，页面据此给用户「为什么」）。 */
  const demoReason = ref('');

  async function load() {
    loading.value = true;
    failed.value = false;
    demoReason.value = '';
    try {
      const data = await getIotOverview();
      // 结构防御：字段缺失视为失败，避免图表读到 undefined 崩渲染
      if (!data || typeof data.deviceTotal !== 'number') {
        throw new Error('incomplete overview payload');
      }
      overview.value = data;
      usingDemo.value = false;
    } catch (error) {
      // 留痕（不静默）：但用户可见的那一份走 demoReason，页面必须渲染出来
      console.error('[iot/dashboard] 运行总览加载失败：', error);
      demoReason.value = extractErrorMessage(
        error,
        $t('page.dashboard.overviewLoadFailed'),
      );
      failed.value = true;
      if (demoFallbackAllowed()) {
        overview.value = buildDemoOverview();
        usingDemo.value = true;
      } else {
        // 生产：宁可显示错误态，也不把演示数字伪装成真实指标
        overview.value = null;
        usingDemo.value = false;
      }
    } finally {
      loading.value = false;
    }
  }

  onMounted(load);

  /**
   * 统一的「这一屏数据能不能信」提示。
   *
   * 只产出一条：非生产兜底时是**演示数据警告**（带真实失败原因），
   * 生产失败时是**错误态**。修前是「failed 与 usingDemo 各弹一条」，
   * 失败 + 演示同时成立会并排堆两条 Alert（一条说加载失败、一条说演示数据），
   * 用户反而不知道该信哪句 —— 所以合并成一条，由这里决定标题与语气。
   * 两页共用同一个映射，避免分析页/工作台文案与语气再次漂移。
   */
  const notice = computed<null | OverviewNotice>(() => {
    if (!failed.value) {
      return null;
    }
    return {
      error: $t('page.dashboard.overviewLoadFailedHint', [demoReason.value]),
      title: usingDemo.value
        ? $t('page.dashboard.demoModeTitle')
        : $t('page.dashboard.overviewLoadFailed'),
      type: usingDemo.value ? 'warning' : 'error',
    };
  });

  return { demoReason, failed, load, loading, notice, overview, usingDemo };
}
