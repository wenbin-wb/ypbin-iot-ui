<script lang="ts" setup>
import type { IotDeviceImportApi } from '#/api/iot';

import { computed, onMounted, ref } from 'vue';

import { Button, message, Steps } from 'ant-design-vue';

import {
  getDeviceImportBatchDetail,
  getDeviceImportBatchPage,
  importDevicesCsv,
} from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import ImportBatchList from './import-batch-list.vue';
import ImportRowDetail from './import-row-detail.vue';
import {
  BATCH_PAGE_SIZE,
  DETAIL_ROWS_PAGE_SIZE,
  hasFailedRows,
  resolveBatchPageAfterEmpty,
  resolveDetailPageAfterEmpty,
  sortBatchesByRecent,
} from './import-state';
import ImportUploadStep from './import-upload-step.vue';

/**
 * 批量导入抽屉（**宿主/编排层**，审查 P2-10 / 批次 6-B 拆分后）。
 *
 * 三步向导（下载模板 → 上传 → 看结果）只保留**编排**，展示拆到三个子组件：
 * `import-upload-step`（模板/校验/上传/上传结果）、`import-batch-list`（批次表+分页）、
 * `import-row-detail`（明细表+筛选+失败行下载）。
 *
 * 本文件负责（都是「跨面板」的事，放子组件会变成第二处状态源）：
 * 1. **Steps 状态机**：下载模板成功进第 2 步、上传成功进第 3 步；
 * 2. **批次分页/越界回退 + 选中批次后加载明细 + 刷新时两者一起刷**；
 * 3. **明细页码与 `detailPageReset`**：切批次/切筛选回第 1 页，空页自动回第 1 页并提示；
 * 4. **上传编排**：成功后回第 1 页展示刚传的批次并选中它。
 *
 * 权限：读（批次/明细/失败行）`iot:device:list`，上传 `iot:device:import`
 * （入口按钮由父页面按该权限码门禁，这里不再重复判——重复判会出现「按钮能点但里面全被摘掉」）。
 */

const currentStep = ref(0); // 0 下载模板 → 1 上传 → 2 看结果

/** 批次列表（最近在前）。 */
const batches = ref<IotDeviceImportApi.BatchResp[]>([]);

/** 批次列表加载态。 */
const listLoading = ref(false);

/** 批次列表加载失败原因（非空即失败）——「失败 vs 空态」的判据，详见 `import-batch-list.vue`。 */
const listError = ref('');

/** 当前选中的批次（看结果面板的数据源）。 */
const selectedBatch = ref<IotDeviceImportApi.BatchResp | null>(null);

/** 当前批次的明细（当前页）。 */
const rows = ref<IotDeviceImportApi.RowResp[]>([]);

/** 明细总条数（后端 `PageResult.total`，字符串形态 ⇒ 过 `toBackendNumber`）。 */
const rowsTotal = ref(0);

/** 明细加载态与失败原因（与批次列表同一套「失败优先于空」的防线）。 */
const rowsLoading = ref(false);

const rowsError = ref('');

/** 明细结果筛选：空 = 全部，否则 success / failed。 */
const rowFilter = ref<'' | 'failed' | 'success'>('');

/** 批次列表当前页与总批次数（后端分页字段；硬编码只取第 1 页会让历史批次不可达）。 */
const batchPage = ref(1);
const batchesTotal = ref(0);

/** 是否进入「查看全部批次」模式：默认只拉最近一页，用户明确要翻历史时才显示分页器。 */
const showAllBatches = ref(false);

/** 明细当前页码（**不恒写死 1**：页码与请求必须同步，否则翻页后数据与页码对不上）。 */
const rowsPage = ref(1);

/** 上传中标记（防重复提交：重复上传同一份文件会建出两个批次）。 */
const uploading = ref(false);

/** 上传失败原因（前端校验失败由上传组件自己展示；这里是网络/权限/后端错误）。 */
const fileCheckError = ref('');

/** 上传后由**后端**给出的批次结论（即使整批被拒也有值 ⇒ 必须展示成批次记录）。 */
const lastResult = ref<IotDeviceImportApi.BatchResp | null>(null);

/** 上传结束后由前端补的一句「下一步做什么」（后端不管 UI 引导）。 */
const lastHint = ref('');

/** 当前批次是否值得显示「下载失败行」（按失败计数判，而不是按状态码）。 */
const canDownloadFailed = computed(() =>
  hasFailedRows(selectedBatch.value?.failedRows),
);

