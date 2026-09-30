<script lang="ts" setup>
import { computed } from 'vue';

import { Tag } from 'ant-design-vue';

import { $t } from '#/locales';

import { resolveNotifyRisk } from '../notify-risk';

/**
 * 规则「通知对象」风险标签（看板 #14 前端可见提示）。
 *
 * emailBroken：EMAIL 渠道无收件邮箱（投递必败/GIVEN_UP）→ 红；
 * inboxOnly：仅 INBOX 且无显式收件人（后端回落给创建者）→ 蓝提示；
 * ok：正常 → 灰。
 */
const props = defineProps<{
  channels?: string;
  targets?: string;
}>();

const risk = computed(() => resolveNotifyRisk(props.channels, props.targets));

const labelKey = computed(() => {
  if (risk.value === 'emailBroken') {
    return 'page.iot.alert.notify.riskEmailBroken';
  }
  if (risk.value === 'inboxOnly') {
    return 'page.iot.alert.notify.riskInboxOnly';
  }
  return 'page.iot.alert.notify.riskOk';
});

const color = computed(() => {
  if (risk.value === 'emailBroken') {
    return 'error';
  }
  if (risk.value === 'inboxOnly') {
    return 'processing';
  }
  return 'default';
});
</script>

<template>
  <Tag :color="color">{{ $t(labelKey) }}</Tag>
</template>
