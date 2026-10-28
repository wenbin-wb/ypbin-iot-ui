<script lang="ts" setup>
import type { ImportListState } from './import-state';

import type { IotDeviceImportApi } from '#/api/iot';

import { computed } from 'vue';

import { Alert, Button, Empty, Table, Tag } from 'ant-design-vue';

import { $t } from '#/locales';

import { formatDateTime } from '../../shared/display';
import {
  BATCH_PAGE_SIZE,
  batchStatusColor,
  batchStatusLabelKey,
  resolveImportListState,
} from './import-state';

/**
 * 批量导入「批次列表」组件（审查 P2-10 / 批次 6-B 拆分之一）。
 *
 * 职责：只渲染批次表 + 分页器 + 总数/「查看全部批次」入口 + 失败态 Alert。
 * **不自己发请求**：加载、页码、越界回退都在宿主（`import.vue`）——那里才有
 * 「上传成功后回第 1 页」「刷新时停在当前页」这些跨组件编排。
 *
 * 两条必须守住的语义（都有过事故）：
 * 1. **失败态挂在表格之外**：真实表格只在无行时渲染 Empty 槽，已有数据后刷新失败时槽不渲染
 *    ⇒ 失败提示会看不见，页面继续展示过期数据；
 * 2. **行选择用 `custom-row`**：ant-design-vue 4.2.6 的 Table **没有 `row-click` 事件**
 *    （`@row-click` 只会退化成透传 attr，永不触发）⇒ 历史批次点不开、明细永远是空的。
 */
const props = defineProps<{
  /** 批次列表（已按最近在前排序）。 */
  batches: IotDeviceImportApi.BatchResp[];
  /** 总批次数（后端分页 total）。 */
  batchesTotal: number;
  /** 当前页码（1-based）。 */
  batchPage: number;
  /** 加载失败的可见原因（非空即失败；失败不伪装成空态）。 */
  listError: string;
  /** 批次列表加载态。 */
  listLoading: boolean;
  /** 当前选中批次 id（用于高亮行）。 */
  selectedBatchId?: string;
  /** 是否已进入「查看全部批次」模式（决定是否显示分页器）。 */
  showAllBatches: boolean;
}>();

const emit = defineEmits<{
  (e: 'pageChange', page: number): void;
  (e: 'select', batch: IotDeviceImportApi.BatchResp): void;
  (e: 'showAll'): void;
}>();

/** 批次列表状态（三分：加载中 / 失败 / 空 / 就绪）。 */
const listState = computed<ImportListState>(() =>
  resolveImportListState(
    props.listLoading,
    props.listError,
    props.batches.length,
  ),
);

/** 批次表格列（无操作列：点击行即选中，少一次「查看」点击）。 */
const batchColumns = [
  {
    title: $t('page.iot.device.import.fileName'),
    dataIndex: 'fileName',
    ellipsis: true,
  },
  {
    title: $t('page.iot.device.import.status'),
    dataIndex: 'batchStatus',
    width: 110,
  },
  {
    title: $t('page.iot.device.import.totalRows'),
    dataIndex: 'totalRows',
    width: 90,
  },
  {
    title: $t('page.iot.device.import.successRows'),
    dataIndex: 'successRows',
    width: 90,
  },
  {
    title: $t('page.iot.device.import.failedRows'),
    dataIndex: 'failedRows',
    width: 90,
  },
  {
    title: $t('page.iot.device.import.createTime'),
    dataIndex: 'createTime',
    width: 180,
  },
];

/**
 * 批次列表的分页配置。
 *
 * 默认 `false`（只显示最近一页，保持「上传 → 看结果」的主流程清爽）；
 * 用户点「查看全部批次」后才显示分页器，用后端已有的 `page/pageSize` 翻历史批次。
 */
const batchPagination = computed(() => {
  if (!props.showAllBatches) {
    return false as const;
  }
  return {
    current: props.batchPage,
    onChange: (page: number) => emit('pageChange', page),
    pageSize: BATCH_PAGE_SIZE,
    showSizeChanger: false,
    total: props.batchesTotal,
  };
});
</script>

<template>
  <!--
    🔴 失败态**挂在表格之外**（不是只放 Empty 槽里）：真实表格只在没有行时渲染 Empty 槽 ⇒
    已有数据后刷新失败时旧行仍在、槽不渲染 ⇒ 失败提示看不见，页面会继续展示过期数据。
  -->
  <Alert
    v-if="props.listError"
    class="mb-2"
    :description="props.listError"
    :message="$t('page.iot.device.import.batchListLoadFailed')"
    show-icon
    type="error"
  />

  <!--
    批次列表分页：默认只拉最近一页（BATCH_PAGE_SIZE），数量更多时给「查看全部批次」入口。
    🔴 历史上硬编码 `getDeviceImportBatchPage(1, 20)` ⇒ 第 21 个及更早的历史批次
    永远**不可达**（看不到也下载不了失败行），失败行重传闭环对历史批次是断的。
  -->
  <div
    v-if="!props.listError && props.batchesTotal > 0"
    class="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
  >
    <span data-testid="import-batch-total">
      {{
        $t('page.iot.device.import.batchListTotal', [
          String(props.batchesTotal),
        ])
      }}
    </span>
    <Button
      v-if="!props.showAllBatches && props.batchesTotal > BATCH_PAGE_SIZE"
      data-testid="import-all-batches"
      size="small"
      type="link"
      @click="emit('showAll')"
    >
      {{ $t('page.iot.device.import.allBatches') }}
    </Button>
  </div>

  <Table
    :columns="batchColumns"
    :data-source="props.batches"
    :loading="listState === 'loading'"
    :pagination="batchPagination"
    :row-class-name="
      (record: IotDeviceImportApi.BatchResp) =>
        record.id === props.selectedBatchId
          ? 'cursor-pointer bg-primary/10'
          : 'cursor-pointer'
    "
    :scroll="{ y: 160 }"
    row-key="id"
    size="small"
    :custom-row="
      (record: IotDeviceImportApi.BatchResp) => ({
        onClick: () => emit('select', record),
      })
    "
  >
    <template #bodyCell="{ column, record }">
      <template v-if="column.dataIndex === 'batchStatus'">
        <Tag :color="batchStatusColor(record.batchStatus)">
          {{ $t(batchStatusLabelKey(record.batchStatus)) }}
        </Tag>
      </template>
      <template v-else-if="column.dataIndex === 'createTime'">
        {{ formatDateTime(record.createTime) }}
      </template>
    </template>
    <!-- 🔴 失败不伪装成空态：`listError` 非空时这里**不渲染** Empty（失败态由上方的 Alert 承担） -->
    <template #emptyText>
      <Empty
        v-if="listState === 'empty'"
        :description="$t('page.iot.device.import.batchEmpty')"
      />
    </template>
  </Table>
</template>
