<script lang="ts" setup>
import type { CameraPresetId } from './modules/camera-presets';
import type { TwinKpiResult } from './modules/twin-kpi';

import type { IotTwinApi } from '#/api/iot';
import type { AnchorRuntimeState } from '#/three/twin/types';

import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Page } from '@vben/common-ui';
import { usePreferences } from '@vben/preferences';

import { Alert, Empty, Modal } from 'ant-design-vue';

import { getTwinPointList } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import ListErrorAlert from '../shared/list-error-alert.vue';
import { useTwinAlertCounts } from './composables/use-twin-alert-counts';
import { useTwinEditor } from './composables/use-twin-editor';
import { useTwinLiveValues } from './composables/use-twin-live-values';
import { useTwinRuntime } from './composables/use-twin-runtime';
import { useTwinScene } from './composables/use-twin-scene';
import { CAMERA_PRESET_IDS } from './modules/camera-presets';
import { buildDeviceDetailTarget } from './modules/device-detail-link';
import ModelPanel from './modules/model-panel.vue';
import PointPanel from './modules/point-panel.vue';
import RuntimeLegend from './modules/runtime-legend.vue';
import { computeSceneBadges } from './modules/scene-badges';
import SceneTree from './modules/scene-tree.vue';
import TwinCanvasHud from './modules/twin-canvas-hud.vue';
import TwinCanvas from './modules/twin-canvas.vue';
import { computeTwinKpi } from './modules/twin-kpi';
import TwinStatusBar from './modules/twin-status-bar.vue';

/**
 * 数字孪生页（宿主：只做编排 + 布局）。
 *
 * 布局三段式：左场景树 / 中 3D 画布 / 右点位与模型资产。
 *
 * ## 深链约定（与设备台账 `?deviceId=` 同口径）
 *
 * - 进入场景 ⇒ `router.replace({ query: { sceneId } })`（replace 不产生历史栈垃圾）；
 * - 带 `?sceneId=` 刷新/前进后退 ⇒ 自动进入对应场景；
 * - `sceneId` 不存在 ⇒ **仍然尝试加载**，由画布给出「场景不存在」错误态；
 *   不静默跳回根场景（用户会以为自己点错了）。
 *
 * ## 数据流
 *
 * 场景树 → 当前场景 → 点位（一次拉取）→ 运行态快照 → SSE 增量按帧合并
 * → 画布 `updateAnchorStates`。
 */
const route = useRoute();
const router = useRouter();

const {
  ancestryOf,
  canAddChild,
  depthOf,
  error: sceneError,
  findScene,
  load: loadScenes,
  loading: sceneLoading,
  parentOptions,
  scenes,
  tree,
} = useTwinScene();

const {
  cancelPlacing,
  dismissPlaceForm,
  draft: editorDraft,
  editingPointId,
  hasDraft,
  mode: editorMode,
  placeFormOpen,
  reset: resetEditor,
  selectPoint,
  setDraft,
  startPlacing,
} = useTwinEditor();

/** 画布组件引用（用于把运行态状态推给画布）。 */
const canvasRef = ref<InstanceType<typeof TwinCanvas> | null>(null);

/** 最近一次运行态（画布就绪后补推用）。 */
let latestAnchorStates: Map<string, AnchorRuntimeState> | null = null;

const runtime = useTwinRuntime({
  onFlush: (states: Map<string, AnchorRuntimeState>) => {
    // 存一份最新的：画布可能还没装配好（`canvasRef.value` 为 null），
    // 就绪后由 `onCanvasReady` 补推，否则首屏状态永久丢失 ⇒ 标签全空。
    latestAnchorStates = states;
    lastUpdateAt.value = Date.now();
    canvasRef.value?.updateAnchorStates(states);
  },
});

// 解构成独立 ref：模板里才能自动解包（`runtime.error.value` 在模板中不会解包）
const {
  authError: realtimeAuthError,
  error: runtimeError,
  realtimeError,
  realtimeState,
} = runtime;

