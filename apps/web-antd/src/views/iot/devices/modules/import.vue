<script lang="ts" setup>
import type { UploadProps } from 'ant-design-vue';

import type { ImportListState } from './import-state';

import type { IotDeviceImportApi } from '#/api/iot';

import { computed, onMounted, ref } from 'vue';

import {
  Alert,
  Button,
  Empty,
  message,
  Progress,
  Space,
  Steps,
  Table,
  Tag,
  Upload,
} from 'ant-design-vue';

import {
  DEVICE_IMPORT_FRONTEND_LIMITS,
  downloadDeviceImportFailedCsv,
  downloadDeviceImportTemplate,
  getDeviceImportBatchDetail,
  getDeviceImportBatchPage,
  importDevicesCsv,
} from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';
import { downloadBlobSafe } from '#/utils/file';

import {
  batchStatusColor,
  batchStatusLabelKey,
  checkImportFile,
  formatFileSize,
  hasFailedRows,
  IMPORT_ROW_RESULT,
  resolveImportListState,
  rowResultLabelKey,
  sortBatchesByRecent,
} from './import-state';

/**
 * 批量导入抽屉（看板 #7）——**傻瓜式三步**：下载模板 → 上传 → 看结果。
 *
 * 设计原则（用户的「不需要读文档」）：
 * 1. **每步都有下一步的入口**：模板一键下载（第 1 步的按钮就在第 1 步里）、
 *    选完文件立刻上传（不需要再找「提交」）、结果页直接给「下载失败行」；
 * 2. **失败行闭环**：失败行 CSV 由**后端**生成（前端只加载了当前页，自己拼会漏行），
 *    文件里带 errorCode/errorMessage 两列且首行写明「删掉最后两列即可重传」；
 * 3. **失败态与空态严格分离**：列表加载失败时显示 Alert（挂在表格之外），
 *    空态才显示「还没有导入过」；两者绝不互相伪装。
 *
 * 权限：读（批次/明细/失败行）`iot:device:list`，上传 `iot:device:import`
 * （入口按钮由父页面按 `iot:device:import` 门禁，这里不再重复判——重复判会让
 * 「按钮能点但里面全被摘掉」这种更差的体验出现）。
 */

/** 步骤索引：0 下载模板 → 1 上传 → 2 看结果。 */
const currentStep = ref(0);

/** 批次列表（最近在前）。 */
const batches = ref<IotDeviceImportApi.BatchResp[]>([]);

/** 批次列表加载态。 */
const listLoading = ref(false);

/**
 * 批次列表**加载失败**的原因（非空即失败）。
 *
 * 🔴 必须有它：请求失败与「确实没有批次」在表格里长得一模一样。只挂一个 Empty 就是
 * 把失败画成「还没有导入过，去下载模板吧」——用户会照着做一个本来不需要的动作。
 */
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

/** 上传中标记（防重复提交：重复上传同一份文件会建出两个批次）。 */
const uploading = ref(false);

/** 前端校验失败原因（类型/大小），渲染在步骤 2 的 Alert 里。 */
const fileCheckError = ref('');

/** 上传后由**后端**给出的批次结论（即使整批被拒也有值 ⇒ 必须展示成批次记录）。 */
const lastResult = ref<IotDeviceImportApi.BatchResp | null>(null);

/** 上传结束后由前端补的一句「下一步做什么」（后端不管 UI 引导）。 */
const lastHint = ref('');

/**
 * 批次列表状态（三分：加载中 / 失败 / 空 / 就绪）。
 *
 * 用纯函数判定而不是在模板里写 `v-if="!loading && !error && list.length === 0"`：
 * 模板里的三元表达式无法被用例覆盖，而「失败不能画成空态」是本仓踩过的坑。
 */
const listState = computed<ImportListState>(() =>
  resolveImportListState(
    listLoading.value,
    listError.value,
    batches.value.length,
  ),
);

/** 明细表状态（同一套判定，保证两个面板的行为一致）。 */
const rowsState = computed<ImportListState>(() =>
  resolveImportListState(rowsLoading.value, rowsError.value, rows.value.length),
);

