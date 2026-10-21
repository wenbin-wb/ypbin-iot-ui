<script lang="ts" setup>
import type { CardPlacement } from './property-card-layout';
import type {
  PropertyCardModel,
  PropertyCardStatus,
} from './property-card-model';

import { computed } from 'vue';

import { IconifyIcon } from '@vben/icons';

import { Button } from 'ant-design-vue';

import { $t } from '#/locales';

import { describeAge } from './property-card-model';

/**
 * 悬浮/点击属性卡片（**浮层，不是 HTML 标签**）。
 *
 * ## 三条交互约定
 *
 * 1. **悬停即显示**：鼠标停在锚点上弹卡片；卡片本身可交互（复制、看详情），
 *    因此指针移入卡片时**不能关闭**（关闭由 `useTwinPropertyCard` 的 grace 窗口负责）。
 * 2. **点击钉住**：点锚点后卡片固定，带「已固定」标记与关闭按钮；再点画布空白取消。
 * 3. **位置由父组件算好**：本组件只负责渲染与像素级 `left/top`，定位算法在
 *    `property-card-layout.ts`（纯函数，可单测）。
 *
 * ## 数据口径（与全仓一致）
 *
 * - 无数据 ⇒ `--` + 「暂无上报」，**绝不显示 0**；
 * - `stale`（值已失效）⇒ 灰底 + 明确文案；
 * - 质量非 good ⇒ 警示色 + 原始质量码（便于排查）；
 * - 绑定失效（属性已从物模型删除）⇒ 红色「属性已失效」提示。
 */
const props = defineProps<{
  /** 卡片数据（已组装好）。 */
  card: PropertyCardModel;
  /**
   * 当前时刻（毫秒）。
   *
   * 由父组件传入并随实时 tick 更新：**组件内不读 `Date.now()`**，
   * 否则「12 秒前」会停在打开那一刻不动（看起来像卡死）。
   */
  now: number;
  /** 是否钉住。 */
  pinned: boolean;
  /** 定位结果（相对画布）。 */
  placement: CardPlacement;
  /** 是否处于「删除中/不可用」等禁用态（预留，当前恒 false）。 */
  readOnly?: boolean;
}>();

const emit = defineEmits<{
  /** 关闭（取消钉住）。 */
  close: [];
  /** 跳转设备详情（运行态下钻闭环）。 */
  openDevice: [];
  /** 点位备注中的编辑入口（配置态）。 */
  openPoint: [];
  /** 指针进入卡片（取消关闭定时器）。 */
  pointerEnter: [];
  /** 指针离开卡片。 */
  pointerLeave: [];
}>();

/** 状态 → 左侧色条 + 徽标语义（色值走 CSS 变量，`.vue` 内不写 hex）。 */
const statusAccent = computed(() => {
  const map: Record<PropertyCardStatus, string> = {
    alert: 'bg-destructive',
    disabled: 'bg-muted-foreground/50',
    normal: 'bg-emerald-500',
    offline: 'bg-muted-foreground',
    unknown: 'bg-amber-500',
  };
  return map[props.card.cardStatus];
});

/** 卡片宽度（与定位算法共享同一常量，避免两处漂移）。 */
const CARD_WIDTH = 320;

/** 定位样式（像素级）。 */
const cardStyle = computed(() => ({
  left: `${props.placement.left}px`,
  top: `${props.placement.top}px`,
  width: `${CARD_WIDTH}px`,
}));

/**
 * 相对时间文案（结构化 → 本地化）。
 *
 * @param ts 时间戳（毫秒）
 * @returns 文案；无时间戳为 undefined
 */
function ageText(ts: number | undefined): string | undefined {
  const age = describeAge(ts, props.now);
  if (!age) {
    return undefined;
  }
  return $t(`page.iot.twin.card.age.${age.unit}`, [age.count]);
}

/**
 * 时间戳原文（`2026-10-21 15:56:20`），带 tooltip 便于核对。
 *
 * 用 `toLocaleString` 而不是手拼：手拼会漏时区/跨日/两位补零的边界。
 *
 * @param ts 时间戳（毫秒）
 * @returns 文本
 */
