<script lang="ts" setup>
import { Page, useVbenDrawer } from '@vben/common-ui';
import { CircleHelp } from '@vben/icons';

import { Button } from 'ant-design-vue';

import { $t } from '#/locales';

import HelpDrawer from '../shared/help-drawer.vue';
import Guide from './modules/guide.vue';

// 接入向导页面：页面级落点，供菜单接线使用。
//
// 它放在「起步 → 接入向导」，新租户落地即可见、无需权限码。
// **菜单已由迁移补齐**（2026-09-29 更正，此前写的是「暂无菜单」）：
// `ypbin-iot` 的 `deploy/sql/migration/2026-09-29-iot-menu-onboarding-ledger.sql` 新增了
// `sys_menu` **3205**（`type='menu'`，`component=/iot/onboarding/index`，标题键
// `page.iot.onboarding.title`，`platform_only=0` ⇒ 同步进 `sys_template_menu`）。
// 本文件此前只是「给菜单接线预留的落点」，现在菜单行已存在，不再依赖设备/产品页的空态引导才可达。

/** 术语词典抽屉：放在页头 extra 而不是向导卡片内部，老用户把向导收起后入口仍在。 */
const [HelpDrawerContainer, helpDrawerApi] = useVbenDrawer({
  connectedComponent: HelpDrawer,
});

function openHelp() {
  helpDrawerApi.open();
}
</script>
<template>
  <Page :title="$t('page.iot.onboarding.title')">
    <template #extra>
      <Button @click="openHelp">
        <CircleHelp class="size-4" />
        {{ $t('page.iot.help.open') }}
      </Button>
    </template>
    <Guide />
    <HelpDrawerContainer />
  </Page>
</template>
