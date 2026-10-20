<script lang="ts" setup>
import type {
  BoardWidget,
  BoardWidgetRuntime,
} from './board-utils';

import type { IotDeviceApi } from '#/api/iot';

import { Empty } from 'ant-design-vue';

import { $t } from '#/locales';

import { createBoardWidgetRuntime } from './board-utils';
import BoardWidgetCard from './board-widget-card.vue';

withDefaults(
  defineProps<{
    /** 设备 id → 设备（名称回落用；缺失时卡片自己回落到 id）。 */
    deviceById?: Map<string, IotDeviceApi.DeviceResp>;
    /** 取某组件的运行期数据（未创建的组件由宿主返回空占位）。 */
    runtimeFor?: (widget: BoardWidget) => BoardWidgetRuntime;
    /** 当前看板组件列表（顺序即渲染顺序）。 */
    widgets?: BoardWidget[];
  }>(),
  {
    deviceById: () => new Map(),
    runtimeFor: undefined,
    widgets: () => [],
  },
);

/** 按载荷分组写成两条签名（同签名拆多条会被 oxlint 的 unified-signatures 判错）。 */
const emit = defineEmits<{
  (e: 'dragstart' | 'drop', index: number): void;
  (e: 'edit' | 'moveDown' | 'moveUp' | 'remove', widget: BoardWidget): void;
}>();

/**
 * 看板组件区（从 board-drawer.vue 抽出，纯展示：只 emit 交互，不改数据）。
 *
 * 口径（与抽出前一致）：
 * - 空看板给 `Empty` + 「添加组件」指引，不画一张空白网格；
 * - 组件多于 1 个时给出排序提示（拖拽 / 上移下移都能用）；
 * - 拖拽与上移/下移都只是 **emit**，由宿主的 `useBoardDnd` 统一决策并落库
 *   （排序规则只在一处实现，避免网格里再出现一套顺序逻辑）。
 *
 * `runtimeFor` 以函数形式传入而不是整份 `runtime` 对象：卡片渲染时调用它即可，
 * 依赖仍会被当前渲染副作用追踪到（`runtime` 变化照样触发重渲染），
 * 同时避免把「未创建运行期用哪个占位对象」的知识泄漏到展示层。
 */
/** 宿主未提供 `runtimeFor` 时的占位（与 board-drawer 抽出前的 `EMPTY_RUNTIME` 同口径）。 */
const EMPTY_RUNTIME = createBoardWidgetRuntime();

</script>

<template>
  <p v-if="widgets.length > 1" class="text-xs text-muted-foreground">
    {{ $t('page.iot.board.reorderHint') }}
  </p>

  <Empty v-if="widgets.length === 0" :description="$t('page.iot.board.empty')" />
  <div
    v-else
    class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
  >
    <BoardWidgetCard
      v-for="(widget, index) in widgets"
      :key="widget.id"
      :device="deviceById.get(widget.deviceId)"
      :index="index"
      :runtime="runtimeFor ? runtimeFor(widget) : EMPTY_RUNTIME"
      :total="widgets.length"
      :widget="widget"
      @dragstart="emit('dragstart', $event)"
      @drop="emit('drop', $event)"
      @edit="emit('edit', widget)"
      @move-down="emit('moveDown', widget)"
      @move-up="emit('moveUp', widget)"
      @remove="emit('remove', widget)"
    />
  </div>
</template>
