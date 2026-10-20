<script lang="ts" setup>
import type { BoardWidget } from './board-utils';

import { useVbenDrawer, useVbenModal } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { $t } from '#/locales';

import BoardToolbar from './board-toolbar.vue';
import { IOT_BOARD_MAX_WIDGETS } from './board-utils';
import BoardWidgetForm from './board-widget-form.vue';
import BoardWidgetGrid from './board-widget-grid.vue';
import { useBoardDnd } from './use-board-dnd';
import { useBoardLoad } from './use-board-load';
import { useBoardRuntime } from './use-board-runtime';

/**
 * 组态看板抽屉（**内容组件**：自带 useVbenDrawer；入口在 `analytics/index.vue`）。
 *
 * 本文件只做**壳与装配**，三块职责已拆到同目录：
 * - `use-board-load.ts`：平台配置加载 / 本地草稿 / 保存与上传确认（持久化口径的唯一事实源）；
 * - `use-board-runtime.ts`：设备选项、每卡初始数据、实时 `latest` 合并与折线追加；
 * - `use-board-dnd.ts`：拖拽排序、上移下移、组件增删改（**唯一会改配置**的入口）；
 * - `board-toolbar.vue` / `board-widget-grid.vue`：工具栏与提示区 / 组件网格（纯展示）。
 *
 * 拆分的目的是让「持久化口径」与「实时口径」各自只在一个文件里，复核不必在 700 行里找。
 * 行为与拆分前逐行等价（`board.test.ts` 46 例是安全网，拆分前后均全绿）。
 */
defineOptions({ name: 'BoardDrawer' });

const [WidgetFormModal, widgetFormApi] = useVbenModal({
  connectedComponent: BoardWidgetForm,
});

const load = useBoardLoad();
const runtime = useBoardRuntime({ config: load.config });
const dnd = useBoardDnd({ config: load.config, load, runtime });

// 模板里直接用的 ref（保持同一引用，写回 `load.*` 亦生效）
const { config, configInvalid, isLocalDraft, saveError, saving, source } = load;
const {
  deviceById,
  deviceOptionsError,
  loading,
  realtimeError,
  realtimeState,
  realtimeTag,
  runtimeFor,
  seriesWarning,
} = runtime;

function openAdd(): void {
  if (config.value.widgets.length >= IOT_BOARD_MAX_WIDGETS) {
    message.warning(
      $t('page.iot.board.maxWidgets', [String(IOT_BOARD_MAX_WIDGETS)]),
    );
    return;
  }
  widgetFormApi.setData({ widget: undefined }).open();
}

function openEdit(widget: BoardWidget): void {
  widgetFormApi.setData({ widget }).open();
}

/**
 * 关闭提示用显式函数而不是模板里赋值 `configInvalid = false`：
 * `const { configInvalid } = load` 这种**解构出来的 ref** 编译器无法静态判定是 ref，
 * 模板内赋值是否被改写成 `.value = ` 依赖编译期推断，属于「测试覆盖不到就会静默失效」的坑。
 * 明写函数后赋值语义百分百确定。
 */
function closeConfigInvalid(): void {
  configInvalid.value = false;
}

function closeSaveError(): void {
  saveError.value = '';
}

function closeSeriesWarning(): void {
  seriesWarning.value = '';
}

/** 刷新 = 重新拉平台配置 + 重载所有组件数据（与拆分前同一顺序）。 */
async function refreshBoard(): Promise<void> {
  await load.loadBoard();
  await runtime.loadAll();
}

const [Drawer, drawerApi] = useVbenDrawer({
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      runtime.stopRealtime();
      return;
    }
    drawerApi.setState({ title: $t('page.iot.board.title') });
    await load.loadBoard();
    await runtime.loadAll();
    runtime.startRealtime();
  },
});

defineExpose({ drawerApi });
</script>

<template>
  <Drawer class="w-[96vw]">
    <div
      class="flex h-full flex-col gap-4 overflow-x-hidden overflow-y-auto p-4"
    >
      <BoardToolbar
        :config-invalid="configInvalid"
        :device-options-error="deviceOptionsError"
        :is-local-draft="isLocalDraft"
        :loading="loading"
        :realtime-error="realtimeError"
        :realtime-state="realtimeState"
        :realtime-tag="realtimeTag"
        :save-error="saveError"
        :saving="saving"
        :series-warning="seriesWarning"
        :source="source"
        :widget-count="config.widgets.length"
        @add="openAdd"
        @close-config-invalid="closeConfigInvalid"
        @close-save-error="closeSaveError"
        @close-series-warning="closeSeriesWarning"
        @refresh="refreshBoard"
        @save="load.pushBoard()"
      />

      <BoardWidgetGrid
        :device-by-id="deviceById"
        :runtime-for="runtimeFor"
        :widgets="config.widgets"
        @dragstart="dnd.onDragStart"
        @drop="dnd.onDrop"
        @edit="openEdit"
        @move-down="dnd.moveWidgetBy($event.id, 1)"
        @move-up="dnd.moveWidgetBy($event.id, -1)"
        @remove="dnd.removeWidget"
      />
    </div>

    <WidgetFormModal @success="dnd.onWidgetSaved" />
  </Drawer>
</template>
