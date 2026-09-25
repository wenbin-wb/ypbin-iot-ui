<script lang="ts" setup>
import type { IotPointApi, IotThingModelApi } from '#/api/iot';

import { computed, onMounted, ref } from 'vue';

import { Alert, Button, Empty, Spin, Tag } from 'ant-design-vue';

import {
  exportTsl,
  getDevicePoints,
  listProperties,
  listServices,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

/**
 * 「属性与点位」区块（F1）：把**产品物模型属性**（只读）与**设备级点位映射**并排关联起来。
 *
 * 这是「看不出关联」最核心的一处：左侧属性来自产品（设备绑了哪个产品就有哪些属性），
 * 右侧地址/周期/缩放是这台设备自己的。草稿态下两边靠 `point.propertyId === property.id` 连接，
 * 未映射的属性用橙色标签标出（用户一眼就知道「这台设备还差哪些点位没配」）。
 *
 * **两条读取路径（生产实测逼出来的第二形态）**：物模型的**读**接口在后端也要求产品处于
 * **草稿态**（`IotThingModelServiceImpl` 的 listServices / listProperties 都先走 `requireProductDraft`），
 * 已发布产品调它会得到业务码 409；而 `exportTsl` 不校验草稿态（生产实测 200）。于是：
 * - **草稿态** ⇒ 走物模型接口，拿到**属性主键** ⇒ 可做连接（含未映射标记）；
 * - **已发布** ⇒ 退回 `exportTsl` 读结构。TSL 里**只有属性标识符、没有属性主键** ⇒
 *   属性与点位只能并排展示，**不能**连接 ⇒ 该形态下**不显示**「未映射」标记，避免误报。
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

/** 属性清单的来源：`draft`=物模型接口（可连接）；`tsl`=导出 TSL（不可连接）；`none`=都没拿到。 */
const modelSource = ref<'draft' | 'none' | 'tsl'>('none');

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

/** 属性 ↔ 点位 的连接结果（**仅草稿态有意义**：TSL 形态没有属性主键，连接会全判为未映射）。 */
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
  if (modelSource.value !== 'draft') {
    // 非草稿态拿不到属性主键 ⇒ 无法判定「孤儿」，不猜
    return [];
  }
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
    groups.value = modelResult.value.groups;
    modelSource.value = modelResult.value.source;
  } else {
    groups.value = [];
    modelSource.value = 'none';
    modelError.value = extractErrorMessage(
      modelResult.reason,
      $t('page.iot.product.modelLoadFailed'),
    );
  }
  loading.value = false;
}

/** 取该产品全部服务及其属性（服务是属性/命令/事件的父层，后端层级如此）。 */
async function loadModel(): Promise<{
  groups: {
    properties: IotThingModelApi.PropertyResp[];
    service: IotThingModelApi.ServiceResp;
  }[];
  source: 'draft' | 'none' | 'tsl';
}> {
  const productId = props.productId;
  if (!productId) {
    return { groups: [], source: 'none' };
  }
  try {
    const services = await listServices(productId);
    const groups = await Promise.all(
      (services ?? []).map(async (service) => ({
        properties: (await listProperties(productId, service.id)) ?? [],
        service,
      })),
    );
    return { groups, source: 'draft' };
  } catch (error) {
    // 已发布产品：物模型读接口 409 ⇒ 退回 TSL 导出（后端 exportTsl 不校验草稿态）
    console.warn('[iot] 物模型清单读取失败，改用 TSL 导出读取结构', error);
    const doc = await exportTsl(productId);
    return { groups: groupsFromTsl(doc), source: 'tsl' };
  }
}

/**
 * 从 TSL 文档还原「服务 → 属性」结构（仅用于已发布产品的只读展示）。
 *
 * 只取展示需要的字段；`id` 是 `tsl:` 前缀的**合成值**，且**不参与**与点位映射的连接
 * （映射里存的是属性主键，TSL 里没有）——这一点由调用方的 `modelSource === 'draft'` 分支保证。
 */
function groupsFromTsl(doc: IotThingModelApi.TslDocument) {
  const services = (doc?.services ?? []) as Record<string, unknown>[];
  return services.map((raw) => {
    const serviceType = String(raw.serviceType ?? '');
    const service = {
      id: `tsl:${serviceType}`,
      productId: props.productId ?? '',
      serviceId: serviceType,
      serviceName: String(raw.description ?? serviceType),
      serviceOption: String(raw.option ?? ''),
    } as IotThingModelApi.ServiceResp;
    const rawProperties = (raw.properties ?? []) as Record<string, unknown>[];
    const properties = rawProperties.map((rawProperty) => {
      const identifier = String(rawProperty.propertyName ?? '');
      const unit = rawProperty.unit;
      return {
        id: `tsl:${serviceType}:${identifier}`,
        serviceId: service.id,
        identifier,
        propertyName: identifier,
        dataType: String(rawProperty.dataType ?? ''),
        accessMode: String(rawProperty.method ?? ''),
        required: rawProperty.required === true,
        unit: unit === null || unit === undefined ? undefined : String(unit),
      } as IotThingModelApi.PropertyResp;
    });
    return { properties, service };
  });
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
      <Alert
        v-if="modelSource === 'tsl'"
        :message="$t('page.iot.device.modelFromTsl')"
        class="mb-2"
        show-icon
        type="info"
      />
      <div
        v-if="modelSource === 'none' && modelError"
        class="mb-2 text-xs text-muted-foreground"
      >
        {{ $t('page.iot.device.modelNeedsDraft') }}
      </div>

      <!-- 草稿态：属性 ↔ 点位 连接表（含地址列与「未映射」标记） -->
      <template v-if="modelSource === 'draft'">
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

      <!-- 已发布态：TSL 只读属性表（无属性主键 ⇒ 不做连接、不标「未映射」） -->
      <template v-else-if="modelSource === 'tsl'">
        <Empty
          v-if="propertyRows.length === 0"
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
              <th class="py-1">{{ $t('page.iot.product.required') }}</th>
              <th class="py-1">{{ $t('common.action') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in propertyRows"
              :key="row.propertyId"
              class="border-t"
            >
              <td class="py-1">{{ row.identifier }}</td>
              <td class="py-1">{{ row.serviceId }}</td>
              <td class="py-1">{{ row.dataType }}</td>
              <td class="py-1">{{ row.accessMode }}</td>
              <td class="py-1">{{ row.unit || '-' }}</td>
              <td class="py-1">
                {{ row.required ? $t('common.yes') : $t('common.no') }}
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