/** 当前批次是否值得显示「下载失败行」（按失败计数判，而不是按状态码）。 */
const canDownloadFailed = computed(() =>
  hasFailedRows(selectedBatch.value?.failedRows),
);

/**
 * 成功率的进度条取值。
 *
 * 分母为 0（整批被拒/空文件）时返回 0 而不是 NaN —— `NaN%` 会让用户以为页面坏了。
 */
const successRate = computed(() => {
  const total = Number(selectedBatch.value?.totalRows ?? 0);
  const success = Number(selectedBatch.value?.successRows ?? 0);
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.round((success / total) * 100);
});

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

/**
 * 拉取批次列表（最近在前）。
 *
 * 失败时**记下原因并清空列表**（不是留着旧数据）：留着旧数据会让用户以为
 * 「刷新后还是这些」，而实际上这次根本没查到。
 */
async function loadBatches() {
  listLoading.value = true;
  try {
    const result = await getDeviceImportBatchPage(1, 20);
    batches.value = sortBatchesByRecent(result.items ?? []);
    listError.value = '';
  } catch (error) {
    batches.value = [];
    listError.value = extractErrorMessage(
      error,
      $t('page.iot.device.import.batchListLoadFailed'),
    );
  } finally {
    listLoading.value = false;
  }
}

/**
 * 拉取某批次的明细（当前页 + 当前筛选）。
 *
 * @param batchId 批次 ID
 * @param page    页码（从 1 开始）
 */
