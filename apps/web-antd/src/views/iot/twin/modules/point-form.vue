<script lang="ts" setup>
import type { IotTwinApi } from '#/api/iot';

import { computed, onMounted, ref, watch } from 'vue';

import { useVbenModal } from '@vben/common-ui';

import { Alert, Button, message, Spin } from 'ant-design-vue';

import { useVbenForm } from '#/adapter/form';
import {
  createTwinPoint,
  getTwinDeviceProperties,
  updateTwinPoint,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { usePointFormSchema } from '../data';
import BindingEditor from './binding-editor.vue';
import DeviceSelect from './device-select.vue';

/**
 * 点位新增/编辑弹窗：标量字段走 `useVbenForm`，属性绑定走 `BindingEditor`。
 *
 * ## 结构为什么是「form + 独立区块」
 *
 * `useVbenForm` 承载标量字段（设备/坐标/法线/节点名/图标/标签/备注），它们的校验是
 * 单字段的。属性绑定是**变长列表**（0~12 条 × 6 字段），用 schema 表达需要为每一行建
 * 独立 form 实例，反而更绕。两者共用一个弹窗与一个保存按钮：
 * 保存时 `formApi.getValues()` 与 `bindings.value` 合并成 `PointSaveReq`。
 */
const props = defineProps<{
  /**
   * 拾取预填坐标（「放置锚点」流程传入）。
   *
   * 与 `point` 互斥：`point` 是编辑存量点位（含 id），`pickedAnchor` 是在画布上
   * 新点出的位置（无 id，新建）。两者同时存在时以 `point` 为准。
   */
  pickedAnchor?: {
    local: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
  };
  /** 编辑时的原始点位（undefined = 新建）。 */
  point?: IotTwinApi.PointResp;
  /** 当前场景 id。 */
  sceneId: string;
}>();

const emit = defineEmits<{
  close: [];
  success: [];
}>();

const isUpdate = computed(() => Boolean(props.point?.id));
const saving = ref(false);
const formError = ref('');

/**
 * 已选设备 ID（**独立 ref**，不依赖 `formApi.form` 的内部对象）。
 *
 * 为什么单独一个 ref：vben 5 的 `formApi.form` 是内部对象、不保证响应式，
 * 从它读实时值在值变更时拿不到新值。`DeviceSelect` 用 `v-model:value` 绑这个 ref，
 * 保存时以它为准；schema 里的 `deviceId` 字段只承载 label 与必填校验。
 */
const selectedDeviceId = ref<string>(props.point?.deviceId ?? '');

/** 绑定列表（受控）。 */
const bindings = ref<IotTwinApi.BindingSaveReq[]>(
  (props.point?.bindings ?? []).map((binding) => ({
    decimals: binding.decimals ?? undefined,
    displayRole: binding.displayRole,
    displayType: binding.displayType,
    propertyIdentifier: binding.propertyIdentifier,
    serviceIdentifier: binding.serviceIdentifier,
    sort: binding.sort,
    unitOverride: binding.unitOverride ?? undefined,
  })),
);

const properties = ref<IotTwinApi.DevicePropertyResp[]>([]);
const propertiesLoading = ref(false);
const propertiesError = ref('');
/** 设备未绑定产品（**正常空态**，不是错误）。 */
const deviceWithoutProduct = ref(false);

/** 标量字段表单。 */
const [Form, formApi] = useVbenForm({
  schema: usePointFormSchema(),
  showDefaultActions: false,
});

/**
 * 加载设备可绑定属性。
 *
 * @param deviceId 设备 id
 */
async function loadProperties(deviceId: string): Promise<void> {
  if (!deviceId) {
    properties.value = [];
    deviceWithoutProduct.value = false;
    return;
  }
  propertiesLoading.value = true;
  try {
    properties.value = await getTwinDeviceProperties(deviceId);
    deviceWithoutProduct.value = properties.value.length === 0;
    propertiesError.value = '';
  } catch (loadError) {
    propertiesError.value = extractErrorMessage(
      loadError,
      $t('page.iot.twin.propertyLoadFailed'),
    );
    properties.value = [];
  } finally {
    propertiesLoading.value = false;
  }
}

/** 设备变化 ⇒ 重拉属性（并清空已选绑定：旧绑定在新设备上大概率不存在）。 */
watch(selectedDeviceId, async (deviceId, previous) => {
  if (deviceId && deviceId !== previous) {
    if (!isUpdate.value) {
      bindings.value = [];
    }
    await loadProperties(deviceId);
  }
});

/**
 * 检出重复绑定（同服务同属性）。
 *
 * @param list 绑定列表
 * @returns 重复的 `service.property` 描述；无重复返回 undefined
 */
function findDuplicateBinding(
  list: IotTwinApi.BindingSaveReq[],
): string | undefined {
  const seen = new Set<string>();
  for (const item of list) {
    if (!item.serviceIdentifier || !item.propertyIdentifier) {
      continue;
    }
    const key = `${item.serviceIdentifier}\u0000${item.propertyIdentifier}`;
    if (seen.has(key)) {
      return `${item.serviceIdentifier}.${item.propertyIdentifier}`;
    }
    seen.add(key);
  }
  return undefined;
}

/** 保存。 */
async function onSave(): Promise<void> {
  formError.value = '';
  const { valid } = await formApi.validate();
  if (!valid) {
    return;
  }
  if (!selectedDeviceId.value) {
    message.warning($t('page.iot.twin.deviceRequired'));
    return;
  }
  const values = await formApi.getValues<{
    icon?: string;
    labelVisible?: boolean;
    localX: number;
    localY: number;
    localZ: number;
    nodeName?: string;
    normalX?: number;
    normalY?: number;
    normalZ?: number;
    remark?: string;
  }>();

  // 绑定完整性：不允许存在「选了行但没选属性」的空行
  const incomplete = bindings.value.some(
    (binding) => !binding.serviceIdentifier || !binding.propertyIdentifier,
  );
  if (incomplete) {
    message.warning($t('page.iot.twin.incompleteBinding'));
    return;
  }
  const duplicate = findDuplicateBinding(bindings.value);
  if (duplicate) {
    message.warning($t('page.iot.twin.duplicateBinding', [duplicate]));
    return;
  }
  if (
    bindings.value.filter((item) => item.displayRole === 'primary').length > 1
  ) {
    message.warning($t('page.iot.twin.multiplePrimary'));
    return;
  }

  saving.value = true;
  try {
    const payload: IotTwinApi.PointSaveReq = {
      bindings: bindings.value,
      deviceId: selectedDeviceId.value,
      icon: values.icon || undefined,
      labelVisible: values.labelVisible ?? true,
      localX: values.localX,
      localY: values.localY,
      localZ: values.localZ,
      nodeName: values.nodeName || undefined,
      normalX: values.normalX ?? 0,
      normalY: values.normalY ?? 1,
      normalZ: values.normalZ ?? 0,
      remark: values.remark || undefined,
    };
    await (isUpdate.value && props.point
      ? updateTwinPoint(props.sceneId, props.point.id, payload)
      : createTwinPoint(props.sceneId, payload));
    message.success($t('common.success'));
    modalApi.close();
    emit('success');
  } catch (saveError) {
    formError.value = extractErrorMessage(
      saveError,
      $t('page.iot.twin.saveFailed'),
    );
  } finally {
    saving.value = false;
  }
}

const [Modal, modalApi] = useVbenModal({
  onClosed() {
    emit('close');
  },
});

/**
 * 设备选择器的值变更（slot 内组件用）：同步 ref 与 schema 字段。
 *
 * @param deviceId 设备 id
 */
function onDeviceChange(deviceId: string): void {
  selectedDeviceId.value = deviceId;
  formApi.setValues({ deviceId });
}

onMounted(async () => {
  modalApi.setState({
    title: isUpdate.value
      ? $t('ui.actionTitle.edit', [$t('page.iot.twin.point')])
      : $t('ui.actionTitle.create', [$t('page.iot.twin.point')]),
  });
  if (props.point) {
    selectedDeviceId.value = props.point.deviceId;
    formApi.setValues({
      deviceId: props.point.deviceId,
      icon: props.point.icon ?? undefined,
      labelVisible: props.point.labelVisible,
      localX: Number(props.point.localX),
      localY: Number(props.point.localY),
      localZ: Number(props.point.localZ),
      nodeName: props.point.nodeName ?? undefined,
      normalX: Number(props.point.normalX),
      normalY: Number(props.point.normalY),
      normalZ: Number(props.point.normalZ),
      remark: props.point.remark ?? undefined,
    });
    await loadProperties(props.point.deviceId);
  } else if (props.pickedAnchor) {
    // 「放置锚点」流程：坐标由画布拾取并已换算成本场景局部系，直接预填
    formApi.setValues({
      localX: Number(props.pickedAnchor.local.x.toFixed(4)),
      localY: Number(props.pickedAnchor.local.y.toFixed(4)),
      localZ: Number(props.pickedAnchor.local.z.toFixed(4)),
      normalX: Number(props.pickedAnchor.normal.x.toFixed(4)),
      normalY: Number(props.pickedAnchor.normal.y.toFixed(4)),
      normalZ: Number(props.pickedAnchor.normal.z.toFixed(4)),
    });
  }
  modalApi.open();
});
</script>

<template>
  <Modal :confirm-loading="saving" class="w-[760px]" @confirm="onSave">
    <Alert
      v-if="formError"
      class="mb-3"
      closable
      :message="formError"
      type="error"
      @close="formError = ''"
    />
    <Alert
      v-if="deviceWithoutProduct"
      class="mb-3"
      :message="$t('page.iot.twin.deviceWithoutProduct')"
      type="warning"
    />
    <Alert
      v-if="propertiesError"
      class="mb-3"
      :message="propertiesError"
      type="error"
    />

    <!-- 设备选择器独立渲染在表单上方（不在 schema 里：它需要远程搜索 + 回显反查） -->
    <div class="mb-3">
      <label class="mb-1 block text-xs text-muted-foreground">
        {{ $t('page.iot.twin.device') }}
      </label>
      <DeviceSelect
        v-model:value="selectedDeviceId"
        :disabled="isUpdate"
        :placeholder="$t('page.iot.twin.devicePlaceholder')"
        @update:value="onDeviceChange"
      />
    </div>

    <Form />

    <div class="mt-4 border-t border-border pt-3">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-sm font-medium">
          {{ $t('page.iot.twin.bindings') }}
        </span>
        <span class="text-xs text-muted-foreground">
          {{ $t('page.iot.twin.bindingLimit', [12]) }}
        </span>
      </div>
      <Spin v-if="propertiesLoading" />
      <BindingEditor
        v-else
        v-model:bindings="bindings"
        :properties="properties"
      />
    </div>

    <template #footer>
      <Button @click="modalApi.close()">{{ $t('common.cancel') }}</Button>
      <Button :loading="saving" type="primary" @click="onSave">
        {{ $t('page.iot.twin.save') }}
      </Button>
    </template>
  </Modal>
</template>
