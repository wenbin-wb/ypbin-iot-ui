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
  pointsLoading.value = true;
  try {
    points.value = await getTwinPointList(sceneId);
    pointsError.value = '';
  } catch (loadError) {
    pointsError.value = extractErrorMessage(
      loadError,
      $t('page.iot.twin.pointLoadFailed'),
    );
  } finally {
    pointsLoading.value = false;
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

/** 点击已有锚点：高亮并在右侧面板定位（不直接打开编辑，避免误改）。 */
function onSelectAnchor(pointId: string): void {
  selectPoint(pointId);
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