/** 模型资产列表（由模型面板块加载后共享给画布）。 */
const assets = ref<IotTwinApi.ModelAssetResp[]>([]);

/** 当前场景 id（来自 URL）。 */
const currentSceneId = computed(() => {
  const value = route.query.sceneId;
  return typeof value === 'string' && value !== '' ? value : '';
});

/**
 * 当前选中点位 id（来自 URL `?pointId=`，工单 #127）。
 *
 * **URL 是唯一真相**（与 `?sceneId=` 同款）：选中态变化要写回 URL，
 * 这样「从设备详情点进来」「刷新页面」「分享链接」三种路径都能落到同一个点位。
 */
const currentPointId = computed(() => {
  const value = route.query.pointId;
  return typeof value === 'string' && value !== '' ? value : '';
});

/** 深链提示（点位在当前场景找不到时给用户一条可见说明，不静默忽略）。 */
const deeplinkNotice = ref('');

/** 当前场景（找不到时为 undefined，画布会给出错误态）。 */
const currentScene = computed(() => findScene(currentSceneId.value));

/**
 * 从根到当前场景的祖先链（含自身）。
 *
 * `broken=true` 表示父场景已被删除：链被截断，模型位置会与预期不符，
 * 必须在页面上明确提示（不静默渲染一个位置偏了的模型）。
 */
const ancestry = computed(() =>
  currentScene.value
    ? ancestryOf(currentScene.value.id)
    : { broken: false, chain: [] },
);

const points = ref<IotTwinApi.PointResp[]>([]);
const pointsLoading = ref(false);
const pointsError = ref('');

/**
 * 点位请求世代号（竞态守卫，工单 #132）。
 *
 * 快速连切场景时，先发后到的旧场景点位会覆盖新场景的点位 ⇒ 3D 锚点用旧场景的
 * **局部坐标**画在新场景的**模型**上（位置完全错乱，且用户看不出原因）。
 * `await` 回来后比对世代，过期即丢弃。
 */
let pointsGeneration = 0;

/** 点位 → 绑定（运行态快照据此决定主展示属性与单位/精度）。 */
const bindingsByPointId = computed(() => {
  const map = new Map<string, IotTwinApi.BindingResp[]>();
  for (const point of points.value) {
    map.set(point.id, point.bindings);
  }
  return map;
});

const canvasState = ref<string>('disposed');
const canvasError = ref('');
const fallbackReason = ref('');

/** 活动告警数（**单一数据源**：KPI 条 / 场景树角标 / 卡片 共用，避免三处三个数）。 */
const alertCounts = useTwinAlertCounts();

/** 卡片实时值域（**旁路**：全量原值、不节流、不驱动 3D 重绘）。 */
const liveValues = useTwinLiveValues({ alertCounts });

/** 渲染统计（底部状态栏）。 */
const renderStats = ref<{ geometries: number; textures: number }>();

/**
 * 引擎层场景概况（画布 HUD 的模型/动画/动效信息）。
 *
 * 由画布在模型加载完成后回调（`@scene-summary`），**不由页面主动轮询**：
 * 这些数字只在「模型变了」时才有意义，每帧刷新纯属浪费。
 */
const sceneSummary = ref<{
  animationCount: number;
  animationsRunning: boolean;
  modelBytes: number;
  motionMode: 'normal' | 'off' | 'reduced';
  orbiting: boolean;
  renderStats: { geometries: number; textures: number };
}>();

/**
 * 是否显示完整外壳（屋顶 + 全部墙体）。
 *
 * 默认剖切：演示场景的设备锚点在机柜内部，封闭厂房的屋顶会把它们全部挡住
 * （画面上只剩几个彩色圆点悬在白色屋面上）。开关只在模型**真的**有可隐藏节点时显示
 * —— 由画布探测后经 `shellSupported` 上报，避免做一个点了没反应的开关。
 */
