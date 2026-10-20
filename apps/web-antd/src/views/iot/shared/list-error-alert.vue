<script lang="ts" setup>
import { Alert, Button } from 'ant-design-vue';

/**
 * IoT 列表页 / 数据区块「加载失败」的**统一呈现**。
 *
 * 背景：vxe 的 `#empty` 槽分不清「加载失败」与「确实没有数据」，
 * 各列表页此前各自复制一份「listError + 表格外 Alert + empty 槽判空」的骨架。
 * 抽成组件后统一四件事：
 *   ① 失败提示**挂在表格之外**（已有数据后刷新失败时也可见）；
 *   ② 失败原因**原样展示后端 message**，不吞、不猜；
 *   ③ 标题文案由调用方传入（各页用各自的 i18n 标题）；
 *   ④ **可选重试动作**（`retry-text` + `@retry`）：失败后用户必须有一个「再试一次」的出口，
 *      而不是只能刷新整页。不传 `retry-text` 时与旧行为完全一致（其余页面零改动）。
 */
withDefaults(
  defineProps<{
    /** 是否允许用户关闭（辅助信息用 true，列表失败不要给用户「关掉就没事了」的错觉）。 */
    closable?: boolean;
    /** 失败原因（后端 message 或页面兜底文案）；为空时不渲染。 */
    error?: string;
    /**
     * 重试按钮文案（如 `page.dashboard.retry`）。
     * 传了就渲染按钮；不传不渲染 —— 保持向后兼容。
     */
    retryText?: string;
    /** 失败标题（各页自己的 i18n 文案）。 */
    title: string;
    /** 提示类型：列表失败用 error；辅助信息失败用 warning。 */
    type?: 'error' | 'warning';
  }>(),
  {
    closable: false,
    error: '',
    retryText: '',
    type: 'error',
  },
);

/** 两个事件同签名，合并成一条（否则 oxlint 的 unified-signatures 会报）。 */
const emit = defineEmits<{ (e: 'close' | 'retry'): void }>();
</script>

<template>
  <Alert
    v-if="error"
    class="mb-2"
    :closable="closable"
    :description="error"
    :message="title"
    show-icon
    :type="type"
    @close="emit('close')"
  >
    <template v-if="retryText" #action>
      <Button size="small" @click="emit('retry')">{{ retryText }}</Button>
    </template>
  </Alert>
</template>
