<script lang="ts" setup>
import { computed } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';
import { BookOpenText } from '@vben/icons';
import { preferences } from '@vben/preferences';

import { Alert } from 'ant-design-vue';

import { $t } from '#/locales';

/**
 * 术语词典抽屉（IoT 各页共用）。
 *
 * 面向两类人：专业运维与普通物业/值班人员。每个词条只回答两件事——
 * 「是什么」（一句话，不堆内部码/枚举）与「什么时候会用到」（给行动指引），
 * 不写字段名、不贴接口路径，避免词典本身变成新的门槛。
 *
 * 标题复用既有模块名键（协议/端点/物模型/点位映射/维护窗口/告警规则/API Key/平台自告警），
 * 只有「设备影子」「可用率与断档」没有现成标题键，单独新增 termShadow/termAvailability。
 */
interface HelpTerm {
  /** 词条标题的 i18n 键（优先复用既有模块标题键）。 */
  titleKey: string;
  /** 「什么时候会用到」的 i18n 键。 */
  whenKey: string;
  /** 「是什么」的 i18n 键。 */
  whatKey: string;
}

const TERMS: HelpTerm[] = [
  {
    titleKey: 'page.iot.device.protocol',
    whatKey: 'page.iot.help.termProtocolWhat',
    whenKey: 'page.iot.help.termProtocolWhen',
  },
  {
    titleKey: 'page.iot.device.endpoint',
    whatKey: 'page.iot.help.termEndpointWhat',
    whenKey: 'page.iot.help.termEndpointWhen',
  },
  {
    titleKey: 'page.iot.product.tabThingModel',
    whatKey: 'page.iot.help.termThingModelWhat',
    whenKey: 'page.iot.help.termThingModelWhen',
  },
  {
    titleKey: 'page.iot.point.title',
    whatKey: 'page.iot.help.termPointMappingWhat',
    whenKey: 'page.iot.help.termPointMappingWhen',
  },
  {
    titleKey: 'page.iot.help.termShadow',
    whatKey: 'page.iot.help.termShadowWhat',
    whenKey: 'page.iot.help.termShadowWhen',
  },
  {
    titleKey: 'page.iot.help.termAvailability',
    whatKey: 'page.iot.help.termAvailabilityWhat',
    whenKey: 'page.iot.help.termAvailabilityWhen',
  },
  {
    titleKey: 'page.iot.maintenance.shortTitle',
    whatKey: 'page.iot.help.termMaintenanceWhat',
    whenKey: 'page.iot.help.termMaintenanceWhen',
  },
  {
    titleKey: 'page.iot.alert.tabRules',
    whatKey: 'page.iot.help.termAlertRuleWhat',
    whenKey: 'page.iot.help.termAlertRuleWhen',
  },
  {
    titleKey: 'page.iot.openApiKey.title',
    whatKey: 'page.iot.help.termOpenApiKeyWhat',
    whenKey: 'page.iot.help.termOpenApiKeyWhen',
  },
  {
    titleKey: 'page.iot.platformAlert.title',
    whatKey: 'page.iot.help.termPlatformAlertWhat',
    whenKey: 'page.iot.help.termPlatformAlertWhen',
  },
];

/**
 * 标签后的分隔符必须**跟着语言走**。
 *
 * 原先硬编码全角 `：`，中文渲染「是什么：」正常，但切到 en-US 会变成
 * `What it is：`（英文 + 中式全角冒号 + 全角间距）——这类「运行期拼接」不在
 * i18n 键存在性/文案编译门禁的检查范围内，是典型门禁盲区。
 * 不新增 i18n 键（避免动 locales）：中文族用全角冒号，其余用半角冒号 + 空格。
 */
const labelSeparator = computed(() =>
  preferences.app.locale.startsWith('zh') ? '：' : ': ',
);

/** 两个行首标签（含分隔符）：预计算避免模板里出现超过 80 列的整行。 */
const whatLabel = computed(
  () => `${$t('page.iot.help.whatLabel')}${labelSeparator.value}`,
);
const whenLabel = computed(
  () => `${$t('page.iot.help.whenLabel')}${labelSeparator.value}`,
);

const [Drawer, drawerApi] = useVbenDrawer({
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      return;
    }
    drawerApi.setState({ title: $t('page.iot.help.title') });
  },
});

defineExpose({ drawerApi });
</script>

<template>
  <Drawer class="w-[640px] max-w-[calc(100vw-40px)]">
    <div class="flex flex-col gap-3">
      <Alert :message="$t('page.iot.help.intro')" show-icon type="info" />
      <div
        v-for="term in TERMS"
        :key="term.titleKey"
        class="rounded-lg border border-border/80 bg-card p-3"
      >
        <div class="flex items-center gap-2 text-sm font-semibold">
          <BookOpenText class="size-4 shrink-0 text-primary" />
          {{ $t(term.titleKey) }}
        </div>
        <div class="mt-1.5 flex gap-1.5 text-sm leading-relaxed">
          <span class="shrink-0 text-muted-foreground">{{ whatLabel }}</span>
          <span>{{ $t(term.whatKey) }}</span>
        </div>
        <div class="mt-1 flex gap-1.5 text-sm leading-relaxed">
          <span class="shrink-0 text-muted-foreground">{{ whenLabel }}</span>
          <span class="text-muted-foreground">{{ $t(term.whenKey) }}</span>
        </div>
      </div>
    </div>
  </Drawer>
</template>
