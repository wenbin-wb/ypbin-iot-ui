<script lang="ts" setup>
import type { IotDeviceTraceApi } from '#/api/iot';

import { computed, onMounted, ref } from 'vue';

import {
  Alert,
  Button,
  Empty,
  Select,
  SelectOption,
  Space,
  Table,
  Tag,
} from 'ant-design-vue';

import { getDeviceTrace } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import {
  directionLabelKey,
  formatTraceTime,
  hasAdvice,
  needsAttention,
  needsRetryHint,
  outcomeColor,
  outcomeLabelKey,
  resolveTraceListState,
  showsTruncationHint,
  stageLabelKey,
} from './trace-state';

/**
 * 设备详情抽屉的「消息跟踪」页签（看板 #8）。
 *
 * 设计目标（对标华为云 IoTDA 消息跟踪）：用户报障时能在一处看到**这台设备的消息时序**，
 * 并且对每条失败给出**下一步查什么**。本组件只用**后端一个端点**
 * （{@code GET /iot/devices/{id}/messages}），不做任何前端拼装。
 *
 * 🔴 三条"宁可少显示、也不误导"的约束：
 * 1. **失败态与空态严格分离**：查询失败显示 Alert，空态才说"这段时间没有消息"；
 * 2. **能力边界必须显式**：上行链路一期有看不见的断点（被整批拒绝的上报、是否已落库），
 *    页面必须把这段说明**常驻**显示，否则"没有上行条目"会被读成"设备没上报"；
 * 3. **不假装知道**：上行受理条目的结果是"未知"——它不是成功也不是失败，
 *    一期无法判定落库与否，页面如实显示为未知而不是打个绿勾。
 *
 * 权限：`iot:debug:get`（**不是** `iot:device:list`——本页含下行命令与回执入口，
 * 与既有命令查询端点同码；见后端 `DeviceTraceController` 类注释）。
 */
const props = defineProps<{
  /** 设备主键。 */
  deviceId: number | string;
}>();

/** 每个来源各自的时间字段语义不同，因此窗口只提供几个常用档位（不提供任意输入）。 */
const WINDOW_OPTIONS = [
  { labelKey: 'page.iot.device.trace.window1h', hours: 1 },
  { labelKey: 'page.iot.device.trace.window6h', hours: 6 },
  { labelKey: 'page.iot.device.trace.window24h', hours: 24 },
  { labelKey: 'page.iot.device.trace.window7d', hours: 24 * 7 },
] as const;

const loading = ref(false);
const errorMessage = ref('');
const resp = ref<IotDeviceTraceApi.TimelineResp | null>(null);
const windowHours = ref<number>(1);
const stageFilter = ref<string>('');
const outcomeFilter = ref<string>('');

const listState = computed(() =>
  resolveTraceListState(
    loading.value,
    errorMessage.value,
    resp.value?.items?.length ?? 0,
  ),
);

/** 一行 = 一条目（后端保证），因此前端不再做任何展开/合并。 */
const rows = computed(() => resp.value?.items ?? []);

const stageOptions = computed(() =>
  [
    'down-enqueued',
    'down-published',
    'down-ack',
    'up-received',
    'event-reported',
    'device-offline',
  ].map((code) => ({ code, label: $t(stageLabelKey(code)) })),
);

const outcomeOptions = computed(() =>
  ['ok', 'failed', 'timeout', 'unknown'].map((code) => ({
    code,
    label: $t(outcomeLabelKey(code)),
  })),
);

/**
 * 拉取时间线。
 *
 * 时间窗由前端按"当前时刻往前 N 小时"算好再传——让**服务端**决定窗口会更一致，
 * 但轮询刷新时前端必须能表达"我关心的是最近 N 小时"，否则每次刷新窗口都会漂移。
 */
