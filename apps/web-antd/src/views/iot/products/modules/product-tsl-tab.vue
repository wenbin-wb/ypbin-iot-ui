<script lang="ts" setup>
import type { IotThingModelApi } from '#/api/iot';

import { ref } from 'vue';

import { Alert, Button, message } from 'ant-design-vue';

import { exportTsl, importTsl } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';
import { downloadByBlob } from '#/utils/file';

/**
 * 产品详情 →「TSL 导入导出」页签内容组件（从 `detail.vue` 拆出）。
 *
 * 职责：导出（回填文本框 + 下载文件）/ 粘贴导入（本地语法校验 → 后端结构校验），
 * 以及两类错误（本地 `tslError`、后端逐项 `tslErrors`）的展示。
 *
 * ## 为什么这段状态可以整体搬进子组件
 *
 * TSL 文本/错误只在**本页签内**产生与消费，宿主其他地方不读它；唯一例外是
 * 概览页签的「导出 TSL」按钮需要直接下载 —— 所以本组件 `defineExpose({ exportTsl })`，
 * 宿主通过 ref 调用（该页签加 `force-render`，保证概览页按钮点击时子组件已挂载）。
 *
 * 导入成功 ⇒ `emit('reload')` 交宿主走完整 reloadAll（物模型/版本/设备列表一并刷新）；
 * 导入失败（后端逐项错误）只展示、**不刷新**——避免把失败当成功。
 */
const props = defineProps<{
  /** 草稿态才允许导入（已发布版本不可变）。 */
  isDraft: boolean;
  /** 导出文件名用产品编码；缺失时回落主键。 */
  productCode?: string;
  productId: string;
}>();

const emit = defineEmits<{ reload: [] }>();

const tslText = ref('');
const tslError = ref('');
const tslErrors = ref<string[]>([]);

/** 导出 TSL：既落到页面文本框（可核对），也直接下载成文件。 */
async function exportTslDocument() {
  if (!props.productId) {
    return;
  }
  tslError.value = '';
  tslErrors.value = [];
  const doc = await exportTsl(props.productId);
  tslText.value = JSON.stringify(doc, null, 2);
  downloadByBlob(
    new Blob([tslText.value], { type: 'application/json;charset=utf-8' }),
    `tsl-${props.productCode ?? props.productId}.json`,
  );
}

/**
 * 导入 TSL：本地先解析（JSON 语法错误要在本地报，不该把注定失败的请求发出去），
 * 再交给后端做结构与校验（失败逐项返回 `errors`，整体不落库）。
 */
async function importTslDocument() {
  if (!props.productId) {
    return;
  }
  tslError.value = '';
  tslErrors.value = [];
  if (tslText.value.trim() === '') {
    tslError.value = $t('page.iot.product.tslEmpty');
    return;
  }
  let doc: IotThingModelApi.TslDocument;
  try {
    doc = JSON.parse(tslText.value) as IotThingModelApi.TslDocument;
  } catch (error) {
    tslError.value = `${$t('page.iot.product.tslInvalidJson')}：${extractErrorMessage(error, '')}`;
    return;
  }
  const result = await importTsl(props.productId, doc);
  tslErrors.value = result?.errors ?? [];
  if (tslErrors.value.length === 0) {
    message.success(
      `${$t('common.success')}（${$t('page.iot.product.tslSuccessCount', [String(result?.successCount ?? 0)])}）`,
    );
    emit('reload');
  }
}

/** 抽屉复用（`destroyOnClose=false`）时清空上一个产品的 TSL 文本与错误，避免跨产品串用。 */
function reset() {
  tslText.value = '';
  tslError.value = '';
  tslErrors.value = [];
}

defineExpose({ exportTsl: exportTslDocument, reset });
</script>

<template>
  <div>
    <Alert
      :message="$t('page.iot.product.tslHint')"
      class="mb-3"
      show-icon
      type="info"
    />
    <div class="mb-2 flex gap-2">
      <Button
        v-access:code="['iot:product:tsl-export']"
        @click="exportTslDocument"
      >
        {{ $t('page.iot.product.tslExport') }}
      </Button>
      <Button
        v-access:code="['iot:product:tsl-import']"
        v-if="isDraft"
        type="primary"
        @click="importTslDocument"
      >
        {{ $t('page.iot.product.tslImport') }}
      </Button>
    </div>
    <textarea
      v-model="tslText"
      class="h-[360px] w-full rounded border p-2 font-mono text-xs"
      :placeholder="$t('page.iot.product.tslPlaceholder')"
    ></textarea>
    <Alert
      v-if="tslError"
      :message="tslError"
      class="mt-2"
      show-icon
      type="error"
    />
    <Alert v-if="tslErrors.length > 0" class="mt-2" show-icon type="error">
      <template #message>
        <div>{{ $t('page.iot.product.tslImportFailed') }}</div>
        <ul class="ml-4 list-disc">
          <li v-for="(item, index) in tslErrors" :key="index">
            {{ item }}
          </li>
        </ul>
      </template>
    </Alert>
  </div>
</template>
