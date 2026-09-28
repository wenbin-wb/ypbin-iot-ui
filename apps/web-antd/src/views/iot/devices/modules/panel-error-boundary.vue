<script lang="ts" setup>
import { getCurrentInstance, onErrorCaptured, ref } from 'vue';

import { Alert } from 'ant-design-vue';

import { $t } from '#/locales';

/**
 * 渲染错误边界（用于「在线调试」与「告警」两个页签）。
 *
 * <p>扩展说明（设计 §2.5.4 的要求）：原实现只服务「在线调试」，Alert 标题**硬编码**为在线调试文案。
 * 告警页签复用它之后，标题由 {@code titleKey} prop 指定（默认仍是 `page.iot.debug.renderFailed`），
 * 因此告警页签渲染异常时看到的是「告警页渲染失败」而不是张冠李戴的「在线调试页渲染失败」。</p>
 *
 * 为什么必须有这一层：2026-09-27 线上事故的形态是「点开在线调试页签整块空白」——
 * 根因是 i18n 文案里写了字面 `{` `}`（vue-i18n 的消息编译器把 `{"a":1}` 当成非法占位符，
 * `$t(...)` 直接抛 `SyntaxError`）。**渲染函数里抛异常 ⇒ 整棵子树渲染不出来 ⇒ 空白**，
 * 而且 typecheck / 构建 / 键存在性门禁全绿（`$t` 是运行期才编译消息的）。
 *
 * 本组件把「页签内容区内任何后代组件的 setup/render 异常」截住并**用 Alert 原样展示**：
 * 既不静默吞掉（技术规范禁止），也不让它把整个抽屉画成空白。
 *
 * 🔴 **两条必须同时成立，缺一不可**（第一版只顾了前者，被独立复核判出观测性回退）：
 *
 * 1. **异常必须继续进入全局上报通道** `app.config.errorHandler`（本平台由 `@vben/tracking`
 *    在 `packages/tracking/src/collectors.ts` 接管，打点 `web.error.js`）——2026-09-27 这次
 *    空白事故就是靠 `sys_track_event` 里那条 `SyntaxError` 定位的；`window 'error'` 抓不到它
 *    （Vue 已把渲染异常 try/catch 住）。
 * 2. **Alert 必须确定性渲染出来**。若这里 `return false`，Vue 的 `handleError` 会直接 return
 *    （全局 handler 被跳过）；若不返回 false 而工程里又没有全局 handler，dev 构建下 Vue 会
 *    **重新抛出**该异常，边界这次重渲染就完不成 ⇒ 依然空白。
 *
 * 所以取「显式转交 + 自己兜住」：手动调用全局 handler（等价于 Vue 原本会做的那一步），
 * 然后 `return false` 阻止二次传播与 dev 期重抛。
 *
 * @author wenbin
 * @since 2026-09-27
 */
const props = withDefaults(defineProps<{ titleKey?: string }>(), {
  titleKey: 'page.iot.debug.renderFailed',
});

const error = ref<Error>();

const currentInstance = getCurrentInstance();

onErrorCaptured((err, instance, info) => {
  error.value = err as Error;

  const globalHandler = currentInstance?.appContext.app.config.errorHandler;
  if (globalHandler) {
    try {
      globalHandler(err, instance, `panel-error-boundary:${String(info)}`);
    } catch (handlerError) {
      // 上报通道自己抛错时不得连累页面：这里必须留痕（不静默吞），但页面继续渲染 Alert
      console.error('[iot] 全局错误处理器上报失败（页面仍展示错误边界）', handlerError);
    }
  } else {
    // 没有全局 handler（如未配置埋点通道）时不能装作没发生：留一条控制台记录
    console.error(`[iot] ${props.titleKey} 捕获到未上报的渲染期异常`, err);
  }

  return false;
});
</script>

<template>
  <Alert
    v-if="error"
    :message="$t(props.titleKey)"
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
