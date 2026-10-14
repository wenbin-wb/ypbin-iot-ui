<script lang="ts" setup>
import { Alert } from 'ant-design-vue';

/**
 * IoT 列表页「加载失败」的**统一呈现**。
 *
 * 背景：vxe 的 `#empty` 槽分不清「加载失败」与「确实没有数据」，
 * 各列表页此前各自复制一份「listError + 表格外 Alert + empty 槽判空」的骨架。
 * 抽成组件后统一三件事：
 *   ① 失败提示**挂在表格之外**（已有数据后刷新失败时也可见）；
 *   ② 失败原因**原样展示后端 message**，不吞、不猜；
 *   ③ 标题文案由调用方传入（各页用各自的 i18n 标题）。
 */
withDefaults(
  defineProps<{
    /** 是否允许用户关闭（辅助信息用 true，列表失败不要给用户「关掉就没事了」的错觉）。 */
    closable?: boolean;
    /** 失败原因（后端 message 或页面兜底文案）；为空时不渲染。 */
    error?: string;
    /** 失败标题（各页自己的 i18n 文案）。 */
    title: string;
    /** 提示类型：列表失败用 error；辅助信息失败用 warning。 */
    type?: 'error' | 'warning';
  }>(),
  {
    closable: false,
    error: '',
    type: 'error',
  },
);

const emit = defineEmits<{ (e: 'close'): void }>();
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
  />
</template>
