<script lang="ts" setup>
import type { CardValueQuality } from './property-card-model';

import { computed } from 'vue';

import { IconifyIcon } from '@vben/icons';

import { $t } from '#/locales';
import {
  TWIN_COLOR_ALERT,
  TWIN_COLOR_OFFLINE,
  TWIN_COLOR_ONLINE,
  TWIN_COLOR_UNKNOWN,
} from '#/three/twin/colors';

/** 设备属性行（与悬浮卡片同一套口径，由 `buildPropertyCard` 产出后传入）。 */
export interface DevicePanelRow {
  propertyName: string;
  valueText?: string;
  unit?: string;
  quality: CardValueQuality;
}

/**
 * 选中设备详情卡（**画布内浮层**，替代原来的「常驻圆点 + 常驻标签」）。
 *
 * ## 为什么改成「选中才出现」
 *
 * 原来的形态是每个锚点常驻一条「设备名 + 数值」胶囊。6 个锚点时画布上就有 6 条文字，
 * 模型本身被压成背景 —— 而运维真正想先看到的是**模型与布局**，设备信息应在「选中后」展开。
 *
 * 因此：画布默认只显示设备本身（高光由引擎负责），点击某个设备才出现这张卡片。
 *
 * ## 卡片里必须有的四件事
 *
 * 1. **设备身份**：名称 + 编码 + 所在场景（回答「我看的是哪台」）；
 * 2. **运行状态**：在线/离线/未知/停用 + 告警数（回答「它好不好」）；
 * 3. **属性实时值**：该点位全部绑定属性的当前值（无数据 `--`，不显示 0）；
 * 4. **下一步动作**：设备详情 / 点位配置（回答「然后呢」）。
 */
const props = defineProps<{
  /** 活动告警数。 */
  alertCount: number;
  /** 设备编码（主键，展示为弱化小字）。 */
  deviceCode: string;
  /** 所属设备 ID（展示用，长 ID 由 CSS 截断）。 */
  deviceId: string;
  /** 设备名 / 点位可读名（页面按「点位备注 → 设备名 → 设备 ID」优先级传入）。 */
  deviceName: string;
  /** 是否有未保存的位置修改（拖拽后置 true）。 */
  dirty?: boolean;
  /** 该点位能否在模型上高亮（未绑定模型节点时给提示）。 */
  nodeFound?: boolean;
  /** 节点名（配置期对照用）。 */
  nodeName?: string;
  /** 在线状态：online / offline / unknown / 空。 */
  onlineStatus?: null | string;
  /** 属性行。 */
  rows: DevicePanelRow[];
  /** 场景名（回答「我在哪个场景里选中的」。 */
  sceneName?: string;
  /** 启停位：1 启用 0 停用。 */
  status?: null | number;
}>();

const emit = defineEmits<{
  /** 关闭卡片（取消选中）。 */
  close: [];
  /** 打开设备详情。 */
  openDevice: [];
  /** 打开点位配置。 */
  openPoint: [];
}>();

/** 状态 → 文字与颜色（颜色取引擎调色板，与画布锚点同源）。 */
const statusView = computed(() => {
  if (props.status === 0) {
    return {
      color: TWIN_COLOR_OFFLINE,
      key: 'disabled',
    };
  }
  if (props.alertCount > 0) {
    return { color: TWIN_COLOR_ALERT, key: 'alert' };
  }
  if (props.onlineStatus === 'online') {
    return { color: TWIN_COLOR_ONLINE, key: 'normal' };
  }
  if (props.onlineStatus === 'offline') {
    return { color: TWIN_COLOR_OFFLINE, key: 'offline' };
  }
  return { color: TWIN_COLOR_UNKNOWN, key: 'unknown' };
});

/** 质量级别 → 文字颜色（与悬浮卡片口径一致）。 */
function qualityStyle(
  quality: CardValueQuality,
): Record<string, string> | undefined {
  switch (quality) {
    case 'bad': {
      return { color: TWIN_COLOR_ALERT };
    }
    case 'missing': {
      return { opacity: '0.45' };
    }
    case 'stale': {
      return { color: TWIN_COLOR_UNKNOWN };
    }
    default: {
      return undefined;
    }
  }
}
</script>

