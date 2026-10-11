<script lang="ts" setup>
import { Page } from '@vben/common-ui';

import { Tabs } from 'ant-design-vue';

import { $t } from '#/locales';

import AccessOverview from './modules/access-overview.vue';
import TenantLedger from './modules/ledger.vue';

/**
 * 租户接入台账（F5）页面壳。
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
</script>

<template>
  <Page auto-content-height>
    <Tabs>
      <Tabs.Tab key="ledger" :tab="$t('page.iot.ledger.pageTitle')">
        <TenantLedger />
      </Tabs.Tab>
      <Tabs.Tab key="overview" :tab="$t('page.iot.overview.overview')">
        <AccessOverview />
      </Tabs.Tab>
    </Tabs>
  </Page>
</template>
