<script lang="ts" setup>
import type { TwinKpiResult } from './twin-kpi';

import type { IotTwinApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { $t } from '#/locales';
import {
  TWIN_COLOR_ALERT,
  TWIN_COLOR_ONLINE,
  TWIN_COLOR_UNKNOWN,
} from '#/three/twin/colors';

/**
 * 画布内 HUD：上下文条 + KPI 指标簇（**浮层，不占布局**）。
 *
 * ## 为什么把 KPI 做成浮层而不是顶部常驻条（本轮布局改版的核心决定）
 *
 * 改造前 KPI 是一条占满宽度的常驻条，把画布高度吃掉约 80px（1600×900 下画布只剩
 * 710×716，模型被上下裁切）。而 KPI 的用途是「扫一眼」而不是「持续阅读」——
 * 它应该**悬浮在视觉主体之上**，而不是与视觉主体争夺空间。
 *
 * 因此改为：
 * - 左上：**场景上下文条**（场景名 + 层级路径 + 关键状态 chip），一次性建立「我在看什么」；
 * - 右上：**KPI 指标簇**（紧凑、等宽数字、可折叠成一行），需要细节时展开；
 * - 两者都是 `absolute` 浮层 + 半透明玻璃底，画布始终是满屏的视觉主体。
 *
 * 数据全部来自页面已算好的 `kpi` 与 `ancestry`，组件本身不发请求。
 */
const props = defineProps<{
  /** 从根到当前场景的祖先链（决定层级路径与父级跳转）。 */
  ancestry: IotTwinApi.SceneResp[];
  /** KPI 计算结果（页面用 computeTwinKpi 算出）。 */
  kpi: TwinKpiResult;
  /** 当前 SSE 连接状态（决定「实时」chip 的颜色）。 */
  realtimeState: string;
  /**
   * 引擎层的场景概况（`manager.getSceneSummary()`）。
   *
   * 注意 `animationsRunning` 的语义：**真的在推进**才算 true；弱机型档位下
   * `clipSpeed=0`、mixer 不 update ⇒ false，但 `animationCount` 仍如实反映 clip 数。
   * 因此这里显示「动画 ×N（已暂停）」而不是「播放中」——说的和做的一致。
   */
  summary?: {
    animationCount: number;
    animationsRunning: boolean;
    modelBytes: number;
    motionMode: 'normal' | 'off' | 'reduced';
    orbiting: boolean;
    renderStats: { geometries: number; textures: number };
  };
}>();

const emit = defineEmits<{
  /** 点击层级路径中的某一级（跳转到该场景）。 */
  enter: [sceneId: string];
}>();

/** KPI 簇是否展开（默认展开：首屏要让用户看到「这台系统在实时运行」）。 */
const expanded = ref(true);

/** 当前场景名（祖先链末级）。 */
const sceneName = computed(
  () => props.ancestry.at(-1)?.sceneName ?? $t('page.iot.twin.title'),
);

/** 当前场景类型（用于上下文条的小标签）。 */
const sceneTypeLabel = computed(() => {
  const type = props.ancestry.at(-1)?.sceneType;
  return type ? $t(`page.iot.twin.sceneType.${type}`) : '';
});

/** 实时连接状态（chip 配色与文案）。 */
const realtimeChip = computed(() => {
  switch (props.realtimeState) {
    case 'connecting':
    case 'reconnecting': {
      return {
        color: TWIN_COLOR_UNKNOWN,
        label: $t('page.iot.twin.hud.reconnecting'),
      };
    }
    case 'live': {
      return { color: TWIN_COLOR_ONLINE, label: $t('page.iot.twin.hud.live') };
    }
    case 'unauthorized': {
      return {
        color: TWIN_COLOR_ALERT,
        label: $t('page.iot.twin.hud.unauthorized'),
      };
    }
    default: {
      return { color: undefined, label: $t('page.iot.twin.hud.offline') };
    }
  }
});

/** KPI 指标（顺序固定：设备 → 在线率 → 告警 → 点位；场景/模型在折叠态隐藏）。 */
const metrics = computed(() => {
  const kpi = props.kpi;
  return [
    {
      key: 'devices',
      label: $t('page.iot.twin.kpi.devices'),
      value: String(kpi.deviceCount),
      accent: undefined as string | undefined,
    },
    {
      key: 'onlineRate',
      label: $t('page.iot.twin.kpi.onlineRate'),
      // 口径同 KPI 条：分母为 0 / 快照截断 ⇒ `--` 而不是 0%
      value: kpi.onlineRate === undefined ? '--' : `${kpi.onlineRate}%`,
      accent: undefined as string | undefined,
    },
    {
      key: 'alerts',
      label: $t('page.iot.twin.kpi.alerts'),
      value: String(kpi.alertCount),
      accent: kpi.alertCount > 0 ? TWIN_COLOR_ALERT : undefined,
    },
    {
      key: 'points',
      label: $t('page.iot.twin.kpi.points'),
      value: String(kpi.pointCount),
      accent: undefined as string | undefined,
    },
  ];
});

/** 模型体积 chip（未知时不显示，不显示「0 MB」这种误导信息）。 */
const modelChip = computed(() => {
  const bytes = props.summary?.modelBytes ?? 0;
  if (bytes <= 0) {
    return undefined;
  }
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
});

/** 动画 chip：有 clip 但**没在推进**时明确写「已暂停」（与 getSceneSummary 语义一致）。 */
const animationChip = computed(() => {
  const summary = props.summary;
  if (!summary || summary.animationCount <= 0) {
    return undefined;
  }
  return summary.animationsRunning
    ? $t('page.iot.twin.hud.animationRunning', [summary.animationCount])
    : $t('page.iot.twin.hud.animationPaused', [summary.animationCount]);
});

/** 动效档位 chip：只在降级时出现（normal 是默认态，不必占位）。 */
const motionChip = computed(() => {
  const mode = props.summary?.motionMode;
  if (!mode || mode === 'normal') {
    return undefined;
  }
  return $t(`page.iot.twin.status.motion.${mode}`);
});

/** 折叠态补充项（场景数 / 模型数，全局口径）。 */
const extraMetrics = computed(() => [
  {
    key: 'scenes',
    label: $t('page.iot.twin.kpi.scenes'),
    value: String(props.kpi.sceneCount),
  },
  {
    key: 'models',
    label: $t('page.iot.twin.kpi.models'),
    value: String(props.kpi.modelCount),
  },
]);
</script>

<template>
  <div class="pointer-events-none absolute inset-0 z-10">
    <!-- ─── 左上：场景上下文条 ─── -->
    <div
      class="absolute left-4 top-4 flex max-w-[calc(100%-22rem)] flex-col gap-1"
    >
      <div
        class="pointer-events-auto flex items-center gap-2 rounded-xl border border-border/60 bg-background/70 px-2.5 py-1.5 shadow-lg backdrop-blur-md"
      >
        <!-- 场景类型徽标（颜色取引擎调色板，避免调色板色阶类） -->
        <span
          class="flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold uppercase tracking-wider text-background"
          :style="{ backgroundColor: TWIN_COLOR_ONLINE }"
          aria-hidden="true"
        >
          {{ sceneTypeLabel.slice(0, 2) }}
        </span>
        <div class="min-w-0">
          <h2 class="truncate text-sm font-semibold leading-tight">
            {{ sceneName }}
          </h2>
          <!-- 层级路径：每一级可点，末级为当前（不可点） -->
          <nav
            class="flex min-w-0 items-center gap-0.5 text-[11px] text-muted-foreground"
          >
            <template v-for="(item, index) in ancestry" :key="item.id">
              <span v-if="index > 0" class="px-0.5 opacity-60">/</span>
              <button
                v-if="index < ancestry.length - 1"
                class="truncate rounded px-0.5 transition-colors hover:text-foreground"
                type="button"
                @click="emit('enter', item.id)"
              >
                {{ item.sceneName }}
              </button>
              <span v-else class="truncate">{{ item.sceneName }}</span>
            </template>
          </nav>
        </div>
      </div>

      <!-- 状态 chip 行：实时连接 / 模型 / 动画 / 动效档位（颜色与画布锚点同源） -->
      <div class="pointer-events-auto flex flex-wrap items-center gap-1.5 pl-1">
        <span
          class="inline-flex items-center gap-1 rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground backdrop-blur"
        >
          <span
            class="size-1.5 rounded-full"
            :style="{ backgroundColor: realtimeChip.color }"
            aria-hidden="true"
          ></span>
          {{ realtimeChip.label }}
        </span>
        <span
          v-if="modelChip"
          class="rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground backdrop-blur"
        >
          {{ modelChip }}
        </span>
        <span
          v-if="animationChip"
          class="rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground backdrop-blur"
        >
          {{ animationChip }}
        </span>
        <span
          v-if="motionChip"
          class="rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground backdrop-blur"
        >
          {{ motionChip }}
        </span>
      </div>
    </div>

    <!-- ─── 右上：KPI 指标簇（可折叠） ─── -->
    <div
      class="pointer-events-auto absolute right-4 top-4 flex items-center overflow-hidden rounded-xl border border-border/60 bg-background/70 shadow-lg backdrop-blur-md"
    >
      <dl class="flex items-stretch divide-x divide-border/40">
        <div
          v-for="metric in metrics"
          :key="metric.key"
          class="flex flex-col gap-0.5 px-3 py-1.5"
          :data-hud-kpi="metric.key"
        >
          <dt class="text-[10px] leading-none text-muted-foreground">
            {{ metric.label }}
          </dt>
          <dd
            class="text-base font-semibold leading-tight tabular-nums"
            :style="metric.accent ? { color: metric.accent } : undefined"
          >
            {{ metric.value }}
          </dd>
        </div>
        <template v-if="expanded">
          <div
            v-for="metric in extraMetrics"
            :key="metric.key"
            class="flex flex-col gap-0.5 px-3 py-1.5"
            :data-hud-kpi="metric.key"
          >
            <dt class="text-[10px] leading-none text-muted-foreground">
              {{ metric.label }}
            </dt>
            <dd class="text-base font-semibold leading-tight tabular-nums">
              {{ metric.value }}
            </dd>
          </div>
        </template>
      </dl>
      <button
        class="flex h-full items-center border-l border-border/40 px-1.5 text-muted-foreground transition-colors hover:text-foreground"
        type="button"
        :aria-label="
          expanded
            ? $t('page.iot.twin.hud.collapse')
            : $t('page.iot.twin.hud.expand')
        "
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <svg
          class="size-3.5 transition-transform"
          :class="{ 'rotate-180': expanded }"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            d="m9 6 6 6-6 6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>
  </div>
</template>
