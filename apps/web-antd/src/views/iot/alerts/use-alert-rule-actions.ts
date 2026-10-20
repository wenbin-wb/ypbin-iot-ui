import type { Ref } from 'vue';

import { ref } from 'vue';

import { message } from 'ant-design-vue';

import { setAlertRulesEnabled } from '#/api/iot';
import { $t } from '#/locales';

interface AlertRuleActionDeps {
  /** 规则列表刷新入口（走规则表守卫，由页面注入）。 */
  requestReload: () => void;
  /** 当前勾选的规则 id（启停成功后由本 composable 清空）。 */
  selectedRuleIds: Ref<string[]>;
}

/**
 * 告警规则的启停动作（单条/批量启用、停用）。
 *
 * 从 `index.vue` 拆出的原因（拆分批次 5-D）：与告警实例处置同构的「调 API → 播报**实际生效条数**
 * → 清勾选 → 刷新」链路，且批量版本只是「防连点 + 复用单条逻辑」。
 *
 * 纪律（拆分类改动不改行为）：
 * - 播报用后端返回的**实际生效条数**（不是前端勾选数）：并发修改下两者可能不等，播报勾选数会撒谎；
 * - 失败不静默也不自造文案：全局拦截器展示后端 message，这里只返回 boolean；
 * - **二次确认由模板的 Popconfirm 负责**（批量停用 = N 类故障同时失去告警，误触代价高），
 *   本 composable 不再重复确认。
 */
export function useAlertRuleActions({
  requestReload,
  selectedRuleIds,
}: AlertRuleActionDeps) {
  /** 批量启停在途（工具栏两个按钮共用：同一时刻只允许一批，防连点造成两批交集）。 */
  const ruleTogglePending = ref(false);

  async function toggleRule(ids: string[], enabled: boolean) {
    try {
      const count = await setAlertRulesEnabled(ids, enabled);
      message.success(
        enabled
          ? $t('page.iot.alert.rule.enableDone', [count])
          : $t('page.iot.alert.rule.disableDone', [count]),
      );
      selectedRuleIds.value = [];
      requestReload();
      return true;
    } catch {
      return false;
    }
  }

  async function batchToggleRule(enabled: boolean) {
    if (ruleTogglePending.value) {
      return;
    }
    ruleTogglePending.value = true;
    try {
      await toggleRule(selectedRuleIds.value, enabled);
    } finally {
      ruleTogglePending.value = false;
    }
  }

  return {
    batchToggleRule,
    ruleTogglePending,
    toggleRule,
  };
}
