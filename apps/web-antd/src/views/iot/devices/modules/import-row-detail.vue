<script lang="ts" setup>
import type { ImportListState } from './import-state';

import type { IotDeviceImportApi } from '#/api/iot';

import { computed } from 'vue';

import {
  Alert,
  Button,
  Empty,
  message,
  Space,
  Table,
  Tag,
} from 'ant-design-vue';

import { downloadDeviceImportFailedCsv } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';
import { downloadBlobSafe } from '#/utils/file';

import { EMPTY_TEXT } from '../../shared/display';
import {
  DETAIL_ROWS_PAGE_SIZE,
  IMPORT_ROW_RESULT,
  resolveImportListState,
  rowResultLabelKey,
} from './import-state';

/**
 * 批量导入「明细表」组件（审查 P2-10 / 批次 6-B 拆分之一）。
 *
 * 职责：明细表 + 结果筛选按钮 + 「下载失败行」入口 + 分页器 + 失败/空态。
 * **加载与页码编排仍归宿主**：`loadRows`/`detailPageReset`（空页自动回第 1 页）依赖
 * 「切批次/切筛选/刷新」这些跨面板动作，放在这里会变成第二处状态源。
 */
const props = defineProps<{
  /** 当前批次 id（失败行 CSV 由后端按批次生成；为空时不发请求）。 */
  batchId?: string;
  /**
   * 当前批次是否有失败行（决定「下载失败行」按钮是否出现）。
   */
  canDownloadFailed: boolean;
  /** 结果筛选：空 = 全部，否则 success / failed。 */
  rowFilter: '' | 'failed' | 'success';
  /** 当前页明细行。 */
  rows: IotDeviceImportApi.RowResp[];
  /** 加载失败的可见原因（失败不伪装成空态）。 */
  rowsError: string;
  /** 明细加载态。 */
  rowsLoading: boolean;
  /** 当前页码（1-based；**不再恒写死 1**）。 */
  rowsPage: number;
  /** 明细总条数（后端分页 total，已转 number）。 */
  rowsTotal: number;
}>();

const emit = defineEmits<{
  (e: 'filterChange', filter: '' | 'failed' | 'success'): void;
  (e: 'pageChange', page: number): void;
}>();

/**
 * 下载当前批次的失败行 CSV。
 *
 * 由**后端**生成整份文件（含全部失败行，不受前端分页影响）——前端只加载了当前页，
 * 自己拼 CSV 会漏掉没加载到的失败行，那是「以为改完这些就好了」的静默错误。
 */
async function onDownloadFailed() {
  const batchId = props.batchId;
  if (!batchId) {
    return;
  }
  try {
    const blob = await downloadDeviceImportFailedCsv(batchId);
    await downloadBlobSafe(
      blob,
      `device-import-failed-${batchId}.csv`,
      $t('page.iot.device.import.failedDownloadFailed'),
    );
  } catch (error) {
    message.error(
      extractErrorMessage(
        error,
        $t('page.iot.device.import.failedDownloadFailed'),
      ),
    );
  }
}

/** 明细表状态（与批次列表同一套「失败优先于空」的判据）。 */
const rowsState = computed<ImportListState>(() =>
  resolveImportListState(props.rowsLoading, props.rowsError, props.rows.length),
);

/** 明细表格列（错误码/错误信息两列是「照着改」的全部依据）。 */
const rowColumns = [
  { title: $t('page.iot.device.import.rowNo'), dataIndex: 'rowNo', width: 80 },
  {
    title: $t('page.iot.device.import.deviceCode'),
    dataIndex: 'deviceCode',
    width: 160,
  },
  {
    title: $t('page.iot.device.import.rowResult'),
    dataIndex: 'rowResult',
    width: 90,
  },
  {
    title: $t('page.iot.device.import.errorCode'),
    dataIndex: 'errorCode',
    width: 200,
  },
  {
    title: $t('page.iot.device.import.errorMessage'),
    dataIndex: 'errorMessage',
  },
];
</script>

<template>
  <div class="mt-3 mb-2 flex items-center justify-between">
    <span class="text-sm font-medium">
      {{ $t('page.iot.device.import.rowDetail') }}
    </span>
    <Space>
      <Button
        :type="props.rowFilter === '' ? 'primary' : 'default'"
        size="small"
        @click="emit('filterChange', '')"
      >
        {{ $t('page.iot.device.import.filterAll') }}
      </Button>
      <Button
        :type="props.rowFilter === 'success' ? 'primary' : 'default'"
        size="small"
        @click="emit('filterChange', 'success')"
      >
        {{ $t('page.iot.device.import.filterSuccess') }}
      </Button>
      <Button
        :danger="props.rowFilter === 'failed'"
        :type="props.rowFilter === 'failed' ? 'primary' : 'default'"
        size="small"
        @click="emit('filterChange', 'failed')"
      >
        {{ $t('page.iot.device.import.filterFailed') }}
      </Button>
      <!-- 失败行由**后端**生成整份文件（不受前端分页影响），入口放在明细区最相关 -->
      <Button
        v-if="props.canDownloadFailed"
        danger
        size="small"
        type="primary"
        @click="onDownloadFailed"
      >
        {{ $t('page.iot.device.import.downloadFailed') }}
      </Button>
    </Space>
  </div>

  <Alert
    v-if="props.rowsError"
    class="mb-2"
    :description="props.rowsError"
    :message="$t('page.iot.device.import.rowListLoadFailed')"
    show-icon
    type="error"
  />

  <Table
    :columns="rowColumns"
    :data-source="props.rows"
    :loading="rowsState === 'loading'"
    :pagination="{
      current: props.rowsPage,
      pageSize: DETAIL_ROWS_PAGE_SIZE,
      total: props.rowsTotal,
      showSizeChanger: false,
      onChange: (page: number) => emit('pageChange', page),
    }"
    :scroll="{ y: 220 }"
    row-key="id"
    size="small"
  >
    <template #bodyCell="{ column, record }">
      <template v-if="column.dataIndex === 'rowResult'">
        <Tag
          :color="
            record.rowResult === IMPORT_ROW_RESULT.SUCCESS ? 'success' : 'error'
          "
        >
          {{ $t(rowResultLabelKey(record.rowResult)) }}
        </Tag>
      </template>
      <template v-else-if="column.dataIndex === 'errorCode'">
        <span v-if="record.errorCode">{{ record.errorCode }}</span>
        <span v-else class="text-muted-foreground">{{ EMPTY_TEXT }}</span>
      </template>
      <template v-else-if="column.dataIndex === 'errorMessage'">
        <span v-if="record.errorMessage">{{ record.errorMessage }}</span>
        <span v-else class="text-muted-foreground">{{ EMPTY_TEXT }}</span>
      </template>
    </template>
    <template #emptyText>
      <Empty
        v-if="rowsState === 'empty'"
        :description="$t('page.iot.device.import.rowEmpty')"
      />
    </template>
  </Table>
</template>