/**
 * 拉取批次列表（最近在前，分页）。失败时**清空列表并记原因**：留着旧数据会让用户以为
 * 「刷新后还是这些」，而实际上这次根本没查到。
 *
 * @param page 页码（1-based；默认当前页，避免刷新把用户踢回第 1 页）
 */
async function loadBatches(page = batchPage.value) {
  listLoading.value = true;
  try {
    const result = await getDeviceImportBatchPage(page, BATCH_PAGE_SIZE);
    batches.value = sortBatchesByRecent(result.items ?? []);
    batchesTotal.value = toBackendNumber(result.total ?? 0);
    batchPage.value = page;
    listError.value = '';
    // 越界页兜底（批次被清理/总数变少）：退到仍有数据的最后一页，别把空页画成「还没有导入过」
    const corrected = resolveBatchPageAfterEmpty(
      batches.value.length,
      batchesTotal.value,
      page,
      BATCH_PAGE_SIZE,
    );
    if (corrected > 0 && corrected !== page) {
      await loadBatches(corrected);
    }
  } catch (error) {
    batches.value = [];
    batchesTotal.value = 0;
    listError.value = extractErrorMessage(
      error,
      $t('page.iot.device.import.batchListLoadFailed'),
    );
  } finally {
    listLoading.value = false;
  }
}

/** 批次列表翻页（仅在「查看全部批次」模式下可用）。 */
function onBatchPageChange(page: number) {
  void loadBatches(page);
}

/** 进入「查看全部批次」模式（显示分页器，可翻到更早的历史批次）。 */
function onShowAllBatches() {
  showAllBatches.value = true;
}

/**
 * 拉取某批次的明细（当前页 + 当前筛选）。
 *
 * @param batchId 批次 ID
 * @param page    页码（从 1 开始）
 * @param options.allowPageReset 是否允许「空页自动回第 1 页」（递归时置 false 防死循环）
 */
async function loadRows(
  batchId: string,
  page = 1,
  options: { allowPageReset?: boolean } = {},
) {
  rowsLoading.value = true;
  try {
    const detail = await getDeviceImportBatchDetail(batchId, {
      page,
      pageSize: DETAIL_ROWS_PAGE_SIZE,
      ...(rowFilter.value ? { rowResult: rowFilter.value } : {}),
    });
    selectedBatch.value = detail.batch;
    rows.value = detail.rows?.items ?? [];
    rowsTotal.value = toBackendNumber(detail.rows?.total ?? 0);
    rowsPage.value = page;
    rowsError.value = '';
    // 空页 ≠ 这一批没有明细：页码越界（数据变少/被删）时回第 1 页并明确告知
    const corrected = resolveDetailPageAfterEmpty(rows.value.length, page);
    if (options.allowPageReset !== false && corrected > 0) {
      message.info($t('page.iot.device.import.detailPageReset'));
      await loadRows(batchId, corrected, { allowPageReset: false });
    }
  } catch (error) {
    rows.value = [];
    rowsTotal.value = 0;
    rowsError.value = extractErrorMessage(
      error,
      $t('page.iot.device.import.rowListLoadFailed'),
    );
  } finally {
    rowsLoading.value = false;
  }
}

/** 选中一个批次并加载它的明细（点行即选中）。 */
function onSelectBatch(batch: IotDeviceImportApi.BatchResp) {
  selectedBatch.value = batch;
  rowFilter.value = '';
  void loadRows(batch.id, 1);
}

/** 切换明细筛选（成功后回到第 1 页：筛完还停在旧页码会看到空页）。 */
function onFilterChange(filter: '' | 'failed' | 'success') {
  rowFilter.value = filter;
  if (selectedBatch.value) {
    void loadRows(selectedBatch.value.id, 1);
  }
}

/**
 * 明细分页变化。
 *
 * @param page 页码
 */
function onRowsPageChange(page: number) {
  if (selectedBatch.value) {
    void loadRows(selectedBatch.value.id, page);
  }
}

/** 模板下载成功 ⇒ 推进到第 2 步（下载动作本身在 `ImportUploadStep` 内）。 */
function onTemplateDownloaded() {
  currentStep.value = 1;
}

/** 打开抽屉时拉一次批次列表（看结果面板的初始数据）。 */
function onOpen() {
  void loadBatches(showAllBatches.value ? batchPage.value : 1);
}

