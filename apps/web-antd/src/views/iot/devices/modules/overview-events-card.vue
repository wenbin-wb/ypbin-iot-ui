<script lang="ts" setup>
import type { IotEventApi } from '#/api/iot';

import { computed } from 'vue';

import { Alert, Empty, Tag, Timeline, TimelineItem } from 'ant-design-vue';

import { $t } from '#/locales';

import { formatDateTime } from '../../shared/display';

/**
 * 概览 · 最近事件卡（时间线 + 截断提示）。
 *
 * 只展示最近几条，完整时间线在「事件与断档」页签。为什么颜色/级别文案由父组件传入：
 * 事件页签的完整时间线与本卡是**同一套级别映射**，在卡片里再抄一份会出现「概览标红、页签标橙」
 * 这类两处口径漂移；函数作为 prop 传入，单一实现留在 detail.vue。
 */
const props = defineProps<{
  /** 级别 → a-timeline/Tag 颜色（与事件页签同源）。 */
  eventColor: (level?: string) => string;
  /** 级别 → 文案（与事件页签同源）。 */
  eventLevelText: (level?: string) => string;
  /** 事件列表（父组件已按级别过滤，概览固定看最新）。 */
  events: IotEventApi.EventLogResp[];
  /** 查询失败原因（非空即错误态）。 */
  eventsError: string;
  /** 事件总数（可能大于本页条数：用于「还有更多事件」截断提示）。 */
  eventsTotal: number;
}>();

/** 概览区只展示最近几条（完整时间线在「事件与断档」页签）。 */
const RECENT_EVENT_SIZE = 3;

/** 概览区的「最近事件」（时间线已按发生时刻倒序，直接取前几条）。 */
const recentEvents = computed(() => props.events.slice(0, RECENT_EVENT_SIZE));

/** 是否还有更多事件没在本页展示（提示用户去页签或用级别/时间收窄）。 */
const eventsTruncated = computed(() => props.eventsTotal > props.events.length);
</script>

<template>
  <!-- 最近事件：有数据给时间线，无数据给空态，查询失败单独报错 -->
  <section
    class="rounded-xl border border-border/80 bg-card p-4"
    data-section="overview-recent-events"
  >
    <h3 class="mb-3 text-sm font-semibold">
      {{ $t('page.iot.device.recentEvents') }}
    </h3>
    <Alert v-if="eventsError" :message="eventsError" show-icon type="error" />
    <Empty
      v-else-if="recentEvents.length === 0"
      :description="$t('page.iot.event.empty')"
    />
    <template v-else>
      <Timeline>
        <TimelineItem
          v-for="event in recentEvents"
          :key="event.id"
          :color="eventColor(event.level)"
        >
          <div class="flex flex-wrap items-center gap-2">
            <Tag :color="eventColor(event.level)">
              {{ eventLevelText(event.level) }}
            </Tag>
            <span class="font-medium">
              {{ event.eventName || event.eventCode }}
            </span>
            <span class="text-xs text-muted-foreground">
              {{ formatDateTime(event.eventTs) }}
            </span>
          </div>
        </TimelineItem>
      </Timeline>
      <div v-if="eventsTruncated" class="text-xs text-muted-foreground">
        {{ $t('page.iot.event.goToTab') }}
      </div>
    </template>
  </section>
</template>
