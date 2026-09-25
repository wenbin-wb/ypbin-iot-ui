<script lang="ts" setup>
import { Page } from '@vben/common-ui';

import { $t } from '#/locales';

import Guide from './modules/guide.vue';

// 接入向导页面（F6）：页面级落点，供菜单接线使用。
//
// 方案 §6.1 把它放在「起步 → 接入向导」，新租户落地即可见、无需权限码。
// 当前**没有**它的 sys_menu 记录（本轮刻意不新建菜单：另有改动正在动 sys_menu 的种子 SQL，
// 分开合入避免冲突），所以本文件是给菜单接线预留的落点：菜单行的 component 填
// /iot/onboarding/index（约定与其它 views/iot 页面一致）即可生效。
// 在菜单接上之前，同一份向导已通过设备/产品/维护窗口页的空态引导与工具栏按钮可达，不是死代码。
</script>
<template>
  <Page :title="$t('page.iot.onboarding.title')">
    <Guide />
  </Page>
</template>
