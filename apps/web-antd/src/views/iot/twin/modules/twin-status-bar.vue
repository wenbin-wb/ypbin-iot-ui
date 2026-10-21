<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { $t } from '#/locales';

/**
 * 画布底部状态栏（**运行态观测窗**）。
 *
 * ## 为什么需要它
 *
 * 3D 画布最大的信任问题不是「画得不好看」，而是「画面是真的在实时更新，还是冻住了一张图」。
 * 状态栏把四件必须看得见的事摊开：
 *
 * 1. **FPS**：明显掉帧时用户至少知道是自己的机器/模型太大，而不是「数据没来」；
 * 2. **渲染对象数**（geometries / textures）：切换场景后数字猛涨 = 显存泄漏（§5.4 的观测口）；
 * 3. **最后更新时间**：数据停止更新但画面看起来正常，是最容易误判的场景；
 * 4. **SSE 连接状态**：断流时画面会「定格」，必须显式说出来。
 *
 * ## FPS 采集方式
 *
 * 用独立 rAF 计数（不侵入渲染循环）：每 500ms 结算一次。
 * 页面隐藏时 rAF 不触发 ⇒ 计数自然停住，不需要额外的 `visibilitychange` 处理。
 */

const props = defineProps<{
  /** 最后更新时间（毫秒时间戳）；从未更新过为 undefined。 */
  lastUpdateAt?: number;
  /** 已加载模型数（0 或 1：当前场景只有一个模型）。 */
  modelCount: number;
  /** 动效档位（`prefers-reduced-motion` / 弱机型降级时显示）。 */
  motionMode?: 'normal' | 'off' | 'reduced';
  /** SSE 连接状态。 */
  realtimeState: string;
  /** 渲染统计（由画布通过回调上报；未就绪时为 undefined）。 */
  renderStats?: {
    geometries: number;
    textures: number;
  };
}>();

const fps = ref<number | undefined>(undefined);
let frames = 0;
let windowStartedAt = 0;
let rafId = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** 统计窗口（毫秒）。 */
const FPS_WINDOW_MS = 500;

function tick(timestamp: number): void {
  if (windowStartedAt === 0) {
    windowStartedAt = timestamp;
  }
  frames += 1;
  rafId = requestAnimationFrame(tick);
}

onMounted(() => {
  rafId = requestAnimationFrame(tick);
  timer = setInterval(() => {
    const now = performance.now();
    const elapsed = now - windowStartedAt;
    if (elapsed > 0) {
      fps.value = Math.round((frames / elapsed) * 1000);
    }
    frames = 0;
    windowStartedAt = now;
  }, FPS_WINDOW_MS);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
});

/** FPS 档位（用于着色：>=50 正常，30~49 偏低，<30 告警）。 */
const fpsTone = computed(() => {
  const value = fps.value;
  if (value === undefined) {
    return 'text-muted-foreground';
  }
  if (value >= 50) {
    return 'text-emerald-500';
  }
  if (value >= 30) {
    return 'text-amber-500';
  }
  return 'text-destructive';
});

/** 实时连接状态文案。 */
const realtimeLabel = computed(() => {
  const states = [
    'closed',
    'connecting',
    'live',
    'reconnecting',
    'unauthorized',
  ];
  const state = states.includes(props.realtimeState)
    ? props.realtimeState
    : 'closed';
  return $t(`page.iot.twin.status.realtime.${state}`);
});

/** 实时连接状态色。 */
const realtimeTone = computed(() => {
  switch (props.realtimeState) {
    case 'connecting':
    case 'reconnecting': {
      return 'text-amber-500';
    }
    case 'live': {
      return 'text-emerald-500';
    }
    case 'unauthorized': {
      return 'text-destructive';
    }
    default: {
      return 'text-muted-foreground';
    }
  }
});

/** 最后更新时间的相对描述（每 500ms 重算，与 FPS 共用定时器）。 */
const lastUpdateText = computed(() => {
  if (props.lastUpdateAt === undefined) {
    return '--';
  }
  // 用 fps 变化作为「心跳」触发重算：组件自身不额外起定时器
  void fps.value;
  const seconds = Math.max(
    0,
    Math.round((Date.now() - props.lastUpdateAt) / 1000),
  );
  return $t('page.iot.twin.status.updatedAgo', [seconds]);
});

/** 动效档位只在非 normal 时显示（normal 是默认态，不需要占位）。 */
const showMotion = computed(
  () => props.motionMode !== undefined && props.motionMode !== 'normal',
);
</script>

<template>
  <div
    class="pointer-events-none flex items-center gap-3 rounded bg-background/75 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground backdrop-blur"
  >
    <span :class="fpsTone" data-status="fps">
      {{ $t('page.iot.twin.status.fps') }} {{ fps ?? '--' }}
    </span>
    <span data-status="models">
      {{ $t('page.iot.twin.status.models') }} {{ modelCount }}
    </span>
    <span v-if="renderStats" data-status="geometries">
      Geo {{ renderStats.geometries }} / Tex {{ renderStats.textures }}
    </span>
    <span data-status="updated"> {{ lastUpdateText }} </span>
    <span :class="realtimeTone" data-status="realtime">
      {{ realtimeLabel }}
    </span>
    <span
      v-if="showMotion"
      class="rounded bg-muted px-1 text-muted-foreground"
      data-status="motion"
    >
      {{ $t(`page.iot.twin.status.motion.${motionMode}`) }}
    </span>
  </div>
</template>
