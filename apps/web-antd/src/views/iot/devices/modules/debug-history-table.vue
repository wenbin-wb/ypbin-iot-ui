<script lang="ts" setup>
import type { ErrorDetail } from './debug-status';

import type { IotCommandApi } from '#/api/iot';

import { computed } from 'vue';

import {
  Alert,
  Button,
  Descriptions,
  DescriptionsItem,
  Empty,
  Pagination,
  Popconfirm,
  Select,
  SelectOption,
  Table,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import { isResendableStatus } from '#/api/iot';
import { $t } from '#/locales';

import CopyText from '../../shared/copy-text.vue';
import {
  formatDateTime,
  formatRelativeTime,
  prettyJson,
} from '../../shared/display';
import {
  batchRowClassName,
  displayTime,
  displayValue,
  errorCodeText,
  kindText,
  replyOf,
  showTotal,
  sourceText,
  STATUS_OPTIONS,
  statusColor,
  statusText,
} from './debug-status';

/**
 * 「在线调试」的历史列表区（状态筛选 + 刷新 + 三态 + 展开详情 + 分页 + 重发入口）。
 *
 * 从 `detail-debug.vue` 拆出（2026-10-20 架构审查 §2.2）：本块约 200 行模板，输入全部是
 * 父级传入的列表三态 + 每行数据，行为只有「刷新/翻页/筛选/重发」四个事件。
 *
 * 三条纪律（原样保留）：
 * 1. **失败态原样展示后端 message**（并可展开看原始 `code`/信封）——绝不画成空态；
 * 2. **轮询失败不清空列表**：提示「这是上次成功结果」并说明已停止自动刷新；
 * 3. **重发是「重发同一请求」**：只有 failed/timeout 可重发，无权限时整个历史区块不渲染
 *    （由父级 `canViewHistory` 控制）。
 */
const props = withDefaults(
  defineProps<{
    /** 本批高亮的 requestId 集合（最近一次下发产生）。 */
    batchRequestIds?: ReadonlySet<string>;
    /** 下发/重发权限（`iot:debug:send`）。 */
    canSendCommand?: boolean;
    /** 当前页的行。 */
    history?: IotCommandApi.CommandInstanceResp[];
    /** 查询失败详情（非空 ⇒ 不显示空态）。 */
    historyError?: ErrorDetail;
    /** 是否已完成过一次加载（区分「还没加载」与「确实为空」）。 */
    historyLoaded?: boolean;
    /** 表格 loading。 */
    historyLoading?: boolean;
    /** 当前页码。 */
    historyPage?: number;
    /** 单页条数（与查询参数同源）。 */
    historyPageSize?: number;
    /** 状态过滤（空 = 全部）。 */
    historyStatus?: '' | IotCommandApi.CommandStatusCode;
    /** 总条数（已由后端字符串转 number）。 */
    historyTotal?: number;
    /** 轮询失败详情（不清空列表，只提示）。 */
    pollError?: ErrorDetail;
  }>(),
  {
    batchRequestIds: () => new Set<string>(),
    canSendCommand: false,
    history: () => [],
    historyError: undefined,
    historyLoaded: false,
    historyLoading: false,
    historyPage: 1,
    historyPageSize: 10,
    historyStatus: '',
    historyTotal: 0,
    pollError: undefined,
  },
);


const emit = defineEmits<{
  pageChange: [page: number];
  refresh: [];
  resend: [record: IotCommandApi.CommandInstanceResp];
  statusChange: [value: '' | IotCommandApi.CommandStatusCode];
}>();

/**
 * 表格 slot 的 `record` 静态类型是 `Record<string, any>`（antd Table 的插槽类型），
 * 而 `resend` 事件声明的是强类型行。这里在**组件边界**做一次显式转换，
 * 避免把 `as` 散落进模板（也避免模板里的类型断言在 vue-tsc 下不稳定）。
 */
function onResend(record: IotCommandApi.CommandInstanceResp): void {
  emit('resend', record);
}

const historyColumns = computed(() => [
  {
    dataIndex: 'createTime',
    key: 'createTime',
    title: $t('page.iot.debug.columnTime'),
    width: 170,
  },
  { key: 'kind', title: $t('page.iot.debug.columnKind'), width: 100 },
  { key: 'identifier', title: $t('page.iot.debug.columnIdentifier') },
  { key: 'statusCode', title: $t('page.iot.debug.columnStatus'), width: 190 },
  {
    dataIndex: 'retryCount',
    key: 'retryCount',
    title: $t('page.iot.debug.columnRetry'),
    width: 90,
  },
  { key: 'action', title: $t('common.action'), width: 150 },
]);

/** 本批高亮：最近一次下发产生的记录在列表里标出来，避免 N 条看着像孤立记录。 */
function rowClassName(record: IotCommandApi.CommandInstanceResp): string {
  return batchRowClassName(props.batchRequestIds ?? new Set(), record);
}
</script>

<template>
  <div class="mt-4">
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div class="font-semibold">
        {{ $t('page.iot.debug.historyTitle') }}
        <span class="text-xs text-muted-foreground">
          （{{ $t('page.iot.debug.historyHint') }}）
        </span>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs">{{ $t('page.iot.debug.statusFilter') }}</span>
        <Select
          :value="historyStatus"
          size="small"
          style="width: 140px"
          @change="
            (value) =>
              emit(
                'statusChange',
                value as '' | IotCommandApi.CommandStatusCode,
              )
          "
        >
          <SelectOption value="">
            {{ $t('page.iot.debug.allStatus') }}
          </SelectOption>
          <SelectOption
            v-for="item in STATUS_OPTIONS"
            :key="item"
            :value="item"
          >
            {{ statusText(item) }}
          </SelectOption>
        </Select>
        <Button size="small" @click="emit('refresh')">
          {{ $t('common.refresh') }}
        </Button>
      </div>
    </div>

    <!-- 失败态：原样展示后端 message（并可展开看原始 code/信封）——绝不画成空态 -->
    <Alert
      v-if="historyError"
      :message="historyError.message"
      show-icon
      type="error"
    >
      <template #description>
        <div>
          {{ $t('page.iot.debug.rawEnvelope') }}:
          <span class="font-mono">{{ historyError.code || '-' }}</span>
        </div>
        <pre
          class="mt-1 max-h-[240px] overflow-auto text-xs break-all whitespace-pre-wrap"
          >{{ historyError.raw }}</pre>
      </template>
    </Alert>

    <template v-else>
      <!-- 轮询失败：列表保留上一次成功结果，并如实说明「已停止自动刷新」 -->
      <Alert
        v-if="pollError"
        :message="$t('page.iot.debug.pollFailed')"
        class="mb-2"
        show-icon
        type="warning"
      >
        <template #description>
          <div>{{ pollError.message }}</div>
          <div>
            {{ $t('page.iot.debug.rawEnvelope') }}:
            <span class="font-mono">{{ pollError.code || '-' }}</span>
          </div>
          <pre
            class="mt-1 max-h-[240px] overflow-auto text-xs break-all whitespace-pre-wrap"
            >{{ pollError.raw }}</pre>
        </template>
      </Alert>

      <Table
        :columns="historyColumns"
        :data-source="history"
        :loading="historyLoading"
        :pagination="false"
        :row-class-name="rowClassName"
        row-key="id"
        :scroll="{ x: 920 }"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'createTime'">
            <!-- 绝对时间为主、相对时间为辅：排障时先看「多久前」再核对精确时刻 -->
            <Tooltip :title="formatRelativeTime(record.createTime)">
              {{ formatDateTime(record.createTime) }}
            </Tooltip>
          </template>
          <template v-else-if="column.key === 'kind'">
            {{ kindText(record.kind) }}
          </template>
          <template v-else-if="column.key === 'identifier'">
            {{ record.identifier || '-' }}
            <Tag v-if="batchRequestIds.has(record.requestId)" color="blue">
              {{ $t('page.iot.debug.batchTag') }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'statusCode'">
            <Tag :color="statusColor(record.statusCode)">
              {{ statusText(record.statusCode) }}
            </Tag>
            <span
              v-if="record.errorCode"
              class="ml-1 text-xs text-destructive-text"
            >
              {{ errorCodeText(record.errorCode) }}
            </span>
          </template>
          <template v-else-if="column.key === 'action'">
            <!-- 语义必须明确：重发的是**同一条请求**（同一 requestId），不新生成 -->
            <Popconfirm
              v-if="isResendableStatus(record.statusCode)"
              :title="$t('page.iot.debug.resendConfirm', [record.requestId])"
              @confirm="onResend(record as IotCommandApi.CommandInstanceResp)"
            >
              <Button v-if="canSendCommand" size="small" type="link">
                {{ $t('page.iot.debug.resend') }}
              </Button>
            </Popconfirm>
            <span v-else class="text-muted-foreground text-xs">
              {{ $t('page.iot.debug.resendNotAllowed') }}
            </span>
          </template>
        </template>

        <template #emptyText>
          <Empty
            v-if="historyLoaded"
            :description="$t('page.iot.debug.historyEmpty')"
          />
        </template>

        <!-- 展开：原始报文 + 回执（设备 code/message/data、设备 ts、平台 receivedAt） -->
        <template #expandedRowRender="{ record }">
          <Descriptions :column="2" bordered size="small">
            <DescriptionsItem :label="$t('page.iot.debug.requestId')">
              <CopyText :value="record.requestId" />
              <Tag
                v-if="batchRequestIds.has(record.requestId)"
                class="ml-1"
                color="blue"
              >
                {{ $t('page.iot.debug.batchTag') }}
              </Tag>
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.topic')">
              <CopyText :value="record.topic" />
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.createTime')">
              <Tooltip :title="formatRelativeTime(record.createTime)">
                {{ formatDateTime(record.createTime) }}
              </Tooltip>
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.sentAt')">
              {{ formatDateTime(record.sentAt) }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.finishedAt')">
              {{ formatDateTime(record.finishedAt) }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.retryCount')">
              {{ record.retryCount ?? 0 }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.errorCode')">
              <span class="font-mono">{{ record.errorCode || '-' }}</span>
              <span v-if="record.errorCode" class="ml-1">
                {{ errorCodeText(record.errorCode) }}
              </span>
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.errorMsg')">
              {{ record.errorMsg || '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.emqxMessageId')">
              {{ record.emqxMessageId || '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.source')">
              {{ sourceText(record.source) }}
            </DescriptionsItem>
          </Descriptions>

          <!-- 回执：设备原始字段逐个列出（平台只做原样存储，不改写设备给的值） -->
          <div class="mt-2 font-semibold">
            {{ $t('page.iot.debug.replyParsed') }}
          </div>
          <Descriptions
            v-if="replyOf(record)"
            :column="2"
            bordered
            size="small"
          >
            <DescriptionsItem :label="$t('page.iot.debug.replyCode')">
              {{ displayValue(replyOf(record)?.code) }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.replyMessage')">
              {{ displayValue(replyOf(record)?.message) }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.replyData')">
              {{ displayValue(replyOf(record)?.data) }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.replyTs')">
              {{ displayTime(replyOf(record)?.ts) }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.debug.replyReceivedAt')">
              {{ displayTime(replyOf(record)?.receivedAt) }}
            </DescriptionsItem>
          </Descriptions>
          <Alert
            v-else-if="record.replyPayload"
            :message="$t('page.iot.debug.replyUnparsable')"
            show-icon
            type="info"
          />
          <div v-else class="text-xs text-muted-foreground">
            {{ $t('page.iot.debug.replyEmpty') }}
          </div>

          <div class="mt-2 font-semibold">
            {{ $t('page.iot.debug.payload') }}
          </div>
          <pre
            class="max-h-[280px] overflow-auto text-xs break-all whitespace-pre-wrap"
            >{{ prettyJson(record.payload) }}</pre>

          <div class="mt-2 font-semibold">
            {{ $t('page.iot.debug.replyPayload') }}
          </div>
          <pre
            class="max-h-[280px] overflow-auto text-xs break-all whitespace-pre-wrap"
            >{{ prettyJson(record.replyPayload) }}</pre>
        </template>
      </Table>

      <div class="mt-2 flex justify-end">
        <Pagination
          :current="historyPage"
          :page-size="historyPageSize"
          :show-total="showTotal"
          :total="historyTotal"
          size="small"
          @change="(page) => emit('pageChange', page)"
        />
      </div>
    </template>
  </div>
</template>
