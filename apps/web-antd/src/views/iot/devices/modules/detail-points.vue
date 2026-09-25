<script lang="ts" setup>
import type { IotPointApi, IotThingModelApi } from '#/api/iot';

import { computed, onMounted, ref } from 'vue';

import { Alert, Button, Empty, Spin, Tag } from 'ant-design-vue';

import { getDevicePoints, listProperties, listServices } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

/**
 * 「属性与点位」区块（F1）：把**产品物模型属性**（只读）与**设备级点位映射**并排关联起来。
 *
 * 这是「看不出关联」最核心的一处：左侧属性来自产品（设备绑了哪个产品就有哪些属性），
 * 右侧地址/周期/缩放是这台设备自己的。两边靠 `point.propertyId === property.id` 连接，
 * 未映射的属性用橙色标签标出（用户一眼就知道「这台设备还差哪些点位没配」）。
 *
 * **读路径与产品状态无关**（2026-09-27 后端放开）：物模型的四个**读**接口
 * （services / properties / commands / events）原先要求产品处于草稿态，已发布产品会 409
 * ⇒ 属性清单读不到。现在读只校验「存在 + 租户归属」，任何状态都可读
 * （写操作仍要求草稿态）⇒ 这里可以无条件做属性↔点位连接。
 *
 * 属性必须在服务下逐服务取（后端层级如此），故对「该产品的服务」做一次 `Promise.all` 扇出
 * ——服务数量是个位数，且**与设备数量无关**（不存在按设备循环的 N+1）。
 *
 * 本轮只读展示：点位映射的增删改接口已就绪，但做成半个表单不如不做。
 */
const props = defineProps<{
  deviceId: string;
  productId?: string;
}>();

const emit = defineEmits<{ openSeries: [propertyId?: string] }>();

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
      <div class="mb-2 font-semibold">
        {{ $t('page.iot.device.propertyPointJoin') }}
        <span class="text-xs text-muted-foreground">
          （{{ $t('page.iot.device.propertyPointHint') }}）
        </span>
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
            <tr
              v-for="row in mergedRows"
              :key="row.propertyId"
              class="border-t"
            >
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
          </tr>
        </tbody>
      </table>
    </template>
  </Spin>
</template>
