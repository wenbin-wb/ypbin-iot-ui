<script lang="ts" setup>
import type {
  BoardConfig,
  BoardWidget,
  BoardWidgetRuntime,
} from './board-utils';

import type { IotDeviceApi } from '#/api/iot';
import type { IotRealtimeLatestPayload } from '#/api/iot/realtime';

import { computed, onBeforeUnmount, ref } from 'vue';

import { useVbenDrawer, useVbenModal } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import { Alert, Button, Empty, message, Tag } from 'ant-design-vue';

import { getDeviceLatest, getDeviceOptions } from '#/api/iot/device';
import { getDeviceSeries } from '#/api/iot/series';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { useIotRealtime } from '../../../iot/shared/use-iot-realtime';
import { niceGaugeMax } from './board-charts';
import {
  addBoardWidget,
  appendBoardPoint,
  boardLatestMatches,
  createBoardWidgetRuntime,
  createEmptyBoardConfig,
  IOT_BOARD_LINE_MAX_POINTS,
  IOT_BOARD_MAX_WIDGETS,
  loadBoardConfig,
  removeBoardWidget,
  saveBoardConfig,
  toBoardNumeric,
  updateBoardWidget,
} from './board-utils';
import BoardWidgetCard from './board-widget-card.vue';
import BoardWidgetForm from './board-widget-form.vue';

/**
 * 组态看板抽屉（**内容组件**：自带 useVbenDrawer；入口在 analytics/index.vue）。
 *
 * 只用既有能力：设备/点位/最新值/历史时序 + SSE `latest`；布局存 localStorage（带版本与
 * sanitize，脏数据重置为空并可见提示，绝不因坏配置白屏）。
 *
 * 实时口径：latest 事件设备 + 点位双匹配才更新对应组件；折线在内存尾部追加（上限 200），
 * 数值/仪表盘直接替换；断线只停更新，不把旧值清成空。
 */
defineOptions({ name: 'BoardDrawer' });

const [WidgetFormModal, widgetFormApi] = useVbenModal({
  connectedComponent: BoardWidgetForm,
});

/** 折线初始窗口：最近 24 小时（与「历史曲线」默认档一致）。 */
const IOT_BOARD_SERIES_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 未创建运行期的占位对象（避免模板里反复 new 触发子组件 watch）。 */
const EMPTY_RUNTIME = createBoardWidgetRuntime();

const config = ref<BoardConfig>(createEmptyBoardConfig());
const configInvalid = ref(false);
const storageError = ref('');
const loading = ref(false);
const deviceOptions = ref<IotDeviceApi.DeviceResp[]>([]);
const deviceOptionsError = ref('');
const runtime = ref<Record<string, BoardWidgetRuntime>>({});

const deviceById = computed(
  () => new Map(deviceOptions.value.map((item) => [String(item.id), item])),
);

const {
  error: realtimeError,
  onEvent,
  state: realtimeState,
} = useIotRealtime();

let unsubscribeLatest: (() => void) | undefined;

const realtimeTag = computed(() => {
  if (realtimeState.value === 'live') {
    return { color: 'success', text: $t('page.iot.board.realtime') };
  }
  if (realtimeState.value === 'reconnecting') {
    return {
      color: 'warning',
      text: $t('page.iot.board.realtimeReconnecting'),
    };
  }
  return { color: 'default', text: $t('page.iot.board.realtimeOff') };
});

function runtimeFor(widget: BoardWidget): BoardWidgetRuntime {
  return runtime.value[widget.id] ?? EMPTY_RUNTIME;
}

function patchRuntime(
  id: string,
  updater: (current: BoardWidgetRuntime) => BoardWidgetRuntime,
): void {
  const current = runtime.value[id] ?? createBoardWidgetRuntime();
  runtime.value = { ...runtime.value, [id]: updater(current) };
}

function persist(): void {
  storageError.value = saveBoardConfig(config.value)
    ? ''
    : $t('page.iot.board.saveFailed');
}

