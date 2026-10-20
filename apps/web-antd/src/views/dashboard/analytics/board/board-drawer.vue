<script lang="ts" setup>
import type {
  BoardConfig,
  BoardConfigSource,
  BoardWidget,
  BoardWidgetRuntime,
} from './board-utils';

import type { IotDeviceApi, IotSeriesApi } from '#/api/iot';
import type { IotRealtimeLatestPayload } from '#/api/iot/realtime';

import { computed, onBeforeUnmount, ref } from 'vue';

import { useVbenDrawer, useVbenModal } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import {
  Alert,
  Button,
  Empty,
  message,
  Modal,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import { getDashboardBoard, saveDashboardBoard } from '#/api/iot/board';
import { getDeviceLatest, getDeviceOptions } from '#/api/iot/device';
import { getDeviceSeries } from '#/api/iot/series';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { useIotRealtime } from '../../../iot/shared/use-iot-realtime';
import { niceGaugeMax } from './board-charts';
import {
  addBoardWidget,
  appendBoardPoint,
  boardLatestMatchesWidget,
  boardWidgetPropertyIds,
  createBoardWidgetRuntime,
  createEmptyBoardConfig,
  IOT_BOARD_LINE_MAX_POINTS,
  IOT_BOARD_MAX_WIDGETS,
  loadBoardConfig,
  moveBoardWidget,
  moveWidget,
  planBoardLoad,
  removeBoardWidget,
  resolveBoardWindowMs,
  sanitizeBoardWidgetList,
  saveBoardConfig,
  toBoardNumeric,
  toBoardPayloadWidget,
  updateBoardWidget,
} from './board-utils';
import BoardWidgetCard from './board-widget-card.vue';
import BoardWidgetForm from './board-widget-form.vue';

/**
 * 组态看板抽屉（**内容组件**：自带 useVbenDrawer；入口在 analytics/index.vue）。
 *
 * 持久化口径（2026-10-15 起接后端，见 api/iot/board.ts）：
 * - **加载**：先 GET 平台配置；GET 失败或平台无配置时回落本地草稿，并在 UI 上如实标注
 *   「当前为本地草稿（未同步到平台）」，绝不静默降级；平台空数组 = 无配置，不是配置损坏；
 * - **保存**：PUT 成功后写 localStorage（dirty=false）；PUT 失败**保留本地草稿**并置 dirty=true，
 *   明确提示「本次改动只在本机，未同步到平台」；
 * - **上传确认**：首次 GET 到平台为空且本地有草稿 ⇒ 弹出「检测到本地草稿，是否上传到平台？」，
 *   用户确认才 PUT，取消则继续以本地草稿运行。
 *
 * 实时口径：latest 事件设备 + 点位（多点位组件按点位集合）匹配才更新对应组件；折线在内存尾部
 * 追加（上限 200）；断线只停更新，不把旧值清成空。
 */
defineOptions({ name: 'BoardDrawer' });

const [WidgetFormModal, widgetFormApi] = useVbenModal({
  connectedComponent: BoardWidgetForm,
});

/** 未创建运行期的占位对象（避免模板里反复 new 触发子组件 watch）。 */
const EMPTY_RUNTIME = createBoardWidgetRuntime();

const config = ref<BoardConfig>(createEmptyBoardConfig());
const configInvalid = ref(false);
const saveError = ref('');
const source = ref<BoardConfigSource>('empty');
const loading = ref(false);
const saving = ref(false);
const deviceOptions = ref<IotDeviceApi.DeviceResp[]>([]);
const deviceOptionsError = ref('');
const runtime = ref<Record<string, BoardWidgetRuntime>>({});
const dragIndex = ref<null | number>(null);

const deviceById = computed(
  () => new Map(deviceOptions.value.map((item) => [String(item.id), item])),
);

const {
  error: realtimeError,
  onEvent,
  state: realtimeState,
} = useIotRealtime();

let unsubscribeLatest: (() => void) | undefined;

/** 是否展示「当前为本地草稿（未同步到平台）」提示。 */
const isLocalDraft = computed(() => source.value === 'local-draft');

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

function persistLocal(dirty: boolean): void {
  const saved = saveBoardConfig(config.value, undefined, dirty);
  saveError.value = saved ? '' : $t('page.iot.board.saveFailed');
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

/** 实时事件：设备 + 点位集合匹配才更新；折线尾部追加（ts 重复/非法忽略，不伪造点）。 */
function onLatestEvent(payload: IotRealtimeLatestPayload): void {
  const propertyId = String(payload.propertyId ?? '').trim();
  if (propertyId === '') {
    return;
  }
  const ts = Number(payload.ts);
  const value = payload.value ?? null;
  const quality = payload.quality ?? null;
  for (const widget of config.value.widgets) {
    if (!boardLatestMatchesWidget(widget, payload)) {
      continue;
    }
    const current = runtimeFor(widget);
    let next: BoardWidgetRuntime = {
      ...current,
      error: '',
      latest: {
        propertyId,
        quality,
        ts: Number.isFinite(ts) ? ts : undefined,
        value,
      },
      latestList: mergeLatestValue(current.latestList, {
        propertyId,
        quality,
        ts: Number.isFinite(ts) ? ts : undefined,
        value,
      }),
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
    if (widget.type === 'multi-line') {
      next = {
        ...next,
        multiSeries: appendMultiSeriesPoint(current.multiSeries, propertyId, {
          quality,
          ts: payload.ts ?? null,
          value,
        }),
        seriesLoaded: true,
      };
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

/** 整设备最新值快照里替换/追加某点位（表格卡与开关卡共用）。 */
function mergeLatestValue(
  list: IotDeviceApi.LatestValueResp[],
  item: IotDeviceApi.LatestValueResp,
): IotDeviceApi.LatestValueResp[] {
  const index = list.findIndex((row) => row.propertyId === item.propertyId);
  if (index === -1) {
    return [...list, item];
  }
  return list.map((row, current) => (current === index ? item : row));
}

/** 多序列折线的实时追加：按点位找到对应序列，找不到时忽略（配置与点位对不上）。 */
function appendMultiSeriesPoint(
  series: BoardWidgetRuntime['multiSeries'],
  propertyId: string,
  point: {
    quality: null | string;
    ts: null | number | string;
    value: null | string;
  },
) {
  let matched = false;
  const next = series.map((item) => {
    if (item.propertyId !== propertyId) {
      return item;
    }
    const outcome = appendBoardPoint(
      item.points,
      point,
      IOT_BOARD_LINE_MAX_POINTS,
    );
    if (!outcome.appended) {
      return item;
    }
    matched = true;
    return { ...item, points: outcome.points };
  });
  return matched ? next : series;
}

/** 单个组件的初始数据（最新值 + 历史序列）；失败原因进 runtime.error，卡片原样展示。 */
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
    const properties = boardWidgetPropertyIds(widget);
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
      latestList,
      loaded: true,
    }));
    if (widget.type !== 'line' && widget.type !== 'multi-line') {
      patchRuntime(widget.id, (current) => ({
        ...current,
        seriesLoaded: true,
      }));
      return;
    }
    const points = await loadSeries(
      widget.deviceId,
      properties,
      resolveBoardWindowMs(widget),
    );
    if (widget.type === 'line') {
      patchRuntime(widget.id, (current) => ({
        ...current,
        points: points.get(properties[0] ?? '') ?? [],
        seriesLoaded: true,
      }));
      return;
    }
    patchRuntime(widget.id, (current) => ({
      ...current,
      multiSeries: properties.map((propertyId) => ({
        points: points.get(propertyId) ?? [],
        propertyId,
      })),
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

/** 拉多个点位的历史：单个点位失败**不连坐**，该序列留空并带上原因到 runtime.error。 */
async function loadSeries(
  deviceId: string,
  properties: string[],
  windowMs: number,
): Promise<Map<string, IotSeriesApi.TimeSeriesPointResp[]>> {
  const now = Date.now();
  const result = new Map<string, IotSeriesApi.TimeSeriesPointResp[]>();
  const settled = await Promise.allSettled(
    properties.map(async (propertyId) => {
      const points = await getDeviceSeries(deviceId, {
        from: now - windowMs,
        limit: IOT_BOARD_LINE_MAX_POINTS,
        propertyId,
        to: now,
      });
      return { points: points ?? [], propertyId };
    }),
  );
  let firstError = '';
  for (const item of settled) {
    if (item.status === 'fulfilled') {
      result.set(item.value.propertyId, item.value.points);
    } else if (firstError === '') {
      firstError = extractErrorMessage(
        item.reason,
        $t('page.iot.board.dataLoadFailed'),
      );
    }
  }
  if (firstError !== '' && result.size === 0) {
    throw new Error(firstError);
  }
  if (firstError !== '') {
    // 部分序列失败：不静默——在抽屉顶部给出原因（成功序列照常画）
    seriesWarning.value = $t('page.iot.board.seriesPartialFailed', [
      firstError,
    ]);
  }
  return result;
}

const seriesWarning = ref('');

/** 重载看板：设备选项（展示增强，失败不阻塞）+ 每个组件的初始数据。 */
async function loadAll(): Promise<void> {
  loading.value = true;
  deviceOptionsError.value = '';
  seriesWarning.value = '';
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

/**
 * 拉平台配置并决策展示哪一份（纯函数 planBoardLoad）；失败/无配置回落本地草稿并标注。
 */
async function loadBoard(): Promise<void> {
  const local = loadBoardConfig();
  configInvalid.value = local.reset;
  let remote: { error?: string; ok: boolean; widgets?: BoardWidget[] };
  try {
    const resp = await getDashboardBoard();
    remote = { ok: true, widgets: sanitizeBoardWidgetList(resp?.widgets) };
  } catch (error) {
    remote = {
      error: extractErrorMessage(error, $t('page.iot.board.loadFailed')),
      ok: false,
    };
  }
  const plan = planBoardLoad(remote, local);
  config.value = plan.config;
  source.value = plan.source;
  saveError.value = plan.remoteError;
  if (plan.localDraftAvailable) {
    confirmUploadLocalDraft();
    return;
  }
  // 平台为准时把平台配置写回本地（下次断网也能看）
  if (plan.source === 'platform') {
    persistLocal(false);
  }
}

/** 首次 GET 到平台为空且本地有草稿：显式询问，用户确认才上传。 */
function confirmUploadLocalDraft(): void {
  Modal.confirm({
    content: $t('page.iot.board.uploadDraftConfirm'),
    okText: $t('page.iot.board.uploadDraftOk'),
    cancelText: $t('page.iot.board.uploadDraftCancel'),
    title: $t('page.iot.board.uploadDraftTitle'),
    onCancel: () => {
      source.value = 'local-draft';
    },
    onOk: async () => {
      await pushBoard({ silent: true });
    },
  });
}

/**
 * 把当前配置整体 PUT 到平台。
 *
 * 成功：写 localStorage 且 dirty=false，source 变 platform；
 * 失败：**保留本地草稿**（dirty=true）并明确提示，绝不假装保存成功。
 */
async function pushBoard(options: { silent?: boolean } = {}): Promise<boolean> {
  if (saving.value) {
    return false;
  }
  saving.value = true;
  try {
    await saveDashboardBoard(
      config.value.widgets.map((widget) => toBoardPayloadWidget(widget)),
    );
    persistLocal(false);
    source.value = 'platform';
    saveError.value = '';
    if (!options.silent) {
      message.success($t('page.iot.board.saveSuccess'));
    }
    return true;
  } catch (error) {
    const reason = extractErrorMessage(error, $t('page.iot.board.saveFailed'));
    persistLocal(true);
    source.value = 'local-draft';
    saveError.value = $t('page.iot.board.saveFailedDetail', [reason]);
    if (!options.silent) {
      message.error(saveError.value);
    }
    return false;
  } finally {
    saving.value = false;
  }
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
  await pushBoard();
  const saved = exists
    ? config.value.widgets.find((item) => item.id === widget.id)
    : config.value.widgets.at(-1);
  if (!saved) {
    return;
  }
  patchRuntime(saved.id, () => createBoardWidgetRuntime());
  await loadWidgetRuntime(saved, new Map());
}

async function removeWidget(widget: BoardWidget): Promise<void> {
  config.value = removeBoardWidget(config.value, widget.id);
  runtime.value = Object.fromEntries(
    Object.entries(runtime.value).filter(([id]) => id !== widget.id),
  );
  await pushBoard();
}

/** 重排后统一落库：本地立即生效，随后 PUT 平台（失败保留本地草稿并提示）。 */
async function applyWidgets(widgets: BoardWidget[]): Promise<void> {
  config.value = { version: config.value.version, widgets };
  await pushBoard();
}

/** 拖拽：dragstart 记录源下标，drop 在目标卡片上完成插入式重排。 */
function onDragStart(index: number): void {
  dragIndex.value = index;
}

async function onDrop(index: number): Promise<void> {
  const from = dragIndex.value;
  dragIndex.value = null;
  if (from === null) {
    return;
  }
  const next = moveWidget(config.value.widgets, from, index);
  if (next === config.value.widgets) {
    return;
  }
  await applyWidgets(next);
}

/** 上移/下移按钮（键盘/触屏兜底）：与拖拽共用 moveWidget 规则。 */
async function moveWidgetBy(id: string, offset: number): Promise<void> {
  const moved = moveBoardWidget(config.value, id, offset);
  if (moved === config.value) {
    return;
  }
  await applyWidgets(moved.widgets);
}

const [Drawer, drawerApi] = useVbenDrawer({
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      stopRealtime();
      return;
    }
    drawerApi.setState({ title: $t('page.iot.board.title') });
    await loadBoard();
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
    <div
      class="flex h-full flex-col gap-4 overflow-x-hidden overflow-y-auto p-4"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm text-muted-foreground">
          {{ $t('page.iot.board.desc') }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <Tag :color="realtimeTag.color">{{ realtimeTag.text }}</Tag>
          <Tag v-if="source === 'platform'" color="success">
            {{ $t('page.iot.board.sourcePlatform') }}
          </Tag>
          <Tag v-else-if="isLocalDraft" color="warning">
            {{ $t('page.iot.board.sourceLocalDraft') }}
          </Tag>
          <Button
            :loading="loading"
            size="small"
            @click="loadBoard().then(loadAll)"
          >
            {{ $t('page.iot.board.refresh') }}
          </Button>
          <!--
            空看板时「保存到平台」禁用：必须说明原因，否则用户会误以为是权限或网络问题。
            禁用按钮不触发 mouseenter，故用外层 span 承接 Tooltip。
          -->
          <Tooltip
            :title="
              config.widgets.length === 0
                ? $t('page.iot.board.empty')
                : $t('page.iot.board.saveToPlatform')
            "
          >
            <span class="inline-flex">
              <Button
                :loading="saving"
                :disabled="config.widgets.length === 0"
                @click="pushBoard()"
              >
                {{ $t('page.iot.board.saveToPlatform') }}
              </Button>
            </span>
          </Tooltip>
          <Button type="primary" @click="openAdd">
            <Plus class="size-4" />
            {{ $t('page.iot.board.addWidget') }}
          </Button>
        </div>
      </div>

      <!-- 本地草稿（未同步到平台）：必须如实标注，不让用户以为已经共享 -->
      <Alert
        v-if="isLocalDraft"
        show-icon
        type="warning"
        :message="$t('page.iot.board.localDraftNotice')"
      />
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
        v-if="saveError"
        closable
        show-icon
        type="warning"
        :message="saveError"
        @close="saveError = ''"
      />
      <Alert
        v-if="deviceOptionsError"
        show-icon
        type="warning"
        :message="deviceOptionsError"
      />
      <Alert
        v-if="seriesWarning"
        closable
        show-icon
        type="warning"
        :message="seriesWarning"
        @close="seriesWarning = ''"
      />
      <!-- 断线必须可见：Tag 变黄 + 原因 Alert，不得让看板静止而用户以为设备没上报 -->
      <Alert
        v-if="realtimeState === 'reconnecting'"
        show-icon
        type="warning"
        :description="realtimeError || undefined"
        :message="$t('page.iot.board.realtimeReconnectingDesc')"
      />

      <p v-if="config.widgets.length > 1" class="text-xs text-muted-foreground">
        {{ $t('page.iot.board.reorderHint') }}
      </p>

      <Empty
        v-if="config.widgets.length === 0"
        :description="$t('page.iot.board.empty')"
      />
      <div
        v-else
        class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
      >
        <BoardWidgetCard
          v-for="(widget, index) in config.widgets"
          :key="widget.id"
          :device="deviceById.get(widget.deviceId)"
          :index="index"
          :runtime="runtimeFor(widget)"
          :total="config.widgets.length"
          :widget="widget"
          @dragstart="onDragStart"
          @drop="onDrop"
          @edit="openEdit(widget)"
          @move-down="moveWidgetBy(widget.id, 1)"
          @move-up="moveWidgetBy(widget.id, -1)"
          @remove="removeWidget(widget)"
        />
      </div>
    </div>

    <WidgetFormModal @success="onWidgetSaved" />
  </Drawer>
</template>