const showShell = ref(false);
const shellSupported = ref(false);

/**
 * 当前主题是否为暗色（画布底色跟随应用主题）。
 *
 * 用 `usePreferences().isDark` 而不是 `matchMedia`：主题是**应用设置**（用户可在页面里
 * 手动切），系统偏好只在「跟随系统」时才生效；引擎侧同理由页面下发。
 */
const { isDark } = usePreferences();

/** 当前相机预设（按钮组高亮用；用户自由旋转后清空）。 */
const activeCameraPreset = ref<CameraPresetId | undefined>();

/**
 * 切到相机预设机位。
 *
 * @param presetId 预设 ID
 */
function applyCameraPreset(presetId: CameraPresetId): void {
  activeCameraPreset.value = presetId;
  canvasRef.value?.applyCameraPreset(presetId);
}

/**
 * 切换剖切/完整外观。
 *
 * @param show true = 显示屋顶与全部墙体
 */
function toggleShell(show: boolean): void {
  showShell.value = show;
  canvasRef.value?.setShellVisible(show);
}

/** 动效档位（引擎层判定后回调；未初始化时 undefined）。 */
const motionMode = ref<'normal' | 'off' | 'reduced'>();

/** 最近一次运行态提交时刻（底部状态栏的「N 秒前更新」）。 */
const lastUpdateAt = ref<number>();

/** 告警事件到达 ⇒ 共享域重拉一次（去抖在共享域内，见 use-twin-alert-counts）。 */
liveValues.onAlertReload(() => {
  void alertCounts.refresh();
});

/**
 * 画布上的告警/提示（**聚合成一个列表**渲染，模板里不再铺 6 段 Alert）。
 *
 * 只有真正需要用户注意的才进这个列表；空列表时左上角不留任何占位（避免常态占白）。
 */
const alerts = computed(() => {
  const list: Array<{
    close?: () => void;
    dismissible: boolean;
    message: string;
    type: 'error' | 'info' | 'warning';
  }> = [];
  if (fallbackReason.value) {
    list.push({
      dismissible: true,
      message: fallbackReason.value,
      type: 'info',
      close: () => {
        fallbackReason.value = '';
      },
    });
  }
  if (canvasError.value) {
    list.push({
      dismissible: false,
      message: canvasError.value,
      type: 'error',
    });
  }
  if (ancestry.value.broken) {
    list.push({
      dismissible: false,
      message: $t('page.iot.twin.ancestryBroken'),
      type: 'warning',
    });
  }
  if (runtimeError.value) {
    list.push({
      dismissible: true,
      message: runtimeError.value,
      type: 'error',
      close: () => {
        runtimeError.value = '';
      },
    });
  }
  if (realtimeError.value || realtimeAuthError.value) {
    list.push({
      dismissible: false,
      message: realtimeAuthError.value
        ? $t('page.iot.twin.realtimeAuthFailed')
        : $t('page.iot.twin.realtimeDisconnected'),
      type: 'warning',
    });
  }
  if (deeplinkNotice.value) {
    list.push({
      dismissible: true,
      message: deeplinkNotice.value,
      type: 'info',
      close: () => {
        deeplinkNotice.value = '';
      },
    });
  }
  return list;
});

/** 顶部 KPI（全部来自已有数据，不新增接口）。 */
const kpi = computed<TwinKpiResult>(() =>
  computeTwinKpi({
    assetCount: assets.value.length,
    points: points.value,
    runtimePoints: runtime.snapshot.value?.points ?? [],
    scenes: scenes.value,
    sharedAlertCounts: alertCounts.counts.value,
    truncated: runtime.snapshot.value?.truncated ?? false,
  }),
);