function startRealtime(): void {
  if (unsubscribeLatest !== undefined) {
    return;
  }
  unsubscribeLatest = onEvent('latest', onLatestEvent);
}

function stopRealtime(): void {
  unsubscribeLatest?.();
  unsubscribeLatest = undefined;
}

/** 实时事件：设备 + 点位双匹配才更新；折线尾部追加（ts 重复/非法忽略，不伪造点）。 */
function onLatestEvent(payload: IotRealtimeLatestPayload): void {
  const propertyId = String(payload.propertyId ?? '').trim();
  if (propertyId === '') {
    return;
  }
  const ts = Number(payload.ts);
  const value = payload.value ?? null;
  const quality = payload.quality ?? null;
  for (const widget of config.value.widgets) {
    if (!boardLatestMatches(widget, payload)) {
      continue;
    }
    const current = runtimeFor(widget);
    let next: BoardWidgetRuntime = {
      ...current,
      error: '',
      latest: {
        propertyId: widget.propertyId,
        quality,
        ts: Number.isFinite(ts) ? ts : undefined,
        value,
      },
      loaded: true,
      liveCount: current.liveCount + 1,
    };
    if (widget.type === 'line') {
      const outcome = appendBoardPoint(
        current.points,
        { quality, ts: payload.ts ?? null, value },
        IOT_BOARD_LINE_MAX_POINTS,
      );
      if (outcome.appended) {
        next = { ...next, points: outcome.points, seriesLoaded: true };
      }
    }
    if (widget.type === 'gauge') {
      next = {
        ...next,
        gaugeMax: Math.max(
          current.gaugeMax,
          niceGaugeMax(toBoardNumeric(value)),
        ),
      };
    }
    runtime.value = { ...runtime.value, [widget.id]: next };
  }
}

/** 单个组件的初始数据（最新值 + 折线历史）；失败原因进 runtime.error，卡片原样展示。 */
async function loadWidgetRuntime(
  widget: BoardWidget,
  latestCache: Map<string, Promise<IotDeviceApi.LatestValueResp[]>>,
): Promise<void> {
  try {
    let latestPromise = latestCache.get(widget.deviceId);
    if (!latestPromise) {
      latestPromise = getDeviceLatest(widget.deviceId);
      latestCache.set(widget.deviceId, latestPromise);
    }
    const latestList = (await latestPromise) ?? [];
    const found =
      latestList.find((item) => item.propertyId === widget.propertyId) ?? null;
    patchRuntime(widget.id, (current) => ({
      ...current,
      error: '',
      gaugeMax: Math.max(
        current.gaugeMax,
        niceGaugeMax(toBoardNumeric(found?.value ?? null)),
      ),
      latest: found,
      loaded: true,
    }));
    if (widget.type !== 'line') {
      patchRuntime(widget.id, (current) => ({
        ...current,
        seriesLoaded: true,
      }));
      return;
    }
    const now = Date.now();
    const points = await getDeviceSeries(widget.deviceId, {
      from: now - IOT_BOARD_SERIES_WINDOW_MS,
      limit: IOT_BOARD_LINE_MAX_POINTS,
      propertyId: widget.propertyId,
      to: now,
    });
    patchRuntime(widget.id, (current) => ({
      ...current,
      points: points ?? [],
      seriesLoaded: true,
    }));
  } catch (error) {
    patchRuntime(widget.id, (current) => ({
      ...current,
      error: extractErrorMessage(error, $t('page.iot.board.dataLoadFailed')),
      loaded: true,
      seriesLoaded: true,
    }));
  }
}

