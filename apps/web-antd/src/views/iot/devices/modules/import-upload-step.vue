<script lang="ts" setup>
import type { UploadProps } from 'ant-design-vue';

import type { IotDeviceImportApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { Alert, Button, message, Progress, Upload } from 'ant-design-vue';

import {
  DEVICE_IMPORT_FRONTEND_LIMITS,
  downloadDeviceImportTemplate,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';
import { downloadBlobSafe } from '#/utils/file';

import {
  checkImportFile,
  formatFileSize,
  hasFailedRows,
  resolveImportFileCheckMessage,
} from './import-state';

/**
 * 批量导入「第 1 步：下载模板」+「第 2 步：上传」+「上传结果」展示组件。
 *
 * 从 `import.vue` 抽出（审查 P2-10 / 批次 6-B）：
 * - **只做展示 + 纯前端文件校验**，不持有向导状态机（步骤由宿主 `Steps` 驱动）；
 * - 校验失败用 Alert 常驻在页面上（不是转瞬即逝的 toast），用户可对照修改；
 * - 校验通过后 `emit('upload', file)`，真正的上传与「回到第几步」由宿主编排
 *   （宿主还要刷新批次列表/明细，那属于数据编排，不属于本组件）。
 */
const props = defineProps<{
  /** 上传结束后由前端补的一句「下一步做什么」（后端不管 UI 引导）。 */
  lastHint: string;
  /** 上传后由**后端**给出的批次结论（整批被拒也有值 ⇒ 必须展示成批次记录）。 */
  lastResult: IotDeviceImportApi.BatchResp | null;
  /** 后端/网络失败原因（宿主上传 catch 后传入；与前端校验失败分开显示，避免混淆）。 */
  uploadError: string;
  /** 上传中（按钮 loading + 防重复提交）。 */
  uploading: boolean;
}>();

const emit = defineEmits<{
  /** 模板已下载成功 ⇒ 宿主把向导推进到「第 2 步」（Steps 状态机归宿主）。 */
  (e: 'templateDownloaded'): void;
  (e: 'upload', file: File): void;
}>();

/** 前端校验失败原因（类型/大小），渲染在本组件的 Alert 里。 */
const fileCheckError = ref('');

/**
 * 成功率的进度条取值。
 *
 * 分母为 0（整批被拒/空文件）时返回 0 而不是 NaN —— `NaN%` 会让用户以为页面坏了。
 */
const successRate = computed(() => {
  const total = Number(props.lastResult?.totalRows ?? 0);
  const success = Number(props.lastResult?.successRows ?? 0);
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.round((success / total) * 100);
});

/** 上传结果是否有失败行（决定 Alert 类型与进度条状态）。 */
const resultHasFailed = computed(() =>
  hasFailedRows(props.lastResult?.failedRows),
);

/** 第 1 步：下载模板（一键；文件名与后端 Content-Disposition 无关，前端给友好名）。 */
async function onDownloadTemplate() {
  try {
    const blob = await downloadDeviceImportTemplate();
    await downloadBlobSafe(
      blob,
      'device-import-template.csv',
      $t('page.iot.device.import.templateDownloadFailed'),
    );
    // 下载成功 ⇒ 用户手上已有模板，下一步显然是上传（步骤推进由宿主决定）
    emit('templateDownloaded');
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

/**
 * 上传前的拦截（antd Upload 的 `beforeUpload`）。
 *
 * 返回 `false` 表示**不上传**：用 `false` + 手动上传，避免 antd 自己发一次请求、宿主再发一次
 * （同一份文件会建出两个批次）。
 */
const beforeUpload: UploadProps['beforeUpload'] = (file) => {
  fileCheckError.value = '';
  const check = checkImportFile(file as unknown as File);
  if (!check.ok) {
    // 前端校验失败**不弹 toast**：留在页面上的 Alert 更持久，用户改完能对照着看
    fileCheckError.value = resolveImportFileCheckMessage(check);
    return false;
  }
  emit('upload', file as unknown as File);
  return false;
};
</script>

<template>
  <!-- 第 1 步：下载模板 -->
  <div class="rounded border border-solid border-border p-3">
    <div class="mb-2 text-sm font-medium">
      {{ $t('page.iot.device.import.stepTemplate') }}
    </div>
    <div class="mb-2 text-xs text-muted-foreground">
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
  <div class="rounded border border-solid border-border p-3">
    <div class="mb-2 text-sm font-medium">
      {{ $t('page.iot.device.import.stepUpload') }}
    </div>
    <!--
      🔴 校验失败/上传失败都用 Alert 而不是 toast：toast 转瞬即逝，用户错过之后
      页面上什么都不剩（不知道刚才为什么没反应）。Alert 留在页面上可对照修改。
    -->
    <Alert
      v-if="fileCheckError || props.uploadError"
      class="mb-2"
      :message="$t('page.iot.device.import.uploadRejected')"
      :description="fileCheckError || props.uploadError"
      show-icon
      type="error"
    />
    <Upload
      accept=".csv,.txt"
      :before-upload="beforeUpload"
      :disabled="props.uploading"
      :file-list="[]"
      :show-upload-list="false"
    >
      <Button :loading="props.uploading">
        {{ $t('page.iot.device.import.selectFile') }}
      </Button>
    </Upload>
    <div class="mt-2 text-xs text-muted-foreground">
      {{ $t('page.iot.device.import.uploadHint') }}
    </div>
  </div>

  <!-- 上传结果：后端结论 + 人话引导 + 计数（即使整批被拒也如实展示） -->
  <Alert
    v-if="props.lastResult"
    class="mb-2"
    :description="props.lastResult.errorSummary || ''"
    :message="props.lastHint"
    :type="resultHasFailed ? 'warning' : 'info'"
    show-icon
  />
  <div v-if="props.lastResult" class="mb-2">
    <Progress
      :percent="successRate"
      :status="resultHasFailed ? 'exception' : 'success'"
    />
    <div class="text-xs text-muted-foreground">
      {{
        $t('page.iot.device.import.countSummary', [
          props.lastResult.totalRows ?? 0,
          props.lastResult.successRows ?? 0,
          props.lastResult.failedRows ?? 0,
        ])
      }}
    </div>
  </div>
</template>