/**
 * 执行上传（校验在 `ImportUploadStep` 内完成）。后端恒返回 HTTP 200 + 批次信息
 * （含整批被拒）⇒ 必然拿到批次记录：展示它并进第 3 步；只有网络/权限类错误走 catch。
 *
 * @param file CSV 文件
 */
async function doUpload(file: File) {
  if (uploading.value) {
    return;
  }
  uploading.value = true;
  fileCheckError.value = '';
  lastResult.value = null;
  lastHint.value = '';
  try {
    const batch = await importDevicesCsv(file);
    lastResult.value = batch;
    currentStep.value = 2;
    if (hasFailedRows(batch.failedRows)) {
      lastHint.value = $t('page.iot.device.import.hintDownloadFailed');
    } else if (batch.batchStatus === 'success') {
      lastHint.value = $t('page.iot.device.import.hintAllSuccess');
    } else {
      lastHint.value = $t('page.iot.device.import.hintBatchRejected');
    }
    // 刚上传的批次是最新的 ⇒ 回到第 1 页展示它（否则用户看不到自己刚传的那一条）
    showAllBatches.value = false;
    await loadBatches(1);
    selectedBatch.value = batch;
    rowFilter.value = '';
    await loadRows(batch.id, 1);
  } catch (error) {
    // 网络/权限类错误：原样展示后端 message
    fileCheckError.value = extractErrorMessage(
      error,
      $t('page.iot.device.import.uploadFailed'),
    );
  } finally {
    uploading.value = false;
  }
}

/** 刷新按钮：批次列表 + 当前批次明细一起刷（只刷一个会让两处数字对不上）。 */
async function onRefresh() {
  // 批次列表停在用户当前页（不把正在翻历史的人踢回第 1 页）；明细回到第 1 页
  await loadBatches(showAllBatches.value ? batchPage.value : 1);
  if (selectedBatch.value) {
    await loadRows(selectedBatch.value.id, 1);
  }
}

// 抽屉内容挂载时拉一次批次列表：用户点开入口时想看的正是「我以前传过什么、结果如何」，
// 而不是一个空面板等着他去上传。
onMounted(() => {
  void loadBatches();
});
defineExpose({ onOpen });
</script>

<template>
  <div class="flex h-full flex-col gap-3">
    <!-- 三步向导：用 antd Steps（用户对「1-2-3」有直觉），每步按钮长在那一步下面 -->
    <Steps
      :current="currentStep"
      :items="[
        { title: $t('page.iot.device.import.stepTemplate') },
        { title: $t('page.iot.device.import.stepUpload') },
        { title: $t('page.iot.device.import.stepResult') },
      ]"
      size="small"
    />

    <!-- 第 1/2 步 + 上传结果（下载模板、文件校验、上传、后端结论与计数） -->
    <ImportUploadStep
      :last-hint="lastHint"
      :last-result="lastResult"
      :upload-error="fileCheckError"
      :uploading="uploading"
      @template-downloaded="onTemplateDownloaded"
      @upload="doUpload"
    />

    <!-- 第 3 步：看结果 + 拿走失败行 -->
    <div
      class="flex min-h-0 flex-1 flex-col rounded border border-solid border-border p-3"
    >
      <div class="mb-2 flex items-center justify-between">
        <span class="text-sm font-medium">
          {{ $t('page.iot.device.import.stepResult') }}
        </span>
        <Button size="small" @click="onRefresh">
          {{ $t('common.refresh') }}
        </Button>
      </div>

      <!-- 批次列表（加载/页码/失败态在宿主） -->
      <ImportBatchList
        :batch-page="batchPage"
        :batches="batches"
        :batches-total="batchesTotal"
        :list-error="listError"
        :list-loading="listLoading"
        :selected-batch-id="selectedBatch?.id"
        :show-all-batches="showAllBatches"
        @page-change="onBatchPageChange"
        @select="onSelectBatch"
        @show-all="onShowAllBatches"
      />

      <!-- 明细表（筛选/失败行下载在组件，页码与 detailPageReset 在宿主） -->
      <ImportRowDetail
        :batch-id="selectedBatch?.id"
        :can-download-failed="canDownloadFailed"
        :row-filter="rowFilter"
        :rows="rows"
        :rows-error="rowsError"
        :rows-loading="rowsLoading"
        :rows-page="rowsPage"
        :rows-total="rowsTotal"
        @filter-change="onFilterChange"
        @page-change="onRowsPageChange"
      />
    </div>
  </div>
</template>
