<script lang="ts" setup>
import { computed } from 'vue';

import { Tag } from 'ant-design-vue';

import { $t } from '#/locales';

import { notifyRiskLabelKey, resolveNotifyRisk } from '../notify-risk';

/**
 * 规则「通知对象」风险标签（列表页的前端可见提示）。
 *
 * noChannel：一个渠道都没选（不会产生任何通知记录）→ 红；
 * noTargets：选了渠道但通知对象为空（站内信走兜底、邮件看平台兜底邮箱）→ 橙；
 * emailFallback：EMAIL 无邮箱收件人（仅平台兜底邮箱可送达）→ 橙；
 * inboxFallback：INBOX 无用户收件人（兜底给创建者 ∪ 平台兜底用户）→ 蓝提示；
 * ok：正常 → 灰。
 */
const props = defineProps<{
  channels?: string;
  targets?: string;
}>();

const risk = computed(() => resolveNotifyRisk(props.channels, props.targets));

const labelKey = computed(() => notifyRiskLabelKey(risk.value));

const color = computed(() => {
  switch (risk.value) {
    case 'emailFallback': {
      return 'warning';
    }
    case 'inboxFallback': {
      return 'processing';
    }
    case 'noChannel': {
      return 'error';
    }
    case 'noTargets': {
      return 'warning';
    }
    default: {
      return 'default';
    }
  }
});
</script>

<template>
  <Tag :color="color">{{ $t(labelKey) }}</Tag>
</template>
