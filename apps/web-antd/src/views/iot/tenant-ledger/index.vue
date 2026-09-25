<script lang="ts" setup>
import { Page } from '@vben/common-ui';

import TenantLedger from './modules/ledger.vue';

/**
 * 租户接入台账（F5）页面壳。
 *
 * 只做两件事：套一层 `Page`（提供 `auto-content-height` 的确定高度），
 * 再把真正的内容组件 `modules/ledger.vue` 放进来 —— 内容组件本身不含 `Page`，
 * 因此它也能被主 agent 直接当抽屉内容复用（见 `modules/ledger.vue` 文件头）。
 *
 * 本页**暂无菜单入口**（刻意为之）：`sys_menu` 里现存的 320014 / 320015 是
 * `type='button'` 的**权限码载体**（见后端 `deploy/sql/007-iot-data.sql` 与
 * `deploy/sql/migration/2026-09-21-iot-m2-ledger-menu.sql`），并没有 `type='menu'`
 * 的页面级菜单行；本分支不新增任何菜单 SQL，入口接线由主 agent 统一负责。
 *
 * ⚠️ 接线时页面标题请用本分支新增的 `page.iot.ledger.pageTitle`，**不要**复用
 * `page.iot.ledger.title`：后者是既有键（「设备台账变更」），已被权限按钮 320014
 * （`iot:ledger:list`）当作显示标题引用（菜单树按 `$t(row.title)` 翻译），
 * 复用它等于把那个按钮改名。
 *
 * ⚠️ 权限级别：`iot:ledger:*` 是**平台级**权限（后端 Javadoc 明确要求「不进
 * `sys_template_menu`」，否则任一租户管理员都能改别人的租户是否被采集）
 * ⇒ 新增的页面菜单行应与既有 320014 / 320015 保持一致，且不得写进租户模板。
 */
</script>
<template>
  <Page auto-content-height>
    <TenantLedger />
  </Page>
</template>
