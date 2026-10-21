<script lang="ts" setup>
import type { UploadProps } from 'ant-design-vue';

import type { IotTwinApi } from '#/api/iot';

import { computed, onMounted, ref } from 'vue';

import { useAccess } from '@vben/access';
import { IconifyIcon } from '@vben/icons';

import {
  Alert,
  Upload as AntUpload,
  Button,
  Empty,
  message,
  Popconfirm,
  Progress,
  Spin,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  createModelAssetExternal,
  deleteModelAsset,
  getModelAssetList,
  uploadModelAsset,
} from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import ListErrorAlert from '../../shared/list-error-alert.vue';
import { extractNodeNames } from './model-node-names';

/**
 * 模型资产管理面板（上传 / 外链登记 / 删除 / 引用数）。
 *
 * ## 上传通道为什么是独立的
 *
 * 不复用 `/system/file/upload`：该端点标了 `@PlatformAccess`（租户用户 403），
 * 且其依赖的 `ypbin.storage` 此前未配置。孪生模型走自建的
 * `/iot/twin/model-assets/upload`，支持 64MB、带进度、带魔数校验。
 */
const emit = defineEmits<{
  /** 资产列表已加载（父组件共享给画布，避免重复请求）。 */
  assetsLoaded: [assets: IotTwinApi.ModelAssetResp[]];
  /** 资产变更（场景可能引用了它，需要刷新场景树）。 */
  refresh: [];
}>();

const { hasAccessByCodes } = useAccess();
const canCreate = computed(() => hasAccessByCodes(['iot:twin:create']));
const canDelete = computed(() => hasAccessByCodes(['iot:twin:delete']));

const assets = ref<IotTwinApi.ModelAssetResp[]>([]);
const loading = ref(false);
const error = ref('');
const uploadPercent = ref(-1);
const uploading = ref(false);
const externalOpen = ref(false);
const externalName = ref('');
const externalUrl = ref('');
const externalSaving = ref(false);

/** 允许的模型扩展名（与后端 `TwinLimits.allowedModelExtensions` 同值）。 */
const ALLOWED_EXTENSIONS = ['.glb', '.gltf'] as const;

/** 模型文件上限（64MB，与后端 `TwinLimits.MAX_MODEL_BYTES` 同值）。 */
const MAX_MODEL_BYTES = 64 * 1024 * 1024;

/** 拉取资产列表。 */
async function load(): Promise<void> {
  loading.value = true;
  try {
    assets.value = await getModelAssetList();
    emit('assetsLoaded', assets.value);
    error.value = '';
  } catch (loadError) {
    error.value = extractErrorMessage(
      loadError,
      $t('page.iot.twin.assetLoadFailed'),
    );
  } finally {
    loading.value = false;
  }
}

/** 上传前拦截（扩展名 + 大小，与后端同口径）。 */
const beforeUpload: UploadProps['beforeUpload'] = (file) => {
  const name = file.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    message.error($t('page.iot.twin.modelFormatInvalid'));
    return false;
  }
  if (file.size > MAX_MODEL_BYTES) {
    message.error($t('page.iot.twin.modelTooLarge'));
    return false;
  }
  void doUpload(file);
  // 返回 false 阻止 antd 的默认上传行为（我们自己发请求）
  return false;
};

/**
 * 执行上传。
 *
 * @param file 模型文件
 */
async function doUpload(file: File): Promise<void> {
  uploading.value = true;
  uploadPercent.value = 0;
  try {
    // **上传前解析节点名**（工单 #130 遗留项）。
    // 后端 `node_names_json` 就是为「按节点名预匹配锚点」存的；此前从不提交 ⇒ 该能力一直是死的。
    // 解析失败不阻断上传（节点名只是辅助索引），失败时返回空数组并已 console.warn 留痕。
    const nodeNames = await extractNodeNames(file);
    await uploadModelAsset(file, {
      nodeNames,
      onProgress: (percent) => {
        uploadPercent.value = percent;
      },
    });
    message.success($t('common.success'));
    await load();
    emit('refresh');
  } catch (uploadError) {
    message.error(
      extractErrorMessage(uploadError, $t('page.iot.twin.uploadFailed')),
    );
  } finally {
    uploading.value = false;
    uploadPercent.value = -1;
  }
}

/** 登记外链模型。 */
async function onExternalSave(): Promise<void> {
  if (!externalName.value.trim()) {
    message.warning($t('page.iot.twin.assetNameRequired'));
    return;
  }
  if (!/^https?:\/\//i.test(externalUrl.value.trim())) {
    message.warning($t('page.iot.twin.externalUrlInvalid'));
    return;
  }
  externalSaving.value = true;
  try {
    await createModelAssetExternal({
      assetName: externalName.value.trim(),
      externalUrl: externalUrl.value.trim(),
    });
    message.success($t('common.success'));
    externalOpen.value = false;
    externalName.value = '';
    externalUrl.value = '';
    await load();
    emit('refresh');
  } catch (saveError) {
    message.error(
      extractErrorMessage(saveError, $t('page.iot.twin.saveFailed')),
    );
  } finally {
    externalSaving.value = false;
  }
}

