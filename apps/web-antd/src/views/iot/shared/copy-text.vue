<script lang="ts" setup>
import { computed, ref } from 'vue';

import { Check, Copy } from '@vben/icons';

import { Button, message, Tooltip } from 'ant-design-vue';

import { $t } from '#/locales';

import { displayOrFallback } from './display';

/**
 * 「文本 + 一键复制」小件（IoT 各页共用）。
 *
 * 用在裸 ID / DeviceCode / AccessKey / endpoint 这类**长且必须精确复制**的字段旁：
 * 让用户不必手工拖选、也不怕复制漏字符。空值只显示 `-`，不渲染复制按钮。
 */
const props = withDefaults(
  defineProps<{
    /** 展示文本；默认与 `value` 相同。 */
    display?: null | string;
    /** 展示文本是否用等宽字体（ID / Key / endpoint 默认开）。 */
    mono?: boolean;
    /** 要复制的内容（空值时只展示占位符，不出现按钮）。 */
    value?: null | string;
    /** 展示文本是否允许换行；默认单行截断（title 兜完整值）。 */
    wrap?: boolean;
  }>(),
  {
    display: undefined,
    mono: true,
    value: undefined,
    wrap: false,
  },
);

const copied = ref(false);

const text = computed(() => props.value ?? '');

const shown = computed(() =>
  displayOrFallback(props.display ?? props.value ?? undefined),
);

async function copy() {
  const value = text.value;
  if (!value) {
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    copied.value = true;
    message.success($t('page.iot.display.copySuccess'));
    window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // 剪贴板 API 受浏览器安全上下文/权限限制；失败必须让用户知道，不能静默。
    message.error($t('page.iot.display.copyFailed'));
  }
}
</script>

<template>
  <span class="inline-flex min-w-0 max-w-full items-center gap-1 align-middle">
    <span
      :class="[
        mono ? 'font-mono text-xs' : '',
        wrap ? 'break-all whitespace-pre-wrap' : 'truncate',
      ]"
      :title="text || undefined"
    >
      {{ shown }}
    </span>
    <Tooltip v-if="text" :title="$t('page.iot.display.copy')">
      <Button class="shrink-0" size="small" type="text" @click.stop="copy">
        <Check v-if="copied" class="size-3.5 text-green-600" />
        <Copy v-else class="size-3.5" />
      </Button>
    </Tooltip>
  </span>
</template>