async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const now = new Date();
    const from = new Date(now.getTime() - windowHours.value * 60 * 60 * 1000);
    resp.value = await getDeviceTrace(props.deviceId, {
      from: from.toISOString(),
      to: now.toISOString(),
      ...(stageFilter.value ? { stage: stageFilter.value } : {}),
      ...(outcomeFilter.value ? { outcome: outcomeFilter.value } : {}),
    });
  } catch (error) {
    // 失败必须落成**显式状态**：不能把"查询失败"渲染成"没有消息"
    errorMessage.value = extractErrorMessage(
      error,
      $t('page.iot.device.trace.loadFailed'),
    );
    resp.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 筛选区：改完即查，不需要额外点"查询" -->
    <Space :size="8" wrap>
      <Select
        v-model:value="windowHours"
        class="w-[150px]"
        size="small"
        @change="load"
      >
        <SelectOption
          v-for="opt in WINDOW_OPTIONS"
          :key="opt.hours"
          :value="opt.hours"
        >
          {{ $t(opt.labelKey) }}
        </SelectOption>
      </Select>
      <Select
        v-model:value="stageFilter"
        class="w-[170px]"
        size="small"
        allow-clear
        :placeholder="$t('page.iot.device.trace.filterStage')"
        @change="load"
      >
        <SelectOption
          v-for="opt in stageOptions"
          :key="opt.code"
          :value="opt.code"
        >
          {{ opt.label }}
        </SelectOption>
      </Select>
      <Select
        v-model:value="outcomeFilter"
        class="w-[150px]"
        size="small"
        allow-clear
        :placeholder="$t('page.iot.device.trace.filterOutcome')"
        @change="load"
      >
        <SelectOption
          v-for="opt in outcomeOptions"
          :key="opt.code"
          :value="opt.code"
        >
          {{ opt.label }}
        </SelectOption>
      </Select>
      <Button size="small" :loading="loading" @click="load">
        {{ $t('page.iot.device.trace.refresh') }}
      </Button>
    </Space>

    <!-- 🔴 能力边界常驻说明：不显示这段，"没有上行条目"会被误读成"设备没上报" -->
    <Alert
      type="info"
      show-icon
      :message="$t('page.iot.device.trace.boundaryTitle')"
      :description="
        resp?.upstreamTraceNote || $t('page.iot.device.trace.boundaryDesc')
      "
    />

    <!-- 截断必须显式告知，否则用户以为"就这些" -->
    <Alert
      v-if="showsTruncationHint(resp)"
      type="warning"
      show-icon
      :message="$t('page.iot.device.trace.truncatedTitle')"
      :description="$t('page.iot.device.trace.truncatedDesc')"
    />

    <!-- 失败态：与空态严格分离（挂在表格之外，不依赖 Empty 槽） -->
    <Alert
      v-if="listState === 'error'"
      type="error"
      show-icon
      :message="$t('page.iot.device.trace.loadFailed')"
      :description="errorMessage"
    />

    <Table
      :data-source="rows"
      :loading="loading"
      :pagination="false"
      row-key="occurredAt"
      size="small"
      :scroll="{ y: 420 }"
    >
      <Table.Column
        :title="$t('page.iot.device.trace.colTime')"
        data-index="occurredAt"
        :width="170"
      >
        <template #default="{ record }">
          <div class="flex flex-col">
            <span>{{ formatTraceTime(record.occurredAt) }}</span>
            <!-- 重发会就地覆写时间戳 ⇒ 必须提示，否则用户以为"10:03 那次"还是原来那次 -->
            <span v-if="needsRetryHint(record)" class="text-xs text-orange-500">
              {{
                $t('page.iot.device.trace.retryHint', {
                  n: record.retryCount ?? 0,
                })
              }}
            </span>
          </div>
        </template>
      </Table.Column>
      <Table.Column
        :title="$t('page.iot.device.trace.colDirection')"
        :width="80"
      >
        <template #default="{ record }">
          <Tag>{{ $t(directionLabelKey(record.direction)) }}</Tag>
        </template>
      </Table.Column>
      <Table.Column :title="$t('page.iot.device.trace.colStage')" :width="130">
        <template #default="{ record }">
          {{ $t(stageLabelKey(record.stage)) }}
        </template>
      </Table.Column>
      <Table.Column :title="$t('page.iot.device.trace.colOutcome')" :width="90">
        <template #default="{ record }">
          <Tag :color="outcomeColor(record.outcome)">
            {{ $t(outcomeLabelKey(record.outcome)) }}
          </Tag>
        </template>
      </Table.Column>
      <Table.Column
        :title="$t('page.iot.device.trace.colTitle')"
        data-index="title"
      />
      <Table.Column
        :title="$t('page.iot.device.trace.colErrorCode')"
        :width="150"
      >
        <template #default="{ record }">
          <!-- 即使没有建议也必须显示原始错误码：它是用户排障的依据 -->
          <span :class="needsAttention(record) ? 'text-red-500' : ''">
            {{ record.errorCode || '-' }}
          </span>
        </template>
      </Table.Column>
      <Table.Column :title="$t('page.iot.device.trace.colAdvice')">
        <template #default="{ record }">
          <div v-if="hasAdvice(record)" class="flex flex-col gap-1">
            <span class="text-sm">{{ record.advice.summary }}</span>
            <ul class="m-0 pl-4 text-xs">
              <li v-for="(action, index) in record.advice.actions" :key="index">
                {{ action }}
              </li>
            </ul>
            <span class="text-xs text-gray-400">{{
              record.advice.ruleId
            }}</span>
          </div>
          <span v-else class="text-xs text-gray-400">
            <!-- 没有建议时也要显示，且要说明"原始错误码见左列"——不是静默空白 -->
            {{ $t('page.iot.device.trace.noAdvice') }}
          </span>
        </template>
      </Table.Column>
      <template #emptyText>
        <Empty
          v-if="listState === 'empty'"
          :description="$t('page.iot.device.trace.empty')"
        />
      </template>
    </Table>
  </div>
</template>
