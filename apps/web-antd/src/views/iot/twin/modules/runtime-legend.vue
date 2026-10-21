<script lang="ts" setup>
import { computed } from 'vue';

import { $t } from '#/locales';
import {
  TWIN_COLOR_ALERT,
  TWIN_COLOR_DISABLED,
  TWIN_COLOR_OFFLINE,
  TWIN_COLOR_ONLINE,
  TWIN_COLOR_UNKNOWN,
} from '#/three/twin/colors';

/**
 * 运行态图例（在线 / 离线 / 未知 / 停用 / 告警）。
 *
 * 图例必须存在：颜色语义若没有说明，运维会把「黄色」理解成「警告」而不是
 * 「平台还没拿到连接事件」。这五种颜色与 `anchor-layer.ts` 的常量**逐一对齐**。
 */
interface LegendItem {
  color: string;
  label: string;
  /** 是否闪烁（告警项用呼吸动画示意）。 */
  blink?: boolean;
}

const items = computed<LegendItem[]>(() => [
  { color: TWIN_COLOR_ONLINE, label: $t('page.iot.twin.legendOnline') },
  { color: TWIN_COLOR_OFFLINE, label: $t('page.iot.twin.legendOffline') },
  { color: TWIN_COLOR_UNKNOWN, label: $t('page.iot.twin.legendUnknown') },
  { color: TWIN_COLOR_DISABLED, label: $t('page.iot.twin.legendDisabled') },
  { blink: true, color: TWIN_COLOR_ALERT, label: $t('page.iot.twin.legendAlert') },
]);
</script>

<template>
  <ul
    class="flex items-center gap-3 rounded bg-background/80 px-2 py-1 text-xs backdrop-blur"
  >
    <li v-for="item in items" :key="item.label" class="flex items-center gap-1">
      <span
        class="inline-block size-2.5 rounded-full"
        :class="{ 'animate-pulse': item.blink }"
        :style="{ backgroundColor: item.color }"
      ></span>
      <span class="text-muted-foreground">{{ item.label }}</span>
    </li>
  </ul>
</template>
