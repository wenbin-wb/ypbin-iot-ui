<script lang="ts" setup>
import type { IotPointApi } from '#/api/iot';

import { computed, onMounted, ref } from 'vue';

import { useAccess } from '@vben/access';

import { Alert, Button, message, Spin } from 'ant-design-vue';

import { deleteDevicePoint } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import PointFormModal from './point-form-modal.vue';
import PointTable from './point-table.vue';
import { usePointMapping } from './use-point-mapping';

/**
 * 「属性与点位」区块：把**产品物模型属性**（只读）与**设备级点位映射**并排关联，并支持**完整管理**。
 *
 * 这是「看不出关联」最核心的一处：左侧属性来自产品（设备绑了哪个产品就有哪些属性），
 * 右侧地址/周期/缩放是这台设备自己的。两边靠 `point.propertyId === property.id` 连接，
 * 未映射的属性用橙色标签标出（用户一眼就知道「这台设备还差哪些点位没配」）。
 *
 * **管理功能（一次做到位）**：iot:point:create/update/delete 分别控制
 * 新增/编辑/删除；表单校验与后端 IotPointMappingReq 逐条同口径（见 point-mapping-state）。
 * propertyId 支持从当前物模型属性下拉选择，也支持手输（command 场景引用命令 ID）。
 *
 * 宿主职责（本文件）：数据装配（`usePointMapping`）、权限门禁（3 个 computed）、
 * 三张表渲染（`PointTable`）、增删改编排与失败提示。寄存器表单联动在
 * `point-form-modal.vue`（26 个 computed 里的大头），宿主不再承载表单细节。
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

const {
  load,
  loading,
  mergedRows,
  modelError,
  orphanPoints,
  points,
  pointsError,
  propertyOptions,
} = usePointMapping(props);

/** 新增/编辑弹窗：表单状态与提交都在子组件，宿主只借 ref 打开（不碰表单内部）。 */
const formModalRef = ref<{
  openCreate: (propertyId?: string) => void;
  openEdit: (point: IotPointApi.PointMappingResp) => void;
}>();

function openCreate(propertyId?: string) {
  formModalRef.value?.openCreate(propertyId);
}

function openEdit(point: IotPointApi.PointMappingResp) {
  formModalRef.value?.openEdit(point);
}

/**
 * 删除映射：二次确认由表格里的 Popconfirm 负责（未确认不会走到这里）。
 * 成功/失败都必须有可见反馈，失败原样展示后端 message。
 */
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

    <div class="mb-2 flex items-center justify-between">
      <span class="font-semibold">
        {{ $t('page.iot.device.propertyPointJoin') }}
        <span class="text-xs text-muted-foreground">
          （{{ $t('page.iot.device.propertyPointHint') }}）
        </span>
      </span>
      <Button
        v-if="canCreate"
        data-testid="point-add"
        size="small"
        @click="openCreate()"
      >
        {{ $t('page.iot.point.add') }}
      </Button>
    </div>

    <PointTable
      :can-create="canCreate"
      :can-delete="canDelete"
      :can-update="canUpdate"
      :has-product="Boolean(productId)"
      :merged-rows="mergedRows"
      :orphan-points="orphanPoints"
      :points="points"
      @create="openCreate"
      @edit="openEdit"
      @open-series="emit('openSeries', $event)"
      @remove="remove"
    />
  </Spin>

  <PointFormModal
    ref="formModalRef"
    :device-id="deviceId"
    :property-options="propertyOptions"
    @saved="load"
  />
</template>
