<script lang="ts" setup>
import { Page } from '@vben/common-ui';

import { $t } from '#/locales';

import Guide from './modules/guide.vue';

/**
 * 接入向导页面（F6）。
 *
 * **为什么做成独立页面**：方案 §6.1 把它放在「起步 → 接入向导」，新租户落地即可见、无需权限码。
 * 但**当前没有它的 `sys_menu` 记录**（本轮刻意不新建菜单：另有改动正在动 `sys_menu` 的种子 SQL，
 * 分开合入避免冲突），所以这个 `index.vue` 是**给菜单接线预留的落点**：
 * 菜单行的 `component` 填 `/iot/onboarding/index`（约定见 `views/iot/*/index.vue`）即可生效。
 * 在菜单接上之前，同一份向导已通过设备台账/产品页的**空态引导 + 工具栏按钮**可达，不是死代码。
 */
</script>
<template>
  <Page :title="$t('page.iot.onboarding.title')">
    <Guide />
  </Page>
</template>