/** 场景树角标。 */
const sceneBadges = computed(() =>
  computeSceneBadges({
    currentPoints: points.value,
    currentRuntimePoints: runtime.snapshot.value?.points ?? [],
    currentSceneId: currentSceneId.value,
    sharedAlertCounts: alertCounts.counts.value,
    scenes: scenes.value,
  }),
);

/**
 * 钉住态变化（用户点锚点 / 关闭卡片）⇒ 同步 URL 与选中态。
 *
 * URL 是唯一真相：写回 `?pointId=` 后，`currentPointId` 的 watch 会同步到画布，
 * 因此这里是**单向**（用户操作 → URL），画布内部不再反向驱动 URL，避免环。
 *
 * @param pointId 点位 ID（undefined = 取消钉住）
 */
async function onCardPinChange(pointId?: string): Promise<void> {
  if (pointId) {
    selectPoint(pointId);
    if (currentPointId.value !== pointId) {
      await router.replace({ query: { ...route.query, pointId } });
    }
    return;
  }
  if (currentPointId.value) {
    selectPoint(null);
    await router.replace({ query: { ...route.query, pointId: undefined } });
  }
}

/**
 * 进入某场景（只写 URL；数据加载由 watch 统一处理）。
 *
 * @param sceneId 场景 id
 */
async function enterScene(sceneId: string): Promise<void> {
  if (sceneId === currentSceneId.value) {
    return;
  }
  // 未保存草稿确认（#129）：`useTwinEditor` 的注释承诺过「切场景会提示」，
  // 但此前没有实现——用户切走后草稿静默丢失，坐标白配。
  if (hasDraft.value) {
    const confirmed = await confirmDiscardDraft();
    if (!confirmed) {
      return;
    }
  }
  await router.replace({ query: { ...route.query, sceneId } });
}

/**
 * 确认是否丢弃未保存的点位草稿。
 *
 * @returns 用户是否确认继续（true = 丢弃并继续切换）
 */
function confirmDiscardDraft(): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      centered: true,
      content: $t('page.iot.twin.unsavedDraftConfirm'),
      okText: $t('page.iot.twin.discardAndSwitch'),
      cancelText: $t('common.cancel'),
      onCancel: () => resolve(false),
      onOk: () => resolve(true),
      title: $t('page.iot.twin.unsavedDraftTitle'),
    });
  });
}

/** 返回上级场景（面包屑）。 */
async function goParent(): Promise<void> {
  const parent = ancestry.value.chain.at(-2);
  if (parent) {
    await enterScene(parent.id);
  }
}

/**
 * 加载当前场景的点位。
 *
 * @param sceneId 场景 id
 */
async function loadPoints(sceneId: string): Promise<void> {
  if (!sceneId) {
    points.value = [];
    pointsError.value = '';
    return;
  }
  const generation = ++pointsGeneration;
  pointsLoading.value = true;
  try {
    const data = await getTwinPointList(sceneId);
    // 过期响应：已切到别的场景 ⇒ 丢弃（否则旧场景坐标会画到新模型上）
    if (generation !== pointsGeneration) {
      return;
    }
    points.value = data;
    pointsError.value = '';
    // 深链校验（工单 #127）：URL 指名的点位若不在本场景，给出可见提示并回落场景级。
    // 不静默忽略——否则用户会以为「链接坏了」而不知道为什么。
    if (currentPointId.value) {
      const exists = data.some((item) => item.id === currentPointId.value);
      if (exists) {
        selectPoint(currentPointId.value);
        deeplinkNotice.value = '';
      } else {
        deeplinkNotice.value = $t('page.iot.twin.pointNotFoundInScene');
        // 清掉失效的 pointId，避免 URL 长期带着一个不存在的点位
        await router.replace({ query: { ...route.query, pointId: undefined } });
        selectPoint(null);
      }
    }
  } catch (loadError) {
    if (generation !== pointsGeneration) {
      return;
    }
    pointsError.value = extractErrorMessage(
      loadError,
      $t('page.iot.twin.pointLoadFailed'),
    );
  } finally {
    if (generation === pointsGeneration) {
      pointsLoading.value = false;
    }
  }
}