async function loadRows(batchId: string, page = 1) {
  rowsLoading.value = true;
  try {
    const detail = await getDeviceImportBatchDetail(batchId, {
      page,
      pageSize: 20,
      ...(rowFilter.value ? { rowResult: rowFilter.value } : {}),
    });
    selectedBatch.value = detail.batch;
    rows.value = detail.rows?.items ?? [];
    rowsTotal.value = toBackendNumber(detail.rows?.total ?? 0);
    rowsError.value = '';
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

/** 第 1 步：下载模板（一键；文件名与后端 Content-Disposition 无关，前端给友好名）。 */
async function onDownloadTemplate() {
  try {
    const blob = await downloadDeviceImportTemplate();
    await downloadBlobSafe(
      blob,
      'device-import-template.csv',
      $t('page.iot.device.import.templateDownloadFailed'),
    );
    // 下载即进入第 2 步：用户此刻手上就有模板了，下一步显然是上传
    currentStep.value = 1;
  } catch (error) {
    // 原样展示后端 message（全局拦截器也会弹一次，这里给出「这次没下成」的明确结论）
    message.error(
      extractErrorMessage(
        error,
        $t('page.iot.device.import.templateDownloadFailed'),
      ),
    );
  }
}

/** 打开抽屉时拉一次批次列表（看结果面板的初始数据）。 */
function onOpen() {
  void loadBatches();
}

/**
 * 上传前的拦截（antd Upload 的 `beforeUpload`）。
 *
 * 返回 `false` 表示**不上传**（交给我们的 `customRequest` 之外的路径）；
 * 这里用 `false` + 手动上传：避免 antd 自己发一次请求、我们又发一次（同一份文件建两个批次）。
 *
 * @param file 选中的文件
 * @returns 是否允许进入上传流程
 */
const beforeUpload: UploadProps['beforeUpload'] = (file) => {
  fileCheckError.value = '';
  lastResult.value = null;
  lastHint.value = '';
  const check = checkImportFile(file as unknown as File);
  if (!check.ok) {
    // 前端校验失败**不弹 toast**：留在页面上的 Alert 更持久，用户改完能对照着看
    fileCheckError.value = check.message;
    return false;
  }
  void doUpload(file as unknown as File);
  return false;
};

/**
 * 真正执行上传（前端校验通过后才走到这里）。
 *
 * 后端恒返回 HTTP 200 + 批次信息（含整批被拒的情形）⇒ 这里**必然**拿到一个批次记录，
 * 把它展示出来并进入第 3 步；只有网络/权限类错误才走 catch。
 *
 * @param file CSV 文件
 */
async function doUpload(file: File) {
  if (uploading.value) {
    return;
  }
  uploading.value = true;
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
    await loadBatches();
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

/**
 * 下载当前批次的失败行 CSV。
 *
 * 由**后端**生成整份文件（含全部失败行，不受前端分页影响）。
 */
async function onDownloadFailed() {
  const batchId = selectedBatch.value?.id;
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

/** 刷新按钮：批次列表 + 当前批次明细一起刷（只刷一个会让两处数字对不上）。 */
async function onRefresh() {
  await loadBatches();
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
    <!--
      三步向导。刻意用 antd Steps 而不是自己画：用户对「1-2-3」的形态有直觉，
      而每一步的按钮就长在那一步下面 —— 不需要读文档就知道下一步做什么。
    -->
    <Steps
      :current="currentStep"
      :items="[
        { title: $t('page.iot.device.import.stepTemplate') },
        { title: $t('page.iot.device.import.stepUpload') },
        { title: $t('page.iot.device.import.stepResult') },
      ]"
      size="small"
    />

    <!-- 第 1 步：下载模板 -->
    <div class="rounded border border-solid border-gray-200 p-3">
      <div class="mb-2 text-sm font-medium">
        {{ $t('page.iot.device.import.stepTemplate') }}
      </div>
      <div class="mb-2 text-xs text-gray-500">
        {{
          $t('page.iot.device.import.templateHint', [
            DEVICE_IMPORT_FRONTEND_LIMITS.maxRows,
            formatFileSize(DEVICE_IMPORT_FRONTEND_LIMITS.maxBytes),
          ])
        }}
      </div>
      <Button type="primary" @click="onDownloadTemplate">
        {{ $t('page.iot.device.import.downloadTemplate') }}
      </Button>
    </div>

    <!-- 第 2 步：上传 -->
    <div class="rounded border border-solid border-gray-200 p-3">
      <div class="mb-2 text-sm font-medium">
        {{ $t('page.iot.device.import.stepUpload') }}
      </div>
      <!--
        🔴 前端校验失败用 Alert 而不是 toast：toast 转瞬即逝，用户错过之后
        页面上什么都不剩（不知道刚才为什么没反应）。Alert 留在页面上可对照修改。
      -->
      <Alert
        v-if="fileCheckError"
        class="mb-2"
        :message="$t('page.iot.device.import.uploadRejected')"
        :description="fileCheckError"
        show-icon
        type="error"
      />
      <Upload
        accept=".csv,.txt"
        :before-upload="beforeUpload"
        :disabled="uploading"
        :file-list="[]"
        :show-upload-list="false"
      >
        <Button :loading="uploading">
          {{ $t('page.iot.device.import.selectFile') }}
        </Button>
      </Upload>
      <div class="mt-2 text-xs text-gray-500">
        {{ $t('page.iot.device.import.uploadHint') }}
      </div>
    </div>

    <!-- 第 3 步：看结果 + 拿走失败行 -->
    <div
      class="flex min-h-0 flex-1 flex-col rounded border border-solid border-gray-200 p-3"
    >
      <div class="mb-2 flex items-center justify-between">
        <span class="text-sm font-medium">
          {{ $t('page.iot.device.import.stepResult') }}
        </span>
        <Space>
          <Button size="small" @click="onRefresh">
            {{ $t('common.refresh') }}
          </Button>
          <Button
            v-if="canDownloadFailed"
            danger
            size="small"
            type="primary"
            @click="onDownloadFailed"
          >
            {{ $t('page.iot.device.import.downloadFailed') }}
          </Button>
        </Space>
      </div>

      <!-- 刚上传完的一句「下一步做什么」：后端不管 UI 引导，这一句必须由页面给 -->
      <Alert
        v-if="lastResult"
        class="mb-2"
        :description="lastResult.errorSummary || ''"
        :message="lastHint"
        :type="hasFailedRows(lastResult.failedRows) ? 'warning' : 'info'"
        show-icon
      />

      <div v-if="lastResult" class="mb-2">
        <Progress
          :percent="successRate"
          :status="
            hasFailedRows(lastResult.failedRows) ? 'exception' : 'success'
          "
        />
        <div class="text-xs text-gray-500">
          {{
            $t('page.iot.device.import.countSummary', [
              lastResult.totalRows ?? 0,
              lastResult.successRows ?? 0,
              lastResult.failedRows ?? 0,
            ])
          }}
        </div>
      </div>

      <!--
        🔴 批次列表的失败态**挂在表格之外**（不是只放 Empty 槽里）：
        真实表格只在没有行时渲染 Empty 槽 ⇒ 已有数据后刷新失败时旧行仍在、槽不渲染 ⇒
        失败提示看不见，页面会继续展示过期数据。放在表格上方则任何一次失败都可见。
      -->
      <Alert
        v-if="listError"
        class="mb-2"
        :description="listError"
        :message="$t('page.iot.device.import.batchListLoadFailed')"
        show-icon
        type="error"
      />

      <Table
        :columns="batchColumns"
        :data-source="batches"
        :loading="listState === 'loading'"
        :pagination="false"
        :row-class-name="
          (record: IotDeviceImportApi.BatchResp) =>
            record.id === selectedBatch?.id
              ? 'bg-blue-50 cursor-pointer'
              : 'cursor-pointer'
        "
        :scroll="{ y: 160 }"
        row-key="id"
        size="small"
        @row-click="
          (record: IotDeviceImportApi.BatchResp) => onSelectBatch(record)
        "
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.dataIndex === 'batchStatus'">
            <Tag :color="batchStatusColor(record.batchStatus)">
              {{ $t(batchStatusLabelKey(record.batchStatus)) }}
            </Tag>
          </template>
          <template v-else-if="column.dataIndex === 'createTime'">
            {{ record.createTime || '-' }}
          </template>
        </template>
        <!--
          🔴 失败不伪装成空态：`listError` 非空时这里**不渲染** Empty（失败态由上方的 Alert 承担）
        -->
        <template #emptyText>
          <Empty
            v-if="listState === 'empty'"
            :description="$t('page.iot.device.import.batchEmpty')"
          />
        </template>
      </Table>

      <div class="mt-3 mb-2 flex items-center justify-between">
        <span class="text-sm font-medium">
          {{ $t('page.iot.device.import.rowDetail') }}
        </span>
        <Space>
          <Button
            :type="rowFilter === '' ? 'primary' : 'default'"
            size="small"
            @click="onFilterChange('')"
          >
            {{ $t('page.iot.device.import.filterAll') }}
          </Button>
          <Button
            :type="rowFilter === 'success' ? 'primary' : 'default'"
            size="small"
            @click="onFilterChange('success')"
          >
            {{ $t('page.iot.device.import.filterSuccess') }}
          </Button>
          <Button
            :danger="rowFilter === 'failed'"
            :type="rowFilter === 'failed' ? 'primary' : 'default'"
            size="small"
            @click="onFilterChange('failed')"
          >
            {{ $t('page.iot.device.import.filterFailed') }}
          </Button>
        </Space>
      </div>

      <Alert
        v-if="rowsError"
        class="mb-2"
        :description="rowsError"
        :message="$t('page.iot.device.import.rowListLoadFailed')"
        show-icon
        type="error"
      />

      <Table
        :columns="rowColumns"
        :data-source="rows"
        :loading="rowsState === 'loading'"
        :pagination="{
          current: 1,
          pageSize: 20,
          total: rowsTotal,
          showSizeChanger: false,
          onChange: onRowsPageChange,
        }"
        :scroll="{ y: 220 }"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.dataIndex === 'rowResult'">
            <Tag
              :color="
                record.rowResult === IMPORT_ROW_RESULT.SUCCESS
                  ? 'success'
                  : 'error'
              "
            >
              {{ $t(rowResultLabelKey(record.rowResult)) }}
            </Tag>
          </template>
          <template v-else-if="column.dataIndex === 'errorCode'">
            <span v-if="record.errorCode">{{ record.errorCode }}</span>
            <span v-else class="text-gray-400">-</span>
          </template>
          <template v-else-if="column.dataIndex === 'errorMessage'">
            <span v-if="record.errorMessage">{{ record.errorMessage }}</span>
            <span v-else class="text-gray-400">-</span>
          </template>
        </template>
        <template #emptyText>
          <Empty
            v-if="rowsState === 'empty'"
            :description="$t('page.iot.device.import.rowEmpty')"
          />
        </template>
      </Table>
    </div>
  </div>
</template>