/** 重载看板：设备选项（展示增强，失败不阻塞）+ 每个组件的初始数据。 */
async function loadAll(): Promise<void> {
  loading.value = true;
  deviceOptionsError.value = '';
  const widgets = config.value.widgets;
  const fresh: Record<string, BoardWidgetRuntime> = {};
  for (const widget of widgets) {
    fresh[widget.id] = createBoardWidgetRuntime();
  }
  runtime.value = fresh;
  try {
    deviceOptions.value = (await getDeviceOptions()) ?? [];
  } catch (error) {
    deviceOptions.value = [];
    deviceOptionsError.value = extractErrorMessage(
      error,
      $t('page.iot.board.devicesLoadFailed'),
    );
  }
  const latestCache = new Map<
    string,
    Promise<IotDeviceApi.LatestValueResp[]>
  >();
  await Promise.all(
    widgets.map((widget) => loadWidgetRuntime(widget, latestCache)),
  );
  loading.value = false;
}

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

/** 新增/编辑提交：写回配置 + 持久化 + 只加载这一个组件的数据（不整板重查）。 */
async function onWidgetSaved(widget: BoardWidget): Promise<void> {
  const exists = config.value.widgets.some((item) => item.id === widget.id);
  config.value = exists
    ? updateBoardWidget(config.value, widget.id, widget)
    : addBoardWidget(config.value, widget);
  persist();
  const saved = exists
    ? config.value.widgets.find((item) => item.id === widget.id)
    : config.value.widgets.at(-1);
  if (!saved) {
    return;
  }
  patchRuntime(saved.id, () => createBoardWidgetRuntime());
  await loadWidgetRuntime(saved, new Map());
}

function removeWidget(widget: BoardWidget): void {
  config.value = removeBoardWidget(config.value, widget.id);
  runtime.value = Object.fromEntries(
    Object.entries(runtime.value).filter(([id]) => id !== widget.id),
  );
  persist();
}

const [Drawer, drawerApi] = useVbenDrawer({
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      stopRealtime();
      return;
    }
    drawerApi.setState({ title: $t('page.iot.board.title') });
    const loaded = loadBoardConfig();
    config.value = loaded.config;
    configInvalid.value = loaded.reset;
    await loadAll();
    startRealtime();
  },
});

onBeforeUnmount(() => {
  stopRealtime();
});

defineExpose({ drawerApi });
</script>

<template>
  <Drawer class="w-[96vw]">
    <div class="flex h-full flex-col gap-4 overflow-auto p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm text-muted-foreground">
          {{ $t('page.iot.board.desc') }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <Tag :color="realtimeTag.color">{{ realtimeTag.text }}</Tag>
          <Button :loading="loading" size="small" @click="loadAll">
            {{ $t('page.iot.board.refresh') }}
          </Button>
          <Button type="primary" @click="openAdd">
            <Plus class="size-4" />
            {{ $t('page.iot.board.addWidget') }}
          </Button>
        </div>
      </div>

      <!-- 坏配置被重置：必须让用户知道旧布局为什么没了 -->
      <Alert
        v-if="configInvalid"
        closable
        show-icon
        type="warning"
        :message="$t('page.iot.board.configInvalid')"
        @close="configInvalid = false"
      />
      <Alert
        v-if="storageError"
        closable
        show-icon
        type="warning"
        :message="storageError"
        @close="storageError = ''"
      />
      <Alert
        v-if="deviceOptionsError"
        show-icon
        type="warning"
        :message="deviceOptionsError"
      />
      <!-- 断线必须可见：Tag 变黄 + 原因 Alert，不得让看板静止而用户以为设备没上报 -->
      <Alert
        v-if="realtimeState === 'reconnecting'"
        show-icon
        type="warning"
        :description="realtimeError || undefined"
        :message="$t('page.iot.board.realtimeReconnectingDesc')"
      />

      <Empty
        v-if="config.widgets.length === 0"
        :description="$t('page.iot.board.empty')"
      />
      <div
        v-else
        class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
      >
        <BoardWidgetCard
          v-for="widget in config.widgets"
          :key="widget.id"
          :device="deviceById.get(widget.deviceId)"
          :runtime="runtimeFor(widget)"
          :widget="widget"
          @edit="openEdit(widget)"
          @remove="removeWidget(widget)"
        />
      </div>
    </div>

    <WidgetFormModal @success="onWidgetSaved" />
  </Drawer>
</template>
