<script lang="ts" setup>
import { computed, onBeforeUnmount, ref } from 'vue';

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

/** 「已复制」勾选态保持时长（毫秒）：够看到反馈，又不至于干扰连续复制下一个字段。 */
const COPIED_FEEDBACK_MS = 1500;

const copied = ref(false);

/**
 * 「已复制」勾选态的复位定时器。
 *
 * 必须在卸载时清掉：复制后被点走的抽屉/页面（如设备详情里的 AccessKey）
 * 卸载后定时器仍会跑到 1.5s 才释放闭包，属实打实的句柄泄漏；
 * 单测里表现为 `vitest-pool Timeout terminating forks worker`。
 */
let resetTimer: ReturnType<typeof setTimeout> | undefined;

function clearResetTimer() {
  if (resetTimer !== undefined) {
    clearTimeout(resetTimer);
    resetTimer = undefined;
  }
}

onBeforeUnmount(clearResetTimer);

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
    // 连点/连续复制时先清上一个定时器，避免旧定时器提前把新一次的勾选态复位
    clearResetTimer();
    resetTimer = setTimeout(() => {
      copied.value = false;
      resetTimer = undefined;
    }, COPIED_FEEDBACK_MS);
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
        <Check v-if="copied" class="size-3.5 text-success-text" />
        <Copy v-else class="size-3.5" />
      </Button>
    </Tooltip>
  </span>
</template>
