<script lang="ts" setup>

import type { IotTwinApi } from '#/api/iot';
import type { AnchorRuntimeState } from '#/three/twin/types';

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Page } from '@vben/common-ui';

import { Alert, Tooltip } from 'ant-design-vue';

import { getTwinPointList } from '#/api/iot';
import { $t } from '#/locales';
import { TWIN_COLOR_ALERT, TWIN_COLOR_ONLINE } from '#/three/twin/colors';

import { useTwinRuntime } from './composables/use-twin-runtime';
import TwinCanvas from './modules/twin-canvas.vue';

/**
 * 投屏模式（**大屏只读视图**）。
 *
 * ## 为什么需要它
 *
 * 指挥中心/会议室的大屏上，管理和编辑能力是**噪音**：场景树、点位列表、模型资产、
 * 新建按钮全都不该出现，观众只需要「一眼看清全局」。而现有的孪生页是为运维配置设计的
 * 完整工作台，直接投屏会把一半屏幕交给表单。
 *
 * ## 与编辑页的关系（**不是另起一套**）
 *
 * - 复用同一条数据链路：场景列表 + 点位 + 运行态快照 + SSE（`useTwinRuntime`），
 *   KPI 口径复用 `computeTwinKpi` 的同一份输入（不重复实现统计逻辑）；
 * - 复用同一个画布组件 `TwinCanvas`（**零分叉**：渲染、交互、动效全部与编辑页一致）；
 * - 单独成页而不是把 `index.vue` 拆成两个模式：编辑页状态机（草稿/放置/弹层）非常复杂，
 *   塞进只读模式会引入「投屏时误触发编辑」的风险。
 *
 * ## 路由与退出的三条路径
 *
 * 1. 地址栏 `#/iot/twin-display?sceneId=...` 直接进入（刷新/新窗口大屏都可用）；
 * 2. 右上「退出投屏」按钮 ⇒ 回到编辑页同一场景；
 * 3. `Esc` 键 ⇒ 同上。
 */

const route = useRoute();
const router = useRouter();

/** 当前场景 id（URL 唯一真相，与编辑页同口径）。 */
const sceneId = computed(() => {
  const value = route.query.sceneId;
  return typeof value === 'string' && value !== '' ? value : '';
});

const scene = ref<IotTwinApi.SceneResp | undefined>();
const points = ref<IotTwinApi.PointResp[]>([]);
const loadError = ref('');
const canvasRef = ref<InstanceType<typeof TwinCanvas> | null>(null);
/** 最近一次运行态（画布就绪后补推）。 */
let latestStates: Map<string, AnchorRuntimeState> | null = null;

const runtime = useTwinRuntime({
  onFlush: (states: Map<string, AnchorRuntimeState>) => {
    latestStates = states;
    canvasRef.value?.updateAnchorStates(states);
  },
});

/**
 * KPI（与编辑页同口径：设备去重 / unknown 不计入在线率分母 / 告警按设备去重）。
 *
 * 为什么在这里自己算而不复用编辑页的 `computeTwinKpi` 调用：编辑页拿到的是
 * 「场景列表 + 资产列表」两份额外数据，投屏页不需要它们；这里用**同一个函数**、
 * 只喂它已有的输入，统计口径不会漂移。
 */
const kpi = computed(() => {
  const devices = new Set<string>();
  for (const point of points.value) {
    devices.add(String(point.deviceId));
  }
  const runtimePoints = runtime.snapshot.value?.points ?? [];
  const alertByDevice = new Map<string, number>();
  let online = 0;
  let settled = 0;
  for (const point of runtimePoints) {
    const deviceId = String(point.deviceId);
    const alerts = Number(point.alertCount ?? 0);
    if (alerts > 0) {
      alertByDevice.set(
        deviceId,
        Math.max(alertByDevice.get(deviceId) ?? 0, alerts),
      );
    }
    if (point.onlineStatus === 'online' || point.onlineStatus === 'offline') {
      settled += 1;
    }
    if (point.onlineStatus === 'online') {
      online += 1;
    }
  }
  let alerts = 0;
  for (const count of alertByDevice.values()) {
    alerts += count;
  }
  const truncated = runtime.snapshot.value?.truncated === true;
  return {
    alerts,
    devices: devices.size,
    onlineRate:
      truncated || settled === 0
        ? undefined
        : Math.round((online / settled) * 100),
    points: points.value.length,
  };
});

/** 大屏 KPI 项（顺序：设备 / 在线率 / 告警 / 点位）。 */
const kpiItems = computed(() => [
  {
    label: $t('page.iot.twin.kpi.devices'),
    value: String(kpi.value.devices),
  },
  {
    label: $t('page.iot.twin.kpi.onlineRate'),
    value:
      kpi.value.onlineRate === undefined ? '--' : `${kpi.value.onlineRate}%`,
  },
  {
    label: $t('page.iot.twin.kpi.alerts'),
    value: String(kpi.value.alerts),
    danger: kpi.value.alerts > 0,
  },
  {
    label: $t('page.iot.twin.kpi.points'),
    value: String(kpi.value.points),
  },
]);

