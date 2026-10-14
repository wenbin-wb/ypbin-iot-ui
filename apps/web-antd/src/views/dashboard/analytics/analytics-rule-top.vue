<script lang="ts" setup>
import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { computed } from 'vue';

import { Inbox } from '@vben/icons';

import { $t } from '#/locales';

/**
 * 「告警最多的规则」TOP 列表。
 *
 * 为什么不用柱状图：规则名是中文长文本，横向条形的类目轴会被截断/挤压；
 * 这里用「排名 + 文本 + 相对占比条」的列表，长名可截断（title 兜完整值），
 * 数值一眼可读，且不引入第二套图表配置。
 */
defineOptions({ name: 'AnalyticsRuleTop' });

const props = defineProps<{
  /** 近 30 日告警数 TOP 规则（`name` 是已解析的规则名） */
  items: IotDashboardApi.NameValue[];
}>();

/** 后端已给 TOP5；这里再排序+截断，防止契约漂移让“TOP”名不副实。 */
const topItems = computed(() =>
  [...props.items]
    .toSorted((left, right) => right.value - left.value)
    .slice(0, 5),
);

const maxValue = computed(() => Math.max(topItems.value[0]?.value ?? 0, 1));

function barWidth(value: number) {
  return `${Math.round((value / maxValue.value) * 100)}%`;
}
</script>

<template>
  <div
    v-if="topItems.length > 0"
    class="flex h-[300px] flex-col gap-3 overflow-auto pr-1"
  >
    <div
      v-for="(item, index) in topItems"
      :key="item.name"
      class="flex items-center gap-2 text-sm"
    >
      <span
        class="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
      >
        {{ index + 1 }}
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between gap-2">
          <span class="truncate" :title="item.name">{{
            item.name || '-'
          }}</span>
          <span class="shrink-0 text-xs tabular-nums text-muted-foreground">
            {{ item.value }} {{ $t('page.dashboard.alertUnit') }}
          </span>
        </div>
        <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-accent">
          <div
            class="h-full rounded-full bg-primary"
            :style="{ width: barWidth(item.value) }"
          ></div>
        </div>
      </div>
    </div>
  </div>
  <div
    v-else
    class="flex h-[300px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
  >
    <Inbox class="size-8 opacity-50" />
    <span>{{ $t('page.dashboard.ruleTopEmpty') }}</span>
  </div>
</template>