function timestampText(ts: number | undefined): string | undefined {
  if (ts === undefined) {
    return undefined;
  }
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <div
    class="pointer-events-auto absolute z-20 animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none"
    :style="cardStyle"
    data-twin-property-card
    role="dialog"
    :aria-label="card.deviceName"
    @pointerenter="emit('pointerEnter')"
    @pointerleave="emit('pointerLeave')"
  >
    <!-- 左侧状态色条 -->
    <div
      class="absolute inset-y-1 left-0 w-0.5 rounded-full"
      :class="statusAccent"
      aria-hidden="true"
    ></div>

    <div
      class="rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur-sm"
    >
      <!-- 标题区 -->
      <header class="flex items-start gap-2 border-b border-border px-3 py-2">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="truncate text-sm font-medium" :title="card.deviceName">
              {{ card.deviceName }}
            </span>
            <span
              v-if="pinned"
              class="shrink-0 rounded bg-primary/15 px-1 text-[10px] text-primary"
            >
              {{ $t('page.iot.twin.card.pinned') }}
            </span>
          </div>
          <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span :class="card.cardStatus === 'alert' ? 'text-destructive' : 'text-muted-foreground'">
              {{ $t(`page.iot.twin.card.status.${card.cardStatus}`) }}
            </span>
            <span
              v-if="card.alertCount > 0"
              class="rounded bg-destructive/15 px-1 text-destructive"
            >
              {{ $t('page.iot.twin.card.alertCount', [card.alertCount]) }}
            </span>
            <span v-if="card.nodeName" class="truncate text-muted-foreground">
              · {{ card.nodeName }}
            </span>
          </div>
        </div>
        <Button
          v-if="pinned"
          :aria-label="$t('page.iot.twin.card.close')"
          :title="$t('page.iot.twin.card.close')"
          class="shrink-0"
          size="small"
          type="text"
          @click="emit('close')"
        >
          <IconifyIcon class="size-3.5" icon="lucide:x" />
        </Button>
      </header>

      <!-- 属性表 -->
      <div class="max-h-64 overflow-auto px-1 py-1">
        <!-- 无绑定：明确说明，而不是一张空表 -->
        <p
          v-if="card.rows.length === 0"
          class="px-2 py-3 text-center text-xs text-muted-foreground"
        >
          {{ $t('page.iot.twin.card.noBinding') }}
        </p>
        <table v-else class="w-full border-collapse text-xs">
          <thead class="sr-only">
            <tr>
              <th>{{ $t('page.iot.twin.card.property') }}</th>
              <th>{{ $t('page.iot.twin.card.value') }}</th>
              <th>{{ $t('page.iot.twin.card.updatedAt') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in card.rows"
              :key="row.propertyIdentifier"
              class="border-b border-border/40 last:border-b-0"
              :class="row.primary ? 'bg-primary/5' : ''"
              :data-property="row.propertyIdentifier"
            >
              <td class="w-24 px-2 py-1.5 align-top">
                <div class="flex items-center gap-1">
                  <span
                    v-if="row.primary"
                    class="size-1 shrink-0 rounded-full bg-primary"
                    :title="$t('page.iot.twin.card.primaryHint')"
                  ></span>
                  <span class="truncate" :title="row.propertyName">
                    {{ row.propertyName }}
                  </span>
                </div>
                <div class="truncate text-[10px] text-muted-foreground/70">
                  {{ row.propertyIdentifier }}
                </div>
              </td>
              <td class="px-2 py-1.5 align-top">
                <div class="flex items-baseline gap-1">
                  <span
                    class="font-medium tabular-nums"
                    :class="{
                      'text-muted-foreground/60': row.quality === 'missing',
                      'text-destructive': row.quality === 'bad',
                      'text-amber-500': row.quality === 'stale',
                    }"
                  >
                    {{ row.valueText ?? '--' }}
                  </span>
                  <span
                    v-if="row.unit"
                    class="text-[10px] text-muted-foreground"
                  >
                    {{ row.unit }}
                  </span>
                </div>
                <!-- 无数据：明确说「暂无上报」，与显示 0 严格区分 -->
                <div
                  v-if="row.quality === 'missing'"
                  class="text-[10px] text-muted-foreground/70"
                >
                  {{ $t('page.iot.twin.card.noData') }}
                </div>
                <div
                  v-else-if="row.quality === 'stale'"
                  class="text-[10px] text-amber-500"
                >
                  {{ $t('page.iot.twin.card.stale') }}
                </div>
                <div
                  v-else-if="row.quality === 'bad'"
                  class="text-[10px] text-destructive"
                >
                  {{ $t('page.iot.twin.card.badQuality', [row.qualityCode ?? '']) }}
                </div>
                <div
                  v-if="row.bindingStale"
                  class="text-[10px] text-destructive"
                >
                  {{ $t('page.iot.twin.card.bindingStale') }}
                </div>
              </td>
              <td class="w-16 px-2 py-1.5 align-top text-right">
                <span
                  v-if="row.updatedAt !== undefined"
                  class="text-[10px] text-muted-foreground"
                  :title="timestampText(row.updatedAt)"
                >
                  {{ ageText(row.updatedAt) }}
                </span>
                <span v-else class="text-[10px] text-muted-foreground/60">--</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 底部操作 -->
      <footer
        class="flex items-center justify-between gap-2 border-t border-border px-2 py-1.5"
      >
        <span class="truncate text-[10px] text-muted-foreground/70">
          {{ card.remark || $t('page.iot.twin.card.hint') }}
        </span>
        <div class="flex shrink-0 items-center gap-1">
          <Button size="small" type="link" @click="emit('openDevice')">
            {{ $t('page.iot.twin.card.openDevice') }}
            <IconifyIcon class="ml-0.5 size-3" icon="lucide:external-link" />
          </Button>
          <Button size="small" type="link" @click="emit('openPoint')">
            {{ $t('page.iot.twin.card.editPoint') }}
          </Button>
        </div>
      </footer>
    </div>

    <!-- 指向锚点的小三角（视觉锚定，纯装饰） -->
    <div
      class="absolute left-1/2 size-2 -translate-x-1/2 rotate-45 border-border bg-popover"
      :class="
        placement.side === 'above'
          ? 'border-b border-r -bottom-1'
          : 'border-l border-t -top-1'
      "
      aria-hidden="true"
    ></div>
  </div>
</template>
