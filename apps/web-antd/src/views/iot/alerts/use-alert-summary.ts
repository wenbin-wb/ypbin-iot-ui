import type { IotAlertApi } from '#/api/iot';

import { ref } from 'vue';

import { getAlertSummary } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { createSerialRunner } from './list-state';

/**
 * 告警中心顶部计数（摘要）状态。
 *
 * 从 `index.vue` 拆出的原因（2026-10-20 拆分批次 5-D）：摘要是**一条独立的聚合查询**，
 * 与两张 vxe 表格的查询/守卫完全无关；混在页面里时，页面脚本同时承担「摘要串行化」与
 * 「表格在途守卫」两套并发语义，容易读错。
 *
 * 🔴 串行化为什么只有摘要需要：`reload()` 不走 vxe，没有 vxe 那层「在途丢 query」的天然守卫，
 * 而它会被「进页面」与「确认/静默后的整页刷新」两处触发 ⇒ 两次请求可以同时在途，最终值取决于
 * 谁最后**返回**（旧请求后到会把刚确认后的计数回退）。两张表格不用守：vxe 在 `tableLoading`
 * 期间会直接丢弃再来的 query，天然至多一个在途。
 */
export function useAlertSummary() {
  const summary = ref<IotAlertApi.SummaryResp>();
  const summaryError = ref('');
  const runSummaryQuery = createSerialRunner();

  async function reload() {
    return runSummaryQuery(async () => {
      try {
        summary.value = await getAlertSummary();
        summaryError.value = '';
      } catch (error) {
        // 失败不画成 0：清空数值 + 原样展示后端 message（失败态与「真的没有告警」必须区分）
        summary.value = undefined;
        summaryError.value = extractErrorMessage(
          error,
          $t('page.iot.alert.summaryLoadFailed'),
        );
      }
    });
  }

  return { reload, summary, summaryError };
}
