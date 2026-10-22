<script lang="ts" setup>
import type { IotTwinApi } from '#/api/iot';

import { computed, ref, watch } from 'vue';

import { IconifyIcon } from '@vben/icons';

import { Spin, Tag } from 'ant-design-vue';

import { $t } from '#/locales';

/**
 * 设备资料库（**拖拽源**：从这里的设备拖到画布上放置/移动）。
 *
 * ## 为什么需要「资料库 → 画布」这种交互
 *
 * 原来的做法是「在画布上点模型表面放置锚点 → 再在表单里选设备 → 再填坐标」，
 * 用户的心智模型是「把设备放到场景里」，但实际操作是「先点位置、再从下拉里找设备」，
 * 顺序拧着，且同一台设备换位置要点两层表单。
 *
 * 现在改成**拖**：从左侧资料库把设备拖到画布的机柜/工位上，松手即得到落点坐标；
 * 已放置的设备在画布上选中后也能拖（只改草稿，点保存才落库）。
 *
 * ## 数据来源（**不新增接口**）
 *
 * - 已放置在该场景的点位：页面已有的 `points`（与画布锚点同源）；
 * - 可放置的设备：复用手动「放置锚点」流程里的设备搜索接口（`devices` 搜索），
 *   由父组件按需传入（空数组时不显示「未放置」分区）。
 *
 * ## 拖拽协议（HTML5 DnD）
 *
 * `dragstart` 时把「设备 ID + 是否为已有点位」写进 `dataTransfer` 的 `text/plain`；
 * 画布 `drop` 时读出来。为什么用 `text/plain` 而不是自定义 MIME：自定义类型在
 * 部分浏览器/部分来源下会被过滤，`text/plain` 兼容性最好（且不影响从别处拖文本）。
 */
const props = defineProps<{
  /** 可放置（尚未在本场景放置）的设备候选。 */
  deviceCandidates: Array<{ code: string; id: string; name: string }>;
  /** 是否处在「放置/拖拽」可用状态（未选场景时禁用）。 */
  enabled: boolean;
  /** 已放置到当前场景的点位。 */
  points: IotTwinApi.PointResp[];
  /** 是否正在加载可放置设备列表。 */
  searching?: boolean;
  /** 当前选中的点位（高亮列表项）。 */
  selectedPointId?: string;
}>();

const emit = defineEmits<{
  /** 从资料库拖起一个新设备。 */
  dragDevice: [deviceId: string];
  /** 拖拽结束（无论成功与否，父组件据此清理状态）。 */
  dragEnd: [];
  /** 选中已放置的点位（与画布双向联动）。 */
  select: [pointId: string];
}>();

/** 搜索关键字（本地过滤设备候选；远程搜索由父组件负责）。 */
const keyword = ref('');

/** 过滤后的设备候选（按名称/编码模糊匹配）。 */
const filteredCandidates = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) {
    return props.deviceCandidates;
  }
  return props.deviceCandidates.filter(
    (item) =>
      item.name.toLowerCase().includes(kw) ||
      item.code.toLowerCase().includes(kw),
  );
});

/**
 * 开始拖拽某台设备。
 *
 * @param event 拖拽事件
 * @param deviceId 设备 ID
 */
