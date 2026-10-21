<script lang="ts" setup>
import type { IotTwinApi } from '#/api/iot';
import type { AnchorRuntimeState } from '#/three/twin/types';

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Page } from '@vben/common-ui';

import { Alert, Empty, Spin } from 'ant-design-vue';

import { getTwinPointList } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import ListErrorAlert from '../shared/list-error-alert.vue';
import { useTwinEditor } from './composables/use-twin-editor';
import { useTwinRuntime } from './composables/use-twin-runtime';
import { useTwinScene } from './composables/use-twin-scene';
import { buildDeviceDetailTarget } from './modules/device-detail-link';
import ModelPanel from './modules/model-panel.vue';
import PointPanel from './modules/point-panel.vue';
import RuntimeLegend from './modules/runtime-legend.vue';
import SceneTree from './modules/scene-tree.vue';
import TwinCanvas from './modules/twin-canvas.vue';

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

const runtime = useTwinRuntime({
  onFlush: (states: Map<string, AnchorRuntimeState>) => {
    canvasRef.value?.updateAnchorStates(states);
  },
});

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

/**
 * 进入某场景（只写 URL；数据加载由 watch 统一处理）。
 *
 * @param sceneId 场景 id
 */
async function enterScene(sceneId: string): Promise<void> {
  if (sceneId === currentSceneId.value) {
    return;
  }
  await router.replace({ query: { ...route.query, sceneId } });
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
    try {
      await runtime.loadSnapshot(sceneId, bindingsByPointId.value);
    } catch {
      // 失败原因已写入 runtime.error，模板渲染错误态；此处不重复提示
    }
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
  if (currentSceneId.value) {
    try {
      await runtime.loadSnapshot(currentSceneId.value, bindingsByPointId.value);
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
      :message="sceneError"
      :title="$t('page.iot.twin.sceneLoadFailed')"
    />
    <div v-else class="flex h-full min-h-0 gap-3">
      <!-- 左：场景树 -->
      <aside
        class="w-72 shrink-0 overflow-hidden rounded-lg border border-border"
      >
        <SceneTree
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

      <!-- 中：画布 -->
      <section
        class="relative min-w-0 flex-1 overflow-hidden rounded-lg border border-border"
      >
        <Empty
          v-if="scenes.length === 0 && !sceneLoading"
          :description="$t('page.iot.twin.noScene')"
        />
        <div
          v-else-if="!currentSceneId"
          class="flex h-full items-center justify-center text-sm text-muted-foreground"
        >
          {{ $t('page.iot.twin.selectSceneHint') }}
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
          @place="onPlaceAnchor"
          @select="onSelectAnchor"
          @state-change="
            (state: string, error?: string) => {
              canvasState = state;
              canvasError = error ?? '';
            }
          "
        />

        <!-- 顶部状态条：加载中 / 回退原因 / 画布错误 -->
        <div class="pointer-events-none absolute left-3 top-3 space-y-2">
          <div v-if="canvasState === 'loading'" class="pointer-events-auto">
            <Spin />
          </div>
          <Alert
            v-if="fallbackReason"
            class="pointer-events-auto max-w-md"
            closable
            :message="fallbackReason"
            type="info"
            @close="fallbackReason = ''"
          />
          <Alert
            v-if="canvasError"
            class="pointer-events-auto max-w-md"
            :message="canvasError"
            type="error"
          />
          <Alert
            v-if="ancestry.broken && currentScene"
            class="pointer-events-auto max-w-md"
            :message="$t('page.iot.twin.ancestryBroken')"
            type="warning"
          />
          <Alert
            v-if="deeplinkNotice"
            class="pointer-events-auto max-w-md"
            closable
            :message="deeplinkNotice"
            type="info"
            @close="deeplinkNotice = ''"
          />
        </div>

        <RuntimeLegend class="absolute bottom-3 left-3" />

        <!-- 面包屑 -->
        <nav
          v-if="ancestry.chain.length > 0"
          class="absolute bottom-3 right-3 flex items-center gap-1 rounded bg-background/85 px-2 py-1 text-xs"
        >
          <template v-for="(item, index) in ancestry.chain" :key="item.id">
            <span v-if="index > 0" class="text-muted-foreground">/</span>
            <button
              class="hover:text-primary"
              type="button"
              @click="enterScene(item.id)"
            >
              {{ item.sceneName }}
            </button>
          </template>
          <button
            v-if="ancestry.chain.length > 1"
            class="ml-2 text-primary hover:underline"
            type="button"
            @click="goParent"
          >
            {{ $t('page.iot.twin.backParent') }}
          </button>
        </nav>
      </section>

      <!-- 右：点位 + 模型 -->
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
