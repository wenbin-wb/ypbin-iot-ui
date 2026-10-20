import type { ComputedRef, Ref } from 'vue';

import type { IotPointApi, IotThingModelApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { getDevicePoints, listProperties, listServices } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { dataTypeLabel } from '../../shared/display';

/**
 * 「属性与点位」的数据装配：点位映射（设备级）+ 产品物模型（属性维度）加载与合并。
 *
 * 为什么单独成 composable：宿主只该关心「表格 + 弹窗 + 权限」，而数据加载/失败态/
 * 属性↔点位连接（`mergedRows`）/孤儿映射（`orphanPoints`）是**纯数据推导**，
 * 与表单寄存器联动（26 个 computed 的大头）互不依赖。拆开后宿主的状态面从 34 降到个位数。
 *
 * 失败语义（与页面其它区块同口径）：
 * - 点位与物模型**各自独立报错**（一处失败不影响另一处展示）；
 * - 失败原样展示后端 message，绝不画成空态。
 */

/** 属性↔点位连接行（左侧属性来自产品物模型，右侧映射来自设备）。 */
export interface MergedRow {
  accessMode: string;
  dataType: string;
  identifier: string;
  point?: IotPointApi.PointMappingResp;
  propertyId: string;
  required?: boolean;
  serviceId: string;
  unit?: string;
}

/** 加载产物：宿主把它们直接透传给表格/弹窗。 */
export interface PointMappingState {
  /** 点位与物模型共用的加载态（表格遮罩）。 */
  loading: Ref<boolean>;
  /** 属性↔点位连接行（表格数据源）。 */
  mergedRows: ComputedRef<MergedRow[]>;
  /** 物模型加载失败原因（空串=无错）。 */
  modelError: Ref<string>;
  /** 引用了已不存在属性的映射（单独列表展示）。 */
  orphanPoints: ComputedRef<IotPointApi.PointMappingResp[]>;
  /** 设备级点位映射原始列表。 */
  points: Ref<IotPointApi.PointMappingResp[]>;
  /** 点位加载失败原因（空串=无错）。 */
  pointsError: Ref<string>;
  /** 属性下拉候选（值=属性主键；label 显示 identifier + 类型）。 */
  propertyOptions: ComputedRef<{ label: string; value: string }[]>;
  /** 重新加载点位 + 物模型（弹窗保存/删除后调用）。 */
  load: () => Promise<void>;
}

/** 产品物模型分组（服务 → 属性），仅 composable 内部使用。 */
interface PointGroup {
  properties: IotThingModelApi.PropertyResp[];
  service: IotThingModelApi.ServiceResp;
}

/**
 * @param props 设备/产品引用（宿主把 props 直接传进来：composable 不持有路由/抽屉状态）
 */
export function usePointMapping(props: {
  deviceId: string;
  productId?: string;
}): PointMappingState {
  const loading = ref(false);

  const points = ref<IotPointApi.PointMappingResp[]>([]);

  const pointsError = ref('');

  const groups = ref<PointGroup[]>([]);

  const modelError = ref('');

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

  /** propertyId 候选：当前物模型属性（值=属性主键；label 显示 identifier + 类型）。 */
  const propertyOptions = computed(() =>
    propertyRows.value.map((row) => ({
      label: `${row.identifier} (${dataTypeLabel(row.dataType)})`,
      value: row.propertyId,
    })),
  );

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

  return {
    load,
    loading,
    mergedRows,
    modelError,
    orphanPoints,
    points,
    pointsError,
    propertyOptions,
  };
}
