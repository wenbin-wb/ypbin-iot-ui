<script lang="ts" setup>
import { Page } from '@vben/common-ui';

import { $t } from '#/locales';

import Guide from './modules/guide.vue';

// 接入向导页面（F6）：页面级落点，供菜单接线使用。
//
// 方案 §6.1 把它放在「起步 → 接入向导」，新租户落地即可见、无需权限码。
// **菜单已由迁移补齐**（2026-09-29 更正，此前写的是「暂无菜单」）：
// `ypbin-iot` 的 `deploy/sql/migration/2026-09-29-iot-menu-onboarding-ledger.sql` 新增了
// `sys_menu` **3205**（`type='menu'`，`component=/iot/onboarding/index`，标题键
// `page.iot.onboarding.title`，`platform_only=0` ⇒ 同步进 `sys_template_menu`）。
// 本文件此前只是「给菜单接线预留的落点」，现在菜单行已存在，不再依赖设备/产品页的空态引导才可达。
</script>
<template>
  <Page :title="$t('page.iot.onboarding.title')">
    <Guide />
  </Page>
</template>