<template>
  <div
    class="pointer-events-auto flex w-72 flex-col overflow-hidden rounded-xl border border-border/70 bg-background/85 shadow-xl backdrop-blur-md"
    data-device-panel
  >
    <!-- 标题：状态点 + 设备名 + 关闭 -->
    <header class="flex items-start gap-2 border-b border-border/50 px-3 py-2">
      <span
        class="mt-1 size-2 shrink-0 rounded-full"
        :style="{
          backgroundColor: statusView.color,
          boxShadow: `0 0 6px ${statusView.color}`,
        }"
        aria-hidden="true"
      ></span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold" :title="deviceName">
          {{ deviceName }}
        </div>
        <div class="truncate text-[11px] text-muted-foreground">
          {{ deviceCode }}
          <span v-if="sceneName"> · {{ sceneName }}</span>
        </div>
      </div>
      <button
        :aria-label="$t('page.iot.twin.card.close')"
        class="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        type="button"
        @click="emit('close')"
      >
        <IconifyIcon class="size-3.5" icon="lucide:x" />
      </button>
    </header>

    <!-- 状态行 -->
    <div class="flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-[11px]">
      <span :style="{ color: statusView.color }">
        {{ $t(`page.iot.twin.card.status.${statusView.key}`) }}
      </span>
      <span
        v-if="alertCount > 0"
        class="rounded bg-destructive/15 px-1 text-destructive"
      >
        {{ $t('page.iot.twin.card.alertCount', [alertCount]) }}
      </span>
      <span v-if="nodeName" class="truncate text-muted-foreground">
        · {{ nodeName }}
      </span>
    </div>

    <!-- 未绑定模型节点：明确说明为什么看不到高光 -->
    <p
      v-if="nodeFound === false"
      class="mx-3 mb-1 rounded bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground"
    >
      {{ $t('page.iot.twin.devicePanel.notFoundNode') }}
    </p>

    <!-- 属性列表 -->
    <div class="max-h-56 overflow-auto px-3 pb-1">
      <p
        v-if="rows.length === 0"
        class="py-2 text-center text-[11px] text-muted-foreground"
      >
        {{ $t('page.iot.twin.card.noBinding') }}
      </p>
      <ul v-else class="divide-y divide-border/40">
        <li
          v-for="row in rows"
          :key="row.propertyName"
          class="flex items-baseline justify-between gap-2 py-1 text-[11px]"
        >
          <span class="min-w-0 truncate text-muted-foreground">
            {{ row.propertyName }}
          </span>
          <span
            class="shrink-0 tabular-nums"
            :style="qualityStyle(row.quality)"
          >
            <template v-if="row.valueText">{{ row.valueText }}</template>
            <template v-else>--</template>
            <span v-if="row.unit" class="ml-0.5 text-[10px] opacity-70">
              {{ row.unit }}
            </span>
          </span>
        </li>
      </ul>
    </div>

    <!-- 底部：未保存提示 + 动作 -->
    <footer
      class="flex items-center justify-between gap-1 border-t border-border/50 px-2 py-1"
    >
      <span
        v-if="dirty"
        class="truncate text-[10px]"
        :style="{ color: TWIN_COLOR_UNKNOWN }"
      >
        {{ $t('page.iot.twin.devicePanel.unsaved') }}
      </span>
      <span v-else class="truncate text-[10px] text-muted-foreground/70">
        {{ $t('page.iot.twin.devicePanel.dragHint') }}
      </span>
      <div class="flex shrink-0 items-center gap-0.5">
        <button
          class="rounded px-1.5 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/10"
          type="button"
          @click="emit('openDevice')"
        >
          {{ $t('page.iot.twin.card.openDevice') }}
        </button>
        <button
          class="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted"
          type="button"
          @click="emit('openPoint')"
        >
          {{ $t('page.iot.twin.card.editPoint') }}
        </button>
      </div>
    </footer>
  </div>
</template>
