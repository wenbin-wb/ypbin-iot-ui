<script lang="ts" setup>
import type { TwinKpiResult } from '../modules/twin-kpi';

import { computed } from 'vue';

import { $t } from '#/locales';

import { toKpiItems } from '../modules/twin-kpi';

/**
 * 顶部 KPI 条（**只展示**：数字由 `computeTwinKpi` 算出，本组件不做统计）。
 *
 * ## 设计要点
 *
 * - 五个指标固定顺序：设备 / 在线率 / 告警 / 点位 / 模型，**顺序稳定**用户才不用每次找；
 * - 「当前场景」范围的指标带一个弱化后缀（`scopeHint`），避免用户把「场景内 6 台设备」
 *   误读成「全平台 6 台」；
 * - 告警数 > 0 时用警示色并带呼吸点，**0 也照样显示**（不显示会让人怀疑数据没加载）；
 * - 无数据（在线率分母为 0 / 快照截断）显示 `--`，**不显示 0%**（口径同全仓「无数据不是 0」）。
 *
 * 组件不引入任何新请求：所有数字来自 props。
 */
const props = defineProps<{
  /** 全局指标的后缀说明（如「全部」）。 */
  globalHint: string;
  /** KPI 计算结果。 */
  kpi: TwinKpiResult;
  /** 场景范围内指标的后缀说明（如「当前场景」）。 */
  scopeHint: string;
}>();

const items = computed(() =>
  toKpiItems(props.kpi, {
    alerts: props.scopeHint,
    devices: props.scopeHint,
    // 场景数与模型数是**全局**口径，不能标「当前场景」（标错会让用户以为只有一个场景）
    models: props.globalHint,
    onlineRate: props.scopeHint,
    points: props.scopeHint,
    scenes: props.globalHint,
  }),
);

/** 指标文案（key → 本地化）。 */
function labelOf(key: string): string {
  return $t(`page.iot.twin.kpi.${key}`);
}
</script>

<template>
  <dl
    class="flex items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-card"
  >
    <div
      v-for="item in items"
      :key="item.key"
      class="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-1.5"
      :data-kpi="item.key"
    >
      <dt class="flex items-center gap-1 text-xs text-muted-foreground">
        <span class="truncate">{{ labelOf(item.key) }}</span>
        <span
          v-if="item.hint"
          class="hidden truncate text-[10px] opacity-70 xl:inline"
        >
          · {{ item.hint }}
        </span>
        <!-- 有告警时给一个呼吸点：KPI 条要一眼看出「系统活着且有问题」 -->
        <span
          v-if="item.key === 'alerts' && item.danger"
          class="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-destructive motion-reduce:animate-none"
          aria-hidden="true"
        ></span>
      </dt>
      <dd
        class="flex items-baseline gap-0.5 text-lg font-semibold leading-tight tabular-nums"
        :class="item.danger ? 'text-destructive' : ''"
      >
        <template v-if="item.value === undefined">--</template>
        <template v-else>{{ item.value }}</template>
        <span
          v-if="item.key === 'onlineRate' && item.value !== undefined"
          class="text-xs font-normal text-muted-foreground"
          >%</span
        >
      </dd>
    </div>
  </dl>
</template>