/** 当前场景切换 ⇒ 拉点位 + 拉运行态快照。 */
watch(
  currentSceneId,
  async (sceneId) => {
    // 切场景要丢掉放置态与草稿：它们属于上一个场景的坐标系，跨场景保留必然错位
    resetEditor();
    if (!sceneId) {
      points.value = [];
      return;
    }
    await loadPoints(sceneId);
    // 卡片旁路的快照与主运行态**并行**拉（两个独立数据域，互不阻塞）：
    // 主运行态决定画布锚点，卡片旁路决定悬浮卡片里的逐属性值。
    void liveValues.load(sceneId);
    // 告警域的设备集合随场景切换（设备集合来自刚拉到的点位）
    alertCounts.setDevices(points.value.map((point) => point.deviceId));
    // ⚠️ 必须等一次渲染刷新再读 `bindingsByPointId`（computed 的失效是**异步**的）：
    // `loadPoints` 里刚 `points.value = data`，同一 tick 内 computed 仍返回**旧缓存**，
    // 于是 `loadSnapshot` 拿到空的绑定映射 ⇒ 主展示属性解析不出来 ⇒
    // 锚点标签永远是空文本（线上实测：6 个标签 textContent 全为空）。
    await nextTick();
    try {
      await runtime.loadSnapshot(sceneId, bindingsByPointId.value);
      // 首屏就要有告警数（不能等第一条 alert 事件，否则 KPI 长期显示 0 = 假绿）
      alertCounts.setDevices(points.value.map((point) => point.deviceId));
      void alertCounts.refreshNow();
    } catch {
      // 失败原因已写入 runtime.error，模板渲染错误态；此处不重复提示
    }
  },
  { immediate: true },
);

/** 主题变化 ⇒ 下发画布（亮色主题用浅色背景/地面，避免深色画布嵌在亮色页面里）。 */
watch(
  isDark,
  (dark) => {
    canvasRef.value?.setLightCanvasTheme(!dark);
  },
  { immediate: true },
);

onMounted(async () => {
  try {
    await loadScenes();
  } catch {
    // 失败原因在 sceneError，模板渲染错误态
  }
});

/** 点位保存/删除后刷新（点位变 ⇒ 绑定变 ⇒ 运行态的主展示属性变）。 */
async function reloadAfterPointChange(): Promise<void> {
  // 保存/删除后退出放置态：草稿已落库，留着会让用户以为还要再点一次
  resetEditor();
  await loadPoints(currentSceneId.value);
  alertCounts.setDevices(points.value.map((point) => point.deviceId));
  await nextTick();
  if (currentSceneId.value) {
    try {
      await runtime.loadSnapshot(currentSceneId.value, bindingsByPointId.value);
      void alertCounts.refreshNow();
    } catch {
      // 同上
    }
  }
}

/**
 * 画布在「放置锚点」模式下拾取到模型表面：记录草稿并打开点位表单。
 *
 * 坐标已是本场景局部坐标（画布侧用世界矩阵的逆换算过），落库口径直接可用。
 *
 * @param payload 拾取结果
 */
/**
 * 画布装配完成 ⇒ 补推已收到的运行态。
 *
 * 为什么需要：`onFlush` 在画布挂载前就会触发（先拉数据、后装配 WebGL），
 * 而 push 用 `canvasRef.value?.` 会静默丢弃 ⇒ 首屏 6 个状态丢失、锚点标签全空。
 * 实测证据：`flush 提交 states=6` 已执行，但 `anchorLayer.update` **从未被调用**，
 * 6 个 `.twin-anchor-label` 的 textContent 全为空。
 */
