<script lang="ts" setup>
import type { PointForm } from './point-mapping-state';

import type { IotPointApi, IotThingModelApi } from '#/api/iot';

import { computed, onMounted, reactive, ref } from 'vue';

import { useAccess } from '@vben/access';

import {
  Alert,
  Button,
  Empty,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Switch,
  Tag,
} from 'ant-design-vue';

import {
  createDevicePoint,
  deleteDevicePoint,
  getDevicePoints,
  listProperties,
  listServices,
  updateDevicePoint,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import {
  buildPointPayload,
  emptyPointForm,
  formFromPoint,
  POINT_ADDRESS_TYPES,
  POINT_BYTE_ORDERS,
  POINT_REF_TYPES,
  POINT_RW_OPTIONS,
  validatePointForm,
} from './point-mapping-state';

/**
 * 「属性与点位」区块（F1）：把**产品物模型属性**（只读）与**设备级点位映射**并排关联，并支持**完整管理**。
 *
 * 这是「看不出关联」最核心的一处：左侧属性来自产品（设备绑了哪个产品就有哪些属性），
 * 右侧地址/周期/缩放是这台设备自己的。两边靠 `point.propertyId === property.id` 连接，
 * 未映射的属性用橙色标签标出（用户一眼就知道「这台设备还差哪些点位没配」）。
 *
 * **管理功能（看板 #13，一次做到位）**：iot:point:create/update/delete 分别控制
 * 新增/编辑/删除；表单校验与后端 IotPointMappingReq 逐条同口径（见 point-mapping-state）。
 * propertyId 支持从当前物模型属性下拉选择，也支持手输（command 场景引用命令 ID）。
 */
const props = defineProps<{
  deviceId: string;
  productId?: string;
}>();

const emit = defineEmits<{ openSeries: [propertyId?: string] }>();

const { hasAccessByCodes } = useAccess();
const canCreate = computed(() => hasAccessByCodes(['iot:point:create']));
const canUpdate = computed(() => hasAccessByCodes(['iot:point:update']));
const canDelete = computed(() => hasAccessByCodes(['iot:point:delete']));

const loading = ref(false);

const points = ref<IotPointApi.PointMappingResp[]>([]);

const pointsError = ref('');

const groups = ref<
  {
    properties: IotThingModelApi.PropertyResp[];
    service: IotThingModelApi.ServiceResp;
  }[]
>([]);

const modelError = ref('');

interface MergedRow {
  accessMode: string;
  dataType: string;
  identifier: string;
  point?: IotPointApi.PointMappingResp;
  propertyId: string;
  required?: boolean;
  serviceId: string;
  unit?: string;
}

/** 属性扁平列表（供 TSL 形态渲染；该形态无属性主键，不参与连接）。 */
const propertyRows = computed<MergedRow[]>(() =>
  groups.value.flatMap((group) =>
    group.properties.map((property) => ({
      accessMode: property.accessMode,
      dataType: property.dataType,
      identifier: property.identifier,
      propertyId: property.id,
      required: property.required,
      serviceId: group.service.serviceId,
      unit: property.unit,
    })),
  ),
);

/** 属性 ↔ 点位 的连接结果：两边靠属性主键关联，未映射的属性标橙。 */
const mergedRows = computed<MergedRow[]>(() => {
  const byProperty = new Map(
    points.value.map((point) => [point.propertyId, point]),
  );
  return propertyRows.value.map((row) => ({
    ...row,
    point: byProperty.get(row.propertyId),
  }));
});

/** 映射里引用了「产品物模型里已不存在」的属性 ID（属性被删/换版本），单独列出而不是隐藏。 */
const orphanPoints = computed(() => {
  const known = new Set(mergedRows.value.map((row) => row.propertyId));
  return points.value.filter((point) => !known.has(point.propertyId));
});

function tagColor(enabled?: boolean) {
  return enabled === false ? 'default' : 'success';
}

// ---------- 管理：新增/编辑 Modal + 删除 ----------
const modalOpen = ref(false);
/** null = 新增；否则为编辑中的点位。 */
const editing = ref<IotPointApi.PointMappingResp | null>(null);
const form = reactive<PointForm>(emptyPointForm());
const saving = ref(false);

const formOk = computed(() => validatePointForm(form).ok);
const formError = computed(() => {
  const check = validatePointForm(form);
  return check.ok ? '' : check.message;
});

const modalTitle = computed(() =>
  editing.value
    ? $t('page.iot.point.editTitle', [editing.value.propertyId])
    : $t('page.iot.point.createTitle'),
);

/** propertyId 候选：当前物模型属性（值=属性主键；label 显示 identifier + 类型）。 */
const propertyOptions = computed(() =>
  propertyRows.value.map((row) => ({
    value: row.propertyId,
    label: `${row.identifier} (${row.dataType})`,
  })),
);

function openCreate(propertyId?: string) {
  editing.value = null;
  const next = emptyPointForm();
  if (propertyId) {
    next.propertyId = propertyId;
  }
  Object.assign(form, next);
  modalOpen.value = true;
}

function openEdit(point: IotPointApi.PointMappingResp) {
  editing.value = point;
  Object.assign(form, formFromPoint(point));
  modalOpen.value = true;
}

async function save() {
  if (!formOk.value) {
    message.error(formError.value);
    return;
  }
  saving.value = true;
  try {
    if (editing.value) {
      await updateDevicePoint(
        String(props.deviceId),
        editing.value.id,
        buildPointPayload(String(props.deviceId), form),
      );
      message.success($t('page.iot.point.updateSuccess'));
    } else {
      await createDevicePoint(
        String(props.deviceId),
        buildPointPayload(String(props.deviceId), form),
      );
      message.success($t('page.iot.point.createSuccess'));
    }
    modalOpen.value = false;
    await load();
  } catch (error) {
    message.error(extractErrorMessage(error, $t('page.iot.point.saveFailed')));
  } finally {
    saving.value = false;
  }
}

async function remove(point: IotPointApi.PointMappingResp) {
  try {
    await deleteDevicePoint(String(props.deviceId), point.id);
    message.success($t('page.iot.point.deleteSuccess'));
    await load();
  } catch (error) {
    message.error(
      extractErrorMessage(error, $t('page.iot.point.deleteFailed')),
    );
  }
}

async function load() {
  if (!props.deviceId) {
    return;
  }
  loading.value = true;
  pointsError.value = '';
  modelError.value = '';
  const [pointsResult, modelResult] = await Promise.allSettled([
    getDevicePoints(props.deviceId),
    loadModel(),
  ]);
  if (pointsResult.status === 'fulfilled') {
    points.value = pointsResult.value ?? [];
  } else {
    points.value = [];
    pointsError.value = extractErrorMessage(
      pointsResult.reason,
      $t('page.iot.point.loadFailed'),
    );
  }
  if (modelResult.status === 'fulfilled') {
    groups.value = modelResult.value;
  } else {
    groups.value = [];
    modelError.value = extractErrorMessage(
      modelResult.reason,
      $t('page.iot.product.modelLoadFailed'),
    );
  }
  loading.value = false;
}

/** 取该产品全部服务及其属性（服务是属性/命令/事件的父层，后端层级如此）。 */
async function loadModel() {
  const productId = props.productId;
  if (!productId) {
    return [];
  }
  const services = await listServices(productId);
  return await Promise.all(
    (services ?? []).map(async (service) => ({
      properties: (await listProperties(productId, service.id)) ?? [],
      service,
    })),
  );
}

onMounted(load);
</script>
<template>
  <Spin :spinning="loading">
    <Alert
      v-if="!productId"
      :message="$t('page.iot.device.noProductHint')"
      class="mb-3"
      show-icon
      type="warning"
    />

    <Alert
      v-if="pointsError"
      :message="pointsError"
      class="mb-3"
      show-icon
      type="error"
    />
    <Alert
      v-if="modelError"
      :message="modelError"
      class="mb-3"
      show-icon
      type="error"
    />

    <template v-if="productId">
      <div class="mb-2 flex items-center justify-between">
        <span class="font-semibold">
          {{ $t('page.iot.device.propertyPointJoin') }}
          <span class="text-xs text-muted-foreground">
            （{{ $t('page.iot.device.propertyPointHint') }}）
          </span>
        </span>
        <Button v-if="canCreate" size="small" @click="openCreate()">
          {{ $t('page.iot.point.add') }}
        </Button>
      </div>
      <!-- 属性 ↔ 点位 连接表（含地址列与「未映射」标记） -->
      <Empty
        v-if="mergedRows.length === 0"
        :description="$t('page.iot.product.noProperty')"
      />
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="text-left text-gray-500">
            <th class="py-1">{{ $t('page.iot.point.property') }}</th>
            <th class="py-1">{{ $t('page.iot.point.service') }}</th>
            <th class="py-1">{{ $t('page.iot.point.dataType') }}</th>
            <th class="py-1">{{ $t('page.iot.point.accessMode') }}</th>
            <th class="py-1">{{ $t('page.iot.point.unit') }}</th>
            <th class="py-1">{{ $t('page.iot.point.rawAddress') }}</th>
            <th class="py-1">{{ $t('page.iot.point.addressType') }}</th>
            <th class="py-1">{{ $t('page.iot.point.pollIntervalMs') }}</th>
            <th class="py-1">{{ $t('page.iot.point.scaleFactor') }}</th>
            <th class="py-1">{{ $t('page.iot.point.enabled') }}</th>
            <th class="py-1">{{ $t('common.action') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in mergedRows" :key="row.propertyId" class="border-t">
            <td class="py-1">{{ row.identifier }}</td>
            <td class="py-1">{{ row.serviceId }}</td>
            <td class="py-1">{{ row.dataType }}</td>
            <td class="py-1">{{ row.accessMode }}</td>
            <td class="py-1">{{ row.unit || '-' }}</td>
            <td class="py-1">
              <template v-if="row.point">
                {{ row.point.rawAddress }}
              </template>
              <Tag v-else color="orange">
                {{ $t('page.iot.point.unmapped') }}
              </Tag>
            </td>
            <td class="py-1">{{ row.point?.addressType ?? '-' }}</td>
            <td class="py-1">{{ row.point?.pollIntervalMs ?? '-' }}</td>
            <td class="py-1">{{ row.point?.scaleFactor ?? '-' }}</td>
            <td class="py-1">
              <Tag v-if="row.point" :color="tagColor(row.point.enabled)">
                {{ row.point.enabled === false ? 'off' : 'on' }}
              </Tag>
              <span v-else>-</span>
            </td>
            <td class="py-1">
              <template v-if="row.point">
                <div class="flex gap-1">
                  <Button
                    v-if="canUpdate"
                    size="small"
                    type="link"
                    @click="openEdit(row.point)"
                  >
                    {{ $t('page.iot.point.edit') }}
                  </Button>
                  <Popconfirm
                    v-if="canDelete"
                    :title="
                      $t('page.iot.point.deleteConfirm', [row.point.rawAddress])
                    "
                    :ok-text="$t('page.iot.point.okText')"
                    :cancel-text="$t('page.iot.point.cancel')"
                    @confirm="remove(row.point)"
                  >
                    <Button size="small" type="link" danger>
                      {{ $t('page.iot.point.delete') }}
                    </Button>
                  </Popconfirm>
                </div>
              </template>
              <Button
                v-else-if="canCreate"
                size="small"
                type="link"
                @click="openCreate(row.propertyId)"
              >
                {{ $t('page.iot.point.addPointFor') }}
              </Button>
              <Button
                size="small"
                type="link"
                @click="emit('openSeries', row.identifier)"
              >
                {{ $t('page.iot.series.title') }}
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <div class="mt-4 mb-2 font-semibold">
      {{ $t('page.iot.point.rawList') }}
      <span class="text-xs text-muted-foreground">
        （{{ $t('page.iot.point.readonlyHint') }}）
      </span>
    </div>
    <Empty
      v-if="points.length === 0"
      :description="$t('page.iot.point.empty')"
    />
    <table v-else class="w-full text-sm">
      <thead>
        <tr class="text-left text-gray-500">
          <th class="py-1">{{ $t('page.iot.point.propertyId') }}</th>
          <th class="py-1">{{ $t('page.iot.point.refType') }}</th>
          <th class="py-1">{{ $t('page.iot.point.rawAddress') }}</th>
          <th class="py-1">{{ $t('page.iot.point.addressType') }}</th>
          <th class="py-1">{{ $t('page.iot.point.pollIntervalMs') }}</th>
          <th class="py-1">{{ $t('page.iot.point.rw') }}</th>
          <th class="py-1">{{ $t('page.iot.point.enabled') }}</th>
          <th class="py-1">{{ $t('common.action') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="point in points" :key="point.id" class="border-t">
          <td class="py-1">{{ point.propertyId }}</td>
          <td class="py-1">{{ point.refType }}</td>
          <td class="py-1">{{ point.rawAddress }}</td>
          <td class="py-1">{{ point.addressType }}</td>
          <td class="py-1">{{ point.pollIntervalMs ?? '-' }}</td>
          <td class="py-1">{{ point.rw }}</td>
          <td class="py-1">{{ point.enabled === false ? 'off' : 'on' }}</td>
          <td class="py-1">
            <div class="flex gap-1">
              <Button
                v-if="canUpdate"
                size="small"
                type="link"
                @click="openEdit(point)"
              >
                {{ $t('page.iot.point.edit') }}
              </Button>
              <Popconfirm
                v-if="canDelete"
                :title="$t('page.iot.point.deleteConfirm', [point.rawAddress])"
                :ok-text="$t('page.iot.point.okText')"
                :cancel-text="$t('page.iot.point.cancel')"
                @confirm="remove(point)"
              >
                <Button size="small" type="link" danger>
                  {{ $t('page.iot.point.delete') }}
                </Button>
              </Popconfirm>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <template v-if="orphanPoints.length > 0">
      <div class="mt-4 mb-2 font-semibold">
        {{ $t('page.iot.point.orphanTitle') }}
      </div>
      <Alert
        :message="$t('page.iot.point.orphanHint')"
        show-icon
        type="warning"
      />
      <table class="mt-2 w-full text-sm">
        <tbody>
          <tr v-for="point in orphanPoints" :key="point.id" class="border-t">
            <td class="py-1">{{ point.propertyId }}</td>
            <td class="py-1">{{ point.refType }}</td>
            <td class="py-1">{{ point.rawAddress }}</td>
            <td class="py-1">
              <Popconfirm
                v-if="canDelete"
                :title="$t('page.iot.point.deleteConfirm', [point.rawAddress])"
                :ok-text="$t('page.iot.point.okText')"
                :cancel-text="$t('page.iot.point.cancel')"
                @confirm="remove(point)"
              >
                <Button size="small" type="link" danger>
                  {{ $t('page.iot.point.delete') }}
                </Button>
              </Popconfirm>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </Spin>

  <!-- 新增/编辑 Modal（表单校验与后端同口径，见 point-mapping-state） -->
  <Modal
    v-model:open="modalOpen"
    :title="modalTitle"
    :ok-text="$t('page.iot.point.okText')"
    :cancel-text="$t('page.iot.point.cancel')"
    :ok-button-props="{ disabled: !formOk }"
    :confirm-loading="saving"
    @ok="save"
  >
    <div class="space-y-3">
      <div>
        <div class="mb-1 text-sm">
          {{ $t('page.iot.point.propertyId') }} /
          {{ $t('page.iot.point.refType') }}
        </div>
        <div class="flex gap-2">
          <Select
            v-model:value="form.propertyId"
            :options="propertyOptions"
            show-search
            allow-clear
            class="w-full"
            :placeholder="$t('page.iot.point.propertyPlaceholder')"
          />
          <Select v-model:value="form.refType" class="w-36">
            <Select.Option
              v-for="option in POINT_REF_TYPES"
              :key="option.value"
              :value="option.value"
            >
              {{ $t(option.labelKey) }}
            </Select.Option>
          </Select>
        </div>
      </div>
      <div>
        <div class="mb-1 text-sm">
          {{ $t('page.iot.point.rawAddress') }}
        </div>
        <Input
          v-model:value="form.rawAddress"
          :maxlength="128"
          :placeholder="$t('page.iot.point.rawAddressPlaceholder')"
        />
      </div>
      <div class="flex gap-2">
        <div class="w-1/2">
          <div class="mb-1 text-sm">
            {{ $t('page.iot.point.addressType') }}
          </div>
          <Select v-model:value="form.addressType" class="w-full">
            <Select.Option
              v-for="option in POINT_ADDRESS_TYPES"
              :key="option.value"
              :value="option.value"
            >
              {{ $t(option.labelKey) }}
            </Select.Option>
          </Select>
        </div>
        <div class="w-1/2">
          <div class="mb-1 text-sm">
            {{ $t('page.iot.point.pollIntervalMs') }}
          </div>
          <InputNumber
            v-model:value="form.pollIntervalMs"
            :min="0"
            class="w-full"
            :placeholder="$t('page.iot.point.pollPlaceholder')"
          />
        </div>
      </div>
      <div class="flex gap-2">
        <div class="w-1/2">
          <div class="mb-1 text-sm">
            {{ $t('page.iot.point.scaleFactor') }}
          </div>
          <Input
            v-model:value="form.scaleFactor"
            :placeholder="$t('page.iot.point.decimalPlaceholder')"
          />
        </div>
        <div class="w-1/2">
          <div class="mb-1 text-sm">
            {{ $t('page.iot.point.offsetValue') }}
          </div>
          <Input
            v-model:value="form.offsetValue"
            :placeholder="$t('page.iot.point.decimalPlaceholder')"
          />
        </div>
      </div>
      <div class="flex gap-2">
        <div class="w-1/2">
          <div class="mb-1 text-sm">
            {{ $t('page.iot.point.byteOrder') }}
          </div>
          <Select v-model:value="form.byteOrder" allow-clear class="w-full">
            <Select.Option
              v-for="option in POINT_BYTE_ORDERS"
              :key="option.value"
              :value="option.value"
            >
              {{ $t(option.labelKey) }}
            </Select.Option>
          </Select>
        </div>
        <div class="w-1/2">
          <div class="mb-1 text-sm">
            {{ $t('page.iot.point.rw') }}
          </div>
          <Select v-model:value="form.rw" class="w-full">
            <Select.Option
              v-for="option in POINT_RW_OPTIONS"
              :key="option.value"
              :value="option.value"
            >
              {{ $t(option.labelKey) }}
            </Select.Option>
          </Select>
        </div>
      </div>
      <div class="flex items-center justify-between">
        <div class="text-sm">
          {{ $t('page.iot.point.enableSwitch') }}
        </div>
        <Switch v-model:checked="form.enabled" />
      </div>
      <div v-if="!formOk" class="text-xs text-red-500">{{ formError }}</div>
    </div>
  </Modal>
</template>