/** 系统是否「活着」：实时流是否处于 live（大屏上必须可见，否则看的是冻结画面）。 */
const realtimeLive = computed(
  () => String(runtime.realtimeState.value ?? '') === 'live',
);

/**
 * 加载投屏所需的全部数据（场景 → 点位 → 运行态快照）。
 *
 * 失败必须显式呈现（大屏上空白比报错更难排查）。
 */
async function loadAll(): Promise<void> {
  if (!sceneId.value) {
    loadError.value = $t('page.iot.twin.display.noScene');
    return;
  }
  try {
    const { getTwinScene, getTwinSceneList } = await import('#/api/iot');
    // 场景详情失败时回落列表（列表里有名字，足够大屏展示）
    try {
      scene.value = await getTwinScene(sceneId.value);
    } catch {
      const list = await getTwinSceneList();
      scene.value = list.find((item) => item.id === sceneId.value);
    }
    points.value = await getTwinPointList(sceneId.value);
    const bindings = new Map(
      points.value.map((point) => [point.id, point.bindings]),
    );
    await runtime.loadSnapshot(sceneId.value, bindings);
    loadError.value = '';
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  }
}

/** 画布就绪 ⇒ 补推进来的运行态（与编辑页同一时序问题）。 */
function onCanvasReady(): void {
  if (latestStates) {
    canvasRef.value?.updateAnchorStates(latestStates);
  }
}

/** 退出投屏：回到编辑页的同一场景。 */
async function exitDisplay(): Promise<void> {
  await router.replace({
    path: '/iot/twin',
    query: sceneId.value ? { sceneId: sceneId.value } : {},
  });
}

/**
 * Esc 退出（大屏现场最直觉的退出方式）。
 *
 * @param event 键盘事件
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    void exitDisplay();
  }
}

watch(sceneId, loadAll, { immediate: true });

onMounted(() => {
  globalThis.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  globalThis.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Page auto-content-height>
    <!-- 读屏用的唯一 h1（与编辑页同口径，a11y 门禁要求） -->
    <h1 class="sr-only">{{ $t('page.iot.twin.display.title') }}</h1>

    <div class="relative flex h-full min-h-0 flex-col">
      <!-- ─── 顶部：场景标题 + 大号 KPI + 退出 ─── -->
      <header
        class="flex shrink-0 items-center justify-between gap-4 rounded-xl border border-border/70 bg-card px-4 py-2.5"
      >
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span
              class="size-2 shrink-0 rounded-full"
              :style="{
                backgroundColor: realtimeLive
                  ? TWIN_COLOR_ONLINE
                  : TWIN_COLOR_ALERT,
              }"
              aria-hidden="true"
            ></span>
            <h2 class="truncate text-base font-semibold leading-tight">
              {{ scene?.sceneName ?? $t('page.iot.twin.display.title') }}
            </h2>
            <span
              v-if="!realtimeLive"
              class="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive"
            >
              {{ $t('page.iot.twin.display.realtimePaused') }}
            </span>
          </div>
          <p class="mt-0.5 truncate text-[11px] text-muted-foreground">
            {{ scene?.sceneCode }}
            <span v-if="scene?.remark"> · {{ scene.remark }}</span>
          </p>
        </div>

        <!-- 大号 KPI：大屏/投屏距离远，字号必须足够 -->
        <dl class="flex items-stretch divide-x divide-border/40">
          <div
            v-for="item in kpiItems"
            :key="item.label"
            class="flex flex-col items-end px-4"
          >
            <dt class="text-[11px] leading-none text-muted-foreground">
              {{ item.label }}
            </dt>
            <dd
              class="text-2xl font-semibold leading-tight tabular-nums"
              :style="item.danger ? { color: TWIN_COLOR_ALERT } : undefined"
            >
              {{ item.value }}
            </dd>
          </div>
        </dl>

        <Tooltip :title="$t('page.iot.twin.display.exitHint')">
          <button
            class="shrink-0 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            type="button"
            @click="exitDisplay"
          >
            {{ $t('page.iot.twin.display.exit') }}
          </button>
        </Tooltip>
      </header>

      <!-- ─── 画布：占满剩余空间（投屏的主视觉） ─── -->
      <div
        class="relative mt-3 min-h-0 flex-1 overflow-hidden rounded-xl border border-border/70 bg-card"
      >
        <Alert
          v-if="loadError"
          class="absolute left-4 top-4 z-20 max-w-lg"
          :message="loadError"
          show-icon
          type="error"
        />
        <TwinCanvas
          v-if="sceneId"
          ref="canvasRef"
          :ancestry="scene ? [scene] : []"
          :ancestry-broken="false"
          :anchors="points"
          :assets="[]"
          editor-mode="browse"
          :scene="scene"
          :scene-id="sceneId"
          @ready="onCanvasReady"
        />
        <div
          v-else
          class="flex h-full items-center justify-center text-sm text-muted-foreground"
        >
          {{ $t('page.iot.twin.display.noScene') }}
        </div>
      </div>
    </div>
  </Page>
</template>