function onCanvasReady(): void {
  if (latestAnchorStates) {
    canvasRef.value?.updateAnchorStates(latestAnchorStates);
  }
  // 画布就绪后同步当前钉住态（深链 `?pointId=` 刷新进入时，卡片要直接出现）
  canvasRef.value?.syncPinnedPoint(currentPointId.value || undefined);
}

/**
 * 深链/列表选中变化 ⇒ 画布卡片跟着钉住（URL → 画布，单向）。
 *
 * 与 `onCardPinChange`（画布 → URL）配对；两处都只做「写」，读永远以 URL 为准，
 * 因此不会形成互相触发的环。
 */
watch(currentPointId, (pointId) => {
  const canvas = canvasRef.value;
  if (!canvas) {
    return;
  }
  if (pointId) {
    void canvas.focusPoint(pointId);
  } else {
    canvas.syncPinnedPoint(undefined);
  }
});

/**
 * 画布请求「取消钉住」（用户点击画布空白/按下画布）⇒ 清掉 URL 里的 `pointId`。
 *
 * 为什么要单独一条事件而不是复用 `pin-change`：取消钉住必须**无论**它最初是
 * 由「点击锚点」还是「URL 深链」建立的 —— 从深链进入时本地没有过 pin 事件，
 * 只靠画布内部状态清不掉 URL（实测 dev：点空白后 URL 仍带 pointId）。
 */
async function onUnpinRequest(): Promise<void> {
  if (!currentPointId.value) {
    return;
  }
  selectPoint(null);
  await router.replace({ query: { ...route.query, pointId: undefined } });
}

function onPlaceAnchor(payload: {
  local: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}): void {
  setDraft(payload);
}

/**
 * 点击已有锚点：高亮 + 写回 URL（`?pointId=`）。
 *
 * 不直接打开编辑弹窗（避免误改）；要改请点右侧列表的「编辑」。
 * 写回 URL 让「当前选中」可分享、可刷新恢复。
 *
 * @param pointId 点位主键
 */
async function onSelectAnchor(pointId: string): Promise<void> {
  selectPoint(pointId);
  if (currentPointId.value === pointId) {
    return;
  }
  await router.replace({ query: { ...route.query, pointId } });
}

/**
 * 跳转设备详情（运行态下钻闭环的另一半，工单 #127）。
 *
 * 复用既有 `?deviceId=` 约定（见 `modules/device-detail-link.ts`），不新造 URL 格式。
 *
 * @param pointId 点位主键
 */
async function openDeviceDetail(pointId: string): Promise<void> {
  const point = points.value.find((item) => item.id === pointId);
  const target = buildDeviceDetailTarget(point?.deviceId);
  if (!target) {
    // 设备已被删除 / 点位不存在：给出可见提示而不是「点了没反应」
    deeplinkNotice.value = $t('page.iot.twin.deviceMissingForPoint');
    return;
  }
  await router.push(target);
}

/**
 * 资产列表加载完成（模型面板块上报）。
 *
 * @param list 资产列表
 */
function onAssetsLoaded(list: IotTwinApi.ModelAssetResp[]): void {
  assets.value = list;
}

/**
 * 卡片里点「点位配置」⇒ 选中该点位（右侧列表高亮并滚动到它）。
 *
 * 为什么不直接打开编辑弹窗：编辑是**写操作**，用户只是「想看看这个点怎么配的」时
 * 弹出表单会让人误以为要改配置（与点锚点=查看、点列表「修改」=编辑的既有分工一致）。
 *
 * @param pointId 点位 ID
 */