/**
 * 删除资产（被场景引用时后端拒绝并说明引用数）。
 *
 * @param asset 资产
 */
async function onDelete(asset: IotTwinApi.ModelAssetResp): Promise<void> {
  try {
    await deleteModelAsset(asset.id);
    message.success($t('common.success'));
    await load();
    emit('refresh');
  } catch (deleteError) {
    message.error(
      extractErrorMessage(deleteError, $t('page.iot.twin.deleteFailed')),
    );
  }
}

/**
 * 文件体积展示。
 *
 * @param bytes 字节数
 * @returns 展示文本
 */
function formatSize(bytes?: null | number | string): string {
  // 后端 Long 序列化为字符串 ⇒ 先显式转数再比较（否则是字符串比较）
  const size = toBackendNumber(bytes ?? null);
  if (!size) {
    return '-';
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

onMounted(async () => {
  await load();
});
</script>

<template>
  <!-- vben-ui-dev-exempt: R2 外链登记是内联双字段小表单，单独建 form 实例成本大于收益 -->
  <div class="rounded-lg border border-border">
    <div
      class="flex items-center justify-between border-b border-border px-3 py-2"
    >
      <span class="text-sm font-medium">{{
        $t('page.iot.twin.modelAssets')
      }}</span>
      <div v-if="canCreate" class="flex items-center gap-1">
        <AntUpload :before-upload="beforeUpload" :show-upload-list="false">
          <Button :loading="uploading" size="small" type="primary">
            <IconifyIcon class="size-4" icon="lucide:upload" />
            {{ $t('page.iot.twin.uploadModel') }}
          </Button>
        </AntUpload>
        <Button size="small" @click="externalOpen = !externalOpen">
          {{ $t('page.iot.twin.registerExternal') }}
        </Button>
      </div>
    </div>

    <Progress
      v-if="uploadPercent >= 0"
      :percent="uploadPercent"
      class="px-3 pt-2"
      size="small"
    />

    <ListErrorAlert
      v-if="error"
      :error="error"
      :retry-text="$t('page.iot.twin.retry')"
      :title="$t('page.iot.twin.assetLoadFailed')"
      @retry="load"
    />

    <div class="max-h-48 overflow-auto p-2">
      <Spin v-if="loading && assets.length === 0" />
      <Empty
        v-else-if="assets.length === 0"
        :description="$t('page.iot.twin.noAsset')"
      />
      <ul v-else class="space-y-1">
        <li
          v-for="asset in assets"
          :key="asset.id"
          class="flex items-center justify-between gap-2 rounded px-1 py-1 text-xs hover:bg-muted/40"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1">
              <span class="truncate font-medium">{{ asset.assetName }}</span>
              <Tag>{{ asset.modelFormat }}</Tag>
              <Tag v-if="asset.assetType === 'external'" color="blue">
                {{ $t('page.iot.twin.external') }}
              </Tag>
            </div>
            <div class="text-muted-foreground">
              {{ formatSize(asset.fileSize) }}
              <span v-if="asset.sceneCount > 0">
                · {{ $t('page.iot.twin.sceneRefCount', [asset.sceneCount]) }}
              </span>
            </div>
          </div>
          <Tooltip
            v-if="asset.sceneCount > 0"
            :title="$t('page.iot.twin.assetInUseHint')"
          >
            <Button disabled size="small" type="link">
              {{ $t('common.delete') }}
            </Button>
          </Tooltip>
          <Popconfirm
            v-else-if="canDelete"
            :title="$t('ui.actionMessage.deleteConfirm', [asset.assetName])"
            @confirm="onDelete(asset)"
          >
            <Button danger size="small" type="link">
              {{ $t('common.delete') }}
            </Button>
          </Popconfirm>
        </li>
      </ul>
    </div>

    <!-- 外链登记 -->
    <div v-if="externalOpen" class="border-t border-border p-3">
      <Alert
        class="mb-2"
        :message="$t('page.iot.twin.externalHint')"
        type="info"
      />
      <a-input
        v-model:value="externalName"
        :maxlength="128"
        :placeholder="$t('page.iot.twin.assetName')"
        class="mb-2"
      />
      <a-input
        v-model:value="externalUrl"
        :maxlength="1024"
        :placeholder="$t('page.iot.twin.externalUrl')"
        class="mb-2"
      />
      <div class="flex justify-end gap-2">
        <Button size="small" @click="externalOpen = false">
          {{ $t('common.cancel') }}
        </Button>
        <Button
          :loading="externalSaving"
          size="small"
          type="primary"
          @click="onExternalSave"
        >
          {{ $t('page.iot.twin.save') }}
        </Button>
      </div>
    </div>
  </div>
</template>
