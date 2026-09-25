<script lang="ts" setup>
import { Button } from 'ant-design-vue';

import { $t } from '#/locales';

/**
 * 空态引导卡片（F6 的「空态」部分）。
 *
 * **为什么需要它**：列表为空时只显示一张空白表格，用户既不知道「为什么是空的」，
 * 也不知道「下一步点哪里」（方案 §5 的症状）。
 *
 * 这里只放**原因 + 下一步 + 一个入口按钮**，不把整个三步向导塞进表格空态：
 * 空态槽位的可用高度由表格决定，塞满向导会让短屏设备看不到按钮；完整向导在抽屉/独立页里。
 */
defineProps<{
  /** 「为什么是空的」——由各页面按自己的语境传入（设备/产品/维护窗口各不相同）。 */
  reason: string;
}>();

const emit = defineEmits<{
  /** 请求宿主打开完整接入向导。 */
  openGuide: [];
}>();
</script>
<template>
  <div class="flex flex-col items-center gap-2 px-6 py-8 text-center">
    <div class="font-medium">{{ $t('page.iot.onboarding.emptyTitle') }}</div>
    <div class="max-w-[520px] text-sm text-muted-foreground">{{ reason }}</div>
    <div class="max-w-[520px] text-xs text-muted-foreground">
      {{ $t('page.iot.onboarding.emptyNext') }}
    </div>
    <Button class="mt-1" type="primary" @click="emit('openGuide')">
      {{ $t('page.iot.onboarding.openGuide') }}
    </Button>
  </div>
</template>
