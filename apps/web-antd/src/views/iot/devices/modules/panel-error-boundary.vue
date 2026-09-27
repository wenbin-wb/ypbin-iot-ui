<script lang="ts" setup>
import { onErrorCaptured, ref } from 'vue';

import { Alert } from 'ant-design-vue';

import { $t } from '#/locales';

/**
 * 渲染错误边界（**只用于「在线调试」页签**）。
 *
 * 为什么必须有这一层：2026-09-27 线上事故的形态是「点开在线调试页签整块空白」——
 * 根因是 i18n 文案里写了字面 `{` `}`（vue-i18n 的消息编译器把 `{"a":1}` 当成非法占位符，
 * `$t(...)` 直接抛 `SyntaxError`）。**渲染函数里抛异常 ⇒ 整棵子树渲染不出来 ⇒ 空白**，
 * 而且 typecheck / 构建 / 键存在性门禁全绿（`$t` 是运行期才编译消息的）。
 *
 * 本组件把「页签内容区内任何后代组件的 setup/render 异常」截住并**用 Alert 原样展示**：
 * 既不静默吞掉（技术规范禁止），也不让它把整个抽屉画成空白。
 * 返回 `false` 是刻意的：错误已在此处显式呈现，不再向上冒泡（避免重复提示）。
 *
 * @author wenbin
 * @since 2026-09-27
 */
const error = ref<Error>();

onErrorCaptured((err) => {
  error.value = err as Error;
  return false;
});
</script>

<template>
  <Alert
    v-if="error"
    :message="$t('page.iot.debug.renderFailed')"
    show-icon
    type="error"
  >
    <template #description>
      <pre class="mt-1 text-xs break-all whitespace-pre-wrap">{{
        error.stack || error.message
      }}</pre>
    </template>
  </Alert>
  <slot v-else />
</template>
