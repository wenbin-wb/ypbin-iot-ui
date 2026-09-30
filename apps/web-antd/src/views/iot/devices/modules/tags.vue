<script lang="ts" setup>
import type { IotDeviceTagApi } from '#/api/iot';

import { computed, onMounted, ref } from 'vue';

import { useAccess } from '@vben/access';

import {
  Alert,
  Button,
  Input,
  message,
  Modal,
  Popconfirm,
  Spin,
  Tag,
} from 'ant-design-vue';

import {
  createDeviceTag,
  deleteDeviceTag,
  getDeviceTags,
  updateDeviceTag,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import {
  checkTagForm,
  normalizeTagForm,
  resolveTagListState,
  tagDisplayKey,
} from './tag-state';

/**
 * 设备详情「标签」区块（看板 #13 前端死能力接线）。
 *
 * 后端契约已就绪（IotDeviceTagController：list/create/update/delete），此前前端零接线。
 * 本区块放在设备详情「概览」页签内（标签是设备的描述性元数据，不是独立工作流）。
 *
 * 三条与仓内一致的约束：
 * 1. 失败态与空态严格分离（不把加载失败画成"没标签"）；
 * 2. 表单校验在前端先做（与后端 @NotBlank/@Size 同口径，避免"保存才报错"）；
 * 3. 入口/按钮分别按 iot:tag:* 权限码显示（无码则区块整体不可见，不留"能点但报错"的入口）。
 */
const props = defineProps<{
  deviceId: number | string;
}>();

const { hasAccessByCodes } = useAccess();

const canList = computed(() => hasAccessByCodes(['iot:tag:list']));
const canCreate = computed(() => hasAccessByCodes(['iot:tag:create']));
const canUpdate = computed(() => hasAccessByCodes(['iot:tag:update']));
const canDelete = computed(() => hasAccessByCodes(['iot:tag:delete']));

const loading = ref(false);
const errorMessage = ref('');
const tags = ref<IotDeviceTagApi.TagResp[]>([]);

const listState = computed(() =>
  resolveTagListState(loading.value, errorMessage.value, tags.value.length),
);

// ---------- 新增/编辑 ----------
const modalOpen = ref(false);
/** null = 新增；否则为编辑中的标签。 */
const editing = ref<IotDeviceTagApi.TagResp | null>(null);
const formKey = ref('');
const formValue = ref('');

const formOk = computed(() => {
  const check = checkTagForm(formKey.value, formValue.value);
  return check.ok;
});

const modalTitle = computed(() =>
  editing.value
    ? $t('page.iot.tag.editTitle', [editing.value.tagKey])
    : $t('page.iot.tag.createTitle'),
);

/** 打开新增弹窗。 */
function openCreate() {
  editing.value = null;
  formKey.value = '';
  formValue.value = '';
  modalOpen.value = true;
}

/** 打开编辑弹窗。 */
function openEdit(tag: IotDeviceTagApi.TagResp) {
  editing.value = tag;
  formKey.value = tag.tagKey;
  formValue.value = tag.tagValue;
  modalOpen.value = true;
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    tags.value = await getDeviceTags(String(props.deviceId));
  } catch (error) {
    errorMessage.value = extractErrorMessage(
      error,
      $t('page.iot.tag.loadFailed'),
    );
    tags.value = [];
  } finally {
    loading.value = false;
  }
}

async function save() {
  const check = checkTagForm(formKey.value, formValue.value);
  if (!check.ok) {
    message.error(check.message);
    return;
  }
  const payload = normalizeTagForm(formKey.value, formValue.value);
  try {
    if (editing.value) {
      await updateDeviceTag(String(props.deviceId), editing.value.id, payload);
      message.success($t('page.iot.tag.updateSuccess'));
    } else {
      await createDeviceTag(String(props.deviceId), payload);
      message.success($t('page.iot.tag.createSuccess'));
    }
    modalOpen.value = false;
    await load();
  } catch (error) {
    message.error(extractErrorMessage(error, $t('page.iot.tag.saveFailed')));
  }
}

async function remove(tag: IotDeviceTagApi.TagResp) {
  try {
    await deleteDeviceTag(String(props.deviceId), tag.id);
    message.success($t('page.iot.tag.deleteSuccess'));
    await load();
  } catch (error) {
    message.error(extractErrorMessage(error, $t('page.iot.tag.deleteFailed')));
  }
}

onMounted(() => {
  if (canList.value) {
    void load();
  }
});
</script>

<template>
  <div v-if="canList" class="space-y-2">
    <div class="flex items-center justify-between">
      <div class="text-sm font-medium">{{ $t('page.iot.tag.title') }}</div>
      <Button v-if="canCreate" size="small" @click="openCreate">
        {{ $t('page.iot.tag.add') }}
      </Button>
    </div>

    <Alert
      v-if="listState === 'error'"
      type="error"
      show-icon
      :message="$t('page.iot.tag.loadFailed')"
      :description="errorMessage"
    />

    <Spin :spinning="loading">
      <div v-if="listState === 'empty'" class="text-xs text-muted-foreground">
        {{ $t('page.iot.tag.empty') }}
      </div>
      <div v-else class="flex flex-wrap gap-1">
        <Tag v-for="(tag, index) in tags" :key="tagDisplayKey(index, tag)">
          {{ tag.tagKey }}={{ tag.tagValue }}
          <span
            v-if="canUpdate"
            class="ml-1 cursor-pointer text-xs text-primary"
            @click.stop="openEdit(tag)"
          >
            {{ $t('page.iot.tag.edit') }}
          </span>
          <Popconfirm
            v-if="canDelete"
            :title="$t('page.iot.tag.deleteConfirm', [tag.tagKey])"
            :ok-text="$t('page.iot.tag.okText')"
            :cancel-text="$t('page.iot.tag.cancel')"
            @confirm="remove(tag)"
          >
            <span class="ml-1 cursor-pointer text-xs text-red-500">
              {{ $t('page.iot.tag.delete') }}
            </span>
          </Popconfirm>
        </Tag>
      </div>
    </Spin>

    <Modal
      v-model:open="modalOpen"
      :title="modalTitle"
      :ok-text="$t('page.iot.tag.okText')"
      :cancel-text="$t('page.iot.tag.cancel')"
      :ok-button-props="{ disabled: !formOk }"
      @ok="save"
    >
      <div class="space-y-3">
        <div>
          <div class="mb-1 text-sm">{{ $t('page.iot.tag.key') }}</div>
          <Input
            v-model:value="formKey"
            :maxlength="64"
            :placeholder="$t('page.iot.tag.keyPlaceholder')"
            :disabled="Boolean(editing)"
          />
        </div>
        <div>
          <div class="mb-1 text-sm">{{ $t('page.iot.tag.value') }}</div>
          <Input
            v-model:value="formValue"
            :maxlength="255"
            :placeholder="$t('page.iot.tag.valuePlaceholder')"
          />
        </div>
        <div v-if="!formOk" class="text-xs text-red-500">
          {{ checkTagForm(formKey, formValue).message }}
        </div>
      </div>
    </Modal>
  </div>
</template>