function onDragStart(event: DragEvent, deviceId: string): void {
  if (!props.enabled || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.effectAllowed = 'copy';
  // 协议：`twin-device:<deviceId>`（画布按前缀识别，避免误吃其它拖拽源）
  event.dataTransfer.setData('text/plain', `twin-device:${deviceId}`);
  emit('dragDevice', deviceId);
}

/** 拖拽结束（含用户中途松手取消）。 */
function onDragEnd(): void {
  emit('dragEnd');
}

/** 选中项变化时把列表滚到该项（画布选中 → 列表跟随，双向联动的另一半）。 */
watch(
  () => props.selectedPointId,
  (pointId) => {
    if (!pointId) {
      return;
    }
    const element = document.querySelector<HTMLElement>(
      `[data-device-library-point="${pointId}"]`,
    );
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
);
</script>

<template>
  <div
    class="flex h-full flex-col overflow-hidden rounded-xl border border-border/70 bg-card"
  >
    <header
      class="flex items-center justify-between border-b border-border/70 px-3 py-2"
    >
      <span class="text-sm font-medium">
        {{ $t('page.iot.twin.library.title') }}
      </span>
      <input
        v-model="keyword"
        :placeholder="$t('page.iot.twin.library.searchPlaceholder')"
        class="w-28 rounded border border-border/60 bg-transparent px-1.5 py-0.5 text-[11px] outline-none placeholder:text-muted-foreground/60 focus:border-primary"
        type="search"
      />
    </header>

    <!-- 未选场景：不要展示两个「0」的空分区（会被误读成「资料库是空的」） -->
    <div
      v-if="!enabled"
      class="flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[11px] text-muted-foreground"
    >
      {{ $t('page.iot.twin.library.selectSceneFirst') }}
    </div>
    <div v-else class="min-h-0 flex-1 overflow-auto p-2">
      <!-- 分区一：已放置（可直接拖拽改位置：画布选中后拖） -->
      <section>
        <h3 class="px-1 pb-1 text-[11px] font-medium text-muted-foreground">
          {{ $t('page.iot.twin.library.placed', [points.length]) }}
        </h3>
        <Spin v-if="points.length === 0 && searching" size="small" />
        <p
          v-else-if="points.length === 0"
          class="px-1 py-2 text-[11px] text-muted-foreground"
        >
          {{ $t('page.iot.twin.noPoint') }}
        </p>
        <ul v-else class="space-y-0.5">
          <li
            v-for="point in points"
            :key="point.id"
            :data-device-library-point="point.id"
            class="group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-muted/50"
            :class="
              point.id === selectedPointId ? 'bg-primary/10 text-primary' : ''
            "
            @click="emit('select', point.id)"
          >
            <IconifyIcon
              class="size-3.5 shrink-0"
              :icon="
                point.id === selectedPointId
                  ? 'lucide:mouse-pointer-click'
                  : 'lucide:cpu'
              "
            />
            <span class="min-w-0 flex-1 truncate">
              {{ point.deviceIdName ?? point.deviceId }}
            </span>
            <Tag v-if="point.nodeName" class="m-0 shrink-0 text-[10px]">
              {{ point.nodeName }}
            </Tag>
          </li>
        </ul>
      </section>

      <!-- 分区二：未放置设备（拖到画布放置） -->
      <section class="mt-2 border-t border-border/50 pt-2">
        <h3 class="px-1 pb-1 text-[11px] font-medium text-muted-foreground">
          {{
            $t('page.iot.twin.library.available', [filteredCandidates.length])
          }}
        </h3>
        <p
          v-if="filteredCandidates.length === 0"
          class="px-1 py-2 text-[11px] text-muted-foreground/70"
        >
          {{ $t('page.iot.twin.library.emptyAvailable') }}
        </p>
        <ul v-else class="space-y-0.5">
          <li
            v-for="device in filteredCandidates"
            :key="device.id"
            class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors"
            :class="[
              enabled
                ? 'cursor-grab hover:bg-muted/50 active:cursor-grabbing'
                : 'cursor-not-allowed opacity-50',
            ]"
            :draggable="enabled"
            @dragend="onDragEnd"
            @dragstart="onDragStart($event, device.id)"
          >
            <IconifyIcon
              class="size-3.5 shrink-0 text-muted-foreground"
              icon="lucide:grip-vertical"
            />
            <span class="min-w-0 flex-1 truncate">{{ device.name }}</span>
            <span class="shrink-0 text-[10px] text-muted-foreground/70">
              {{ device.code }}
            </span>
          </li>
        </ul>
      </section>
    </div>

    <footer
      class="border-t border-border/70 px-2 py-1 text-[10px] text-muted-foreground"
    >
      {{ $t('page.iot.twin.devicePanel.dragToPlace') }}
    </footer>
  </div>
</template>
