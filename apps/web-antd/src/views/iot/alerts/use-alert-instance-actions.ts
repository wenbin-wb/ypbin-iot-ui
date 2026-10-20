import type { Ref } from 'vue';

import { ref } from 'vue';

import { message } from 'ant-design-vue';

import { ackAlerts, silenceAlerts } from '#/api/iot';
import { $t } from '#/locales';

interface AlertInstanceActionDeps {
  /** 全量刷新入口（列表走守卫 request、摘要走串行化；由页面注入，保持「刷新只有一条路径」）。 */
  reloadAll: () => Promise<void>;
  /** 当前勾选的告警实例 id（处置成功后由本 composable 清空）。 */
  selectedIds: Ref<string[]>;
}

/**
 * 告警实例的处置动作（单条确认/静默 + 工具栏批量确认/批量静默）。
 *
 * 从 `index.vue` 拆出的原因（拆分批次 5-D）：四个动作共用同一条「调 API → 成功提示 →
 * 清勾选 → 整页刷新」链路，其中批量版本只是「防连点 + 复用单条逻辑」；留在页面里会与
 * vxe 守卫/查询配置混成一段 100+ 行的业务脚本。
 *
 * 纪律（拆分类改动不改行为）：
 * - **失败提示交给全局请求拦截器**（后端 message 原样弹），这里只返回 boolean 防未处理拒绝；
 * - 批量按钮的「在途」标记与单条处置**不共用**（避免行内点击把工具栏按钮也锁住）；
 * - 成功后必须清空勾选：否则界面上已看不到选中行，批量按钮却仍可点（对看不见的目标操作）。
 */
export function useAlertInstanceActions({
  reloadAll,
  selectedIds,
}: AlertInstanceActionDeps) {
  /** 批量确认/批量静默在途（只用于工具栏批量按钮：行内单条处置不共用，避免互相干扰）。 */
  const batchAckPending = ref(false);
  const batchSilencePending = ref(false);

  async function ack(ids: string[]) {
    try {
      const count = await ackAlerts(ids);
      message.success($t('page.iot.alert.ackDone', [count]));
      selectedIds.value = [];
      await reloadAll();
      return true;
    } catch {
      // 失败提示由全局请求拦截器统一展示；这里只兜底避免未处理拒绝
      return false;
    }
  }

  async function silence(ids: string[], minutes = 60) {
    try {
      const count = await silenceAlerts(ids, minutes);
      message.success($t('page.iot.alert.silenceDone', [count, minutes]));
      selectedIds.value = [];
      await reloadAll();
      return true;
    } catch {
      return false;
    }
  }

  /** 工具栏「批量确认」：防连点 + 在途期间按钮 loading/禁用（原因见 Tooltip）。 */
  async function batchAck() {
    if (batchAckPending.value) {
      return;
    }
    batchAckPending.value = true;
    try {
      await ack(selectedIds.value);
    } finally {
      batchAckPending.value = false;
    }
  }

  /** 工具栏「批量静默」：同样防连点；静默本身不弹二次确认（可撤销、且已有成功提示）。 */
  async function batchSilence() {
    if (batchSilencePending.value) {
      return;
    }
    batchSilencePending.value = true;
    try {
      await silence(selectedIds.value, 60);
    } finally {
      batchSilencePending.value = false;
    }
  }

  return {
    ack,
    batchAck,
    batchAckPending,
    batchSilence,
    batchSilencePending,
    silence,
  };
}