async function onOpenPointConfig(pointId: string): Promise<void> {
  await onSelectAnchor(pointId);
  document
    .querySelector(`[data-twin-point-row="${pointId}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
</script>

<template>
  <Page auto-content-height>
    <!--
      页面主标题：视觉标题由页头/菜单承担，这里给读屏用的唯一 <h1>
      （与设备台账/告警中心同口径；a11y-gates 门禁要求每个页面恰好 1 个）。
    -->
    <h1 class="sr-only">{{ $t('page.iot.twin.title') }}</h1>
    <ListErrorAlert
      v-if="sceneError"
      :error="sceneError"
      :retry-text="$t('page.iot.twin.retry')"
      :title="$t('page.iot.twin.sceneLoadFailed')"
      @retry="loadScenes"
    />
    <!--
      布局（本轮改版的核心）：
      · 画布是**唯一视觉主体**，占满可用区域，不再被顶部 KPI 条挤压；
      · KPI / 场景上下文 / 操作提示全部做成**画布内浮层**（HUD）；
      · 左右两栏是「工具车道」：窄、分区清晰、视觉降噪（操作 hover 才出现）。
      栅格：`minmax(0,1fr)` 中间 + 固定窄车道两侧；间距统一 3（12px）→ 与全站一致。
    -->
    <div v-else class="flex h-full min-h-0 gap-3">
      <!-- ═══ 左车道：场景导航 ═══ -->
      <aside
        class="flex w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card"
      >
        <SceneTree
          :badges="sceneBadges"
          :can-add-child="canAddChild"
          :current-scene-id="currentSceneId"
          :depth-of="depthOf"
          :error="sceneError"
          :loading="sceneLoading"
          :parent-options="parentOptions"
          :scenes="scenes"
          :tree="tree"
          @enter="enterScene"
          @refresh="loadScenes"
        />
      </aside>

      <!-- ═══ 中：主画布（唯一视觉主体） ═══ -->
      <section
        class="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-border/70 bg-card"
      >
        <Empty
          v-if="scenes.length === 0 && !sceneLoading"
          :description="$t('page.iot.twin.noScene')"
        />
        <div
          v-else-if="!currentSceneId"
          class="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <span>{{ $t('page.iot.twin.selectSceneHint') }}</span>
        </div>
        <TwinCanvas
          v-else
          ref="canvasRef"
          :ancestry="ancestry.chain"
          :ancestry-broken="ancestry.broken"
          :anchors="points"
          :assets="assets"
          :editor-mode="editorMode"
          :scene="currentScene"
          :scene-id="currentSceneId"
          @fallback="(reason: string) => (fallbackReason = reason)"
          @motion-mode="
            (mode: 'normal' | 'off' | 'reduced') => (motionMode = mode)
          "
          @open-device="openDeviceDetail"
          @open-point="onOpenPointConfig"
          @pin-change="onCardPinChange"
          @place="onPlaceAnchor"
          @ready="onCanvasReady"
          @render-stats="(stats) => (renderStats = stats)"
          @scene-summary="(summary) => (sceneSummary = summary)"
          @select="onSelectAnchor"
          @shell-supported="(supported) => (shellSupported = supported)"
          @state-change="
            (state: string, error?: string) => {
              canvasState = state;
              canvasError = error ?? '';
            }
          "
          @unpin-request="onUnpinRequest"
        />

        <!-- ═══ 画布 HUD：场景上下文 + KPI（浮层，不占布局） ═══ -->
        <TwinCanvasHud
          v-if="currentSceneId && canvasState !== 'loading'"
          :ancestry="ancestry.chain"
          :kpi="kpi"
          :realtime-state="String(realtimeState)"
          :summary="sceneSummary"
          @enter="enterScene"
        />

        <!-- 画布 HUD：左上角告警提示（有内容才出现，避免常态占位） -->
        <div
          v-if="alerts.length > 0"
          class="pointer-events-none absolute left-4 top-28 z-10 w-80 space-y-2"
        >
          <Alert
            v-for="(item, index) in alerts"
            :key="index"
            class="pointer-events-auto shadow-lg backdrop-blur"
            :message="item.message"
            :type="item.type"
            :closable="item.dismissible"
            @close="item.close?.()"
          />
        </div>

        <!-- 画布 HUD：右上工具簇（外观切换 / 返回上级），在 KPI 簇下方一行 -->
        <div
          class="pointer-events-none absolute right-4 top-16 z-10 flex items-center gap-2"
        >
          <!-- 视角预设：一键回到可复现的构图（俯视/等轴/侧视） -->
          <div
            class="pointer-events-auto flex items-center rounded-lg border border-border/60 bg-background/70 text-xs shadow backdrop-blur"
            role="group"
            :aria-label="$t('page.iot.twin.camera.label')"
          >
            <span class="px-2 text-muted-foreground">
              {{ $t('page.iot.twin.camera.label') }}
            </span>
            <button
              v-for="preset in CAMERA_PRESET_IDS"
              :key="preset"
              class="px-1.5 py-1 transition-colors first-of-type:rounded-none last:rounded-r-lg"
              :class="
                activeCameraPreset === preset
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              "
              type="button"
              :aria-pressed="activeCameraPreset === preset"
              @click="applyCameraPreset(preset)"
            >
              {{ $t(`page.iot.twin.camera.${preset}`) }}
            </button>
          </div>
          <div
            v-if="shellSupported && canvasState === 'ready'"
            class="pointer-events-auto flex items-center gap-1 rounded-lg border border-border/60 bg-background/70 px-2 py-1 text-xs shadow backdrop-blur"
          >
            <span class="text-muted-foreground">
              {{ $t('page.iot.twin.shell.label') }}
            </span>
            <button
              class="rounded px-1.5 py-0.5 transition-colors"
              :class="
                showShell
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              "
              type="button"
              :aria-pressed="showShell"
              @click="toggleShell(!showShell)"
            >
              {{
                showShell
                  ? $t('page.iot.twin.shell.full')
                  : $t('page.iot.twin.shell.section')
              }}
            </button>
          </div>
          <button
            v-if="ancestry.chain.length > 1"
            class="pointer-events-auto rounded-lg border border-border/60 bg-background/70 px-2 py-1 text-xs text-muted-foreground shadow backdrop-blur transition-colors hover:text-foreground"
            type="button"
            @click="goParent"
          >
            {{ $t('page.iot.twin.backParent') }}
          </button>
        </div>

        <!-- 画布 HUD：左下只放图例（状态栏移到右下与工具簇同行，避免三者挤在一起） -->
        <div class="pointer-events-none absolute bottom-4 left-4 z-10">
          <RuntimeLegend />
        </div>

        <!-- 画布 HUD：右下（状态栏 + 外观开关 + 返回上级，同一行右对齐） -->
        <div
          class="pointer-events-none absolute bottom-4 right-4 z-10 flex items-center gap-2"
        >
          <TwinStatusBar
            :last-update-at="lastUpdateAt"
            :model-count="currentScene?.modelAssetId ? 1 : 0"
            :motion-mode="motionMode"
            :realtime-state="String(realtimeState)"
            :render-stats="renderStats"
          />
        </div>
      </section>

      <!-- ═══ 右车道：设备点位 + 模型资产 ═══ -->
      <aside class="flex w-80 shrink-0 flex-col gap-3 overflow-hidden">
        <PointPanel
          class="min-h-0 flex-1"
          :editing-point-id="editingPointId"
          :error="pointsError"
          :loading="pointsLoading"
          :pending="hasDraft"
          :picked-anchor="editorDraft ?? undefined"
          :place-form-open="placeFormOpen"
          :placing="editorMode === 'place'"
          :points="points"
          :scene-id="currentSceneId"
          @cancel-placing="cancelPlacing"
          @dismiss-place="dismissPlaceForm"
          @open-device="openDeviceDetail"
          @refresh="reloadAfterPointChange"
          @select="onSelectAnchor"
          @start-placing="startPlacing"
        />

        <ModelPanel
          class="shrink-0"
          @assets-loaded="onAssetsLoaded"
          @refresh="loadScenes"
        />
      </aside>
    </div>
  </Page>
</template>
