<script lang="ts" setup>
import { ref } from 'vue';

import { Page } from '@vben/common-ui';

import { Tabs } from 'ant-design-vue';

import { $t } from '#/locales';

import AccessOverview from './modules/access-overview.vue';
import TenantLedger from './modules/ledger.vue';

/**
 * 租户接入台账页面壳。
 *
 * 只做两件事：套一层 `Page`（提供 `auto-content-height` 的确定高度），
 * 再把真正的内容组件 `modules/ledger.vue` 放进来 —— 内容组件本身不含 `Page`，
 * 因此它也能被主 agent 直接当抽屉内容复用（见 `modules/ledger.vue` 文件头）。
 *
 * **菜单已由迁移补齐**（2026-09-29 更正，此前写的是「暂无菜单入口」）：
 * `sys_menu` 里的 320014 / 320015 是 `type='button'` 的**权限码载体**
 * （见后端 `deploy/sql/007-iot-data.sql` 与
 * `deploy/sql/migration/2026-09-21-iot-m2-ledger-menu.sql`），它们不是页面菜单；
 * 页面级菜单行由 `deploy/sql/migration/2026-09-29-iot-menu-onboarding-ledger.sql` 补上：
 * **3206**（`type='menu'`，`platform_only=1`，`component=/iot/tenant-ledger/index`，
 * 标题键 `page.iot.ledger.pageTitle`）。同时补了 **3205**（接入向导页）。
 *
 * ⚠️ 页面标题用的是 `page.iot.ledger.pageTitle`，**不要**改成
 * `page.iot.ledger.title`：后者是既有键（「设备台账变更」），已被权限按钮 320014
 * （`iot:ledger:list`）当作显示标题引用（菜单树按 `$t(row.title)` 翻译），
 * 换掉它等于把那个按钮改名。
 *
 * ⚠️ 权限级别：`iot:ledger:*` 是**平台级**权限（后端 Javadoc 明确要求「不进
 * `sys_template_menu`」，否则任一租户管理员都能改别人的租户是否被采集）
 * ⇒ 3206 与既有 320014 / 320015 保持一致（`platform_only=1`），**只进 `sys_role_menu`、
 * 不进 `sys_template_menu`**；3205 才是 `platform_only=0`（租户可见）。
 *
 * 2026-10-11：新增「接入节点与指标」页签（`modules/access-overview.vue`，只读）。
 * 之所以做成**页签**而不是新菜单：两者受众完全相同（平台管理员）、权限码也相同
 * （`iot:ledger:list`）⇒ 复用既有菜单/授权面，不新造跨租户可见入口；
 * 后端契约见 `AccessOverviewController`（`GET /iot/access-overview`）。
 */

/** 当前页签（默认「租户台账」）。 */
const activeKey = ref<'ledger' | 'overview'>('ledger');
</script>

<template>
  <Page auto-content-height>
    <!--
      ⚠️ 两个子组件都是 `h-full` 高度链的消费者（vxe 表格没有确定高度就不渲染行），
      因此 `<Tabs>` 必须把高度**透传**给内容区，不能只靠 TabPane 默认布局。
      `.ledger-tabs` 的样式见文件底部（content-holder flex:1 + min-height:0 + 逐层 h-full）。
    -->
    <Tabs v-model:active-key="activeKey" class="ledger-tabs">
      <Tabs.TabPane key="ledger" :tab="$t('page.iot.ledger.pageTitle')">
        <div class="h-full"><TenantLedger /></div>
      </Tabs.TabPane>
      <Tabs.TabPane key="overview" :tab="$t('page.iot.overview.overview')">
        <div class="h-full"><AccessOverview /></div>
      </Tabs.TabPane>
    </Tabs>
  </Page>
</template>

<style scoped>
/* 高度链：Page(auto-content-height) → Tabs → content-holder → tabpane → 子组件(h-full)。
   缺任何一层，vxe 表格拿到的高度就是 0 ⇒ 有数据也不渲染（实测：接口 200 但页面空白）。 */
.ledger-tabs {
  height: 100%;
}

.ledger-tabs :deep(.ant-tabs-nav) {
  padding: 0 16px;
  margin-bottom: 0;
}

.ledger-tabs :deep(.ant-tabs-content-holder) {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: 12px 16px;
}

.ledger-tabs :deep(.ant-tabs-content) {
  height: 100%;
}

.ledger-tabs :deep(.ant-tabs-tabpane) {
  height: 100%;
}
</style>
