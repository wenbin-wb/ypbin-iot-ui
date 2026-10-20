<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

import type {
  ModelHint,
  SeriesPointOption,
  SeriesQueryResult,
  SeriesRangeMode,
  SeriesResolvedRange,
} from './series-utils';

import type { IotPointApi, IotThingModelApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

// vben-ui-dev-exempt: R2 本抽屉是「查询条件 + 即时出图」，不是提交型表单（没有 submit/reset 语义），
// 沿用本文件既有写法直接用 antd 组件；把 Select/RangePicker 塞进 useVbenForm schema 反而要另造一套
// 「选完即查」的联动，得不偿失。
import {
  Alert,
  Button,
  Collapse,
  CollapsePanel,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  message,
  RadioButton,
  RadioGroup,
  Select,
  Spin,
  Switch,
  Tag,
  Tooltip,
} from 'ant-design-vue';
import dayjs from 'dayjs';

import { getDevicePoints } from '#/api/iot/point';
import {
  getDeviceSeries,
  IOT_SERIES_DEFAULT_LIMIT,
  IOT_SERIES_MAX_LIMIT,
} from '#/api/iot/series';
import { listProperties, listServices } from '#/api/iot/thingmodel';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';
import { downloadByBlob } from '#/utils/file';

import { displayOrFallback, qualityLabel } from '../../shared/display';
import SeriesChart from './series-chart.vue';
import {
  buildChartModel,
  buildCsv,
  buildCsvRows,
  buildDetailRows,
  buildPointOptions,
  chartUnits,
  countOrphanPoints,
  flattenProperties,
  formatRangeLabel,
  IOT_SERIES_AUTO_REFRESH_MS,
  IOT_SERIES_DEFAULT_RANGE_MODE,
  IOT_SERIES_LIVE_MAX_POINTS,
  IOT_SERIES_MAX_SELECTED_POINTS,
  IOT_SERIES_TABLE_MAX_ROWS,
  isValidPropertyId,
  loadSeriesPreferences,
  numericCount,
  resolveModelHint,
  resolveSeriesRange,
  saveSeriesPreferences,
  seriesCsvFileName,
} from './series-utils';
import { useSeriesLive } from './use-series-live';

/**
 * 历史曲线抽屉（设备台账与设备详情**共用这一份**）。
 *
 * 交互目标：**普通用户三步内看到曲线**——① 选点位（下拉，来自 `GET /devices/{id}/points`，默认选中第一个）
 * → ② 选时间（默认最近 24 小时 + 快捷档位）→ ③ 看曲线。打开抽屉即按默认条件自动查一次，
 * 不再要求用户先手写 `temperature` 这种内部标识符。
 *
 * 三条不能退让的语义（都来自后端契约，写错就是把「失败」演成「没数据」）：
 * 1. `from`/`to` 为空**不是**「最近 N 个点」，而是 `time >= 0` 升序取**最早的** N 个点
 *    （`IotDbTimeSeriesStore`：`ORDER BY time ASC LIMIT n`）⇒ 默认必须是显式的最近 24 小时；
 * 2. 「时序库未启用」等业务错误走 reject，必须原样展示后端 message，**绝不能**渲染成「该时间范围内无数据」；
 * 3. 后端一次只接受**一个**点位（`TimeSeriesQueryReq.propertyId` 单值）⇒ 多选由前端扇出多次请求后合并
 *    （见 {@link runQuery} 的实现方式与代价）。
 */
interface SeriesDrawerData {
  deviceCode?: string;
  deviceName?: string;
  id: string;
  /**
   * 可选：打开时就选好的点位**标识符**。
   * 供设备详情「属性与点位」逐行点「历史曲线」复用本抽屉（不重画一套图表逻辑）。
   */
  propertyId?: string;
  /** 设备绑定的产品：用来把点位映射的属性主键翻译成标识符（详情页入口本轮已补传）。 */
  productId?: string;
}

/** 下拉里的一个候选（`label` 供搜索，`chartName` 供图例/明细，避免两处重复拼字符串）。 */
interface SelectOption {
  chartName: string;
  label: string;
  mapped: boolean;
  orphan: boolean;
  unit: string;
  value: string;
}

const deviceId = ref('');
const deviceLabel = ref('');
const productId = ref('');

/** 候选点位（映射 + 物模型连接结果）与手工补充的点位标识。 */
const pointOptions = ref<SeriesPointOption[]>([]);
const manualPoints = ref<string[]>([]);
const optionErrors = ref<{ model: string; points: string }>({
  model: '',
  points: '',
});
const optionsLoading = ref(false);
const selectedPoints = ref<string[]>([]);
const manualInput = ref('');
/** 物模型不可用（未绑产品 / 产品无属性）⇒ 映射点位只能按主键查，必须告警而不是让它显示成「无数据」 */
const modelHint = ref<ModelHint>(null);

const rangeMode = ref<SeriesRangeMode>(IOT_SERIES_DEFAULT_RANGE_MODE);
const customRange = ref<[Dayjs, Dayjs]>();
// 注意：`autoRefresh` 现由 `useSeriesLive` 提供（与实时跟随互斥，见该组合式注释）
/**
 * `InputNumber` 的 `value`/`update:value` 类型是 `string | number`（antdv 4.2.6 的 `ValueType`），
 * 故按组件实际类型声明；提交查询前统一 `Number()` 并校验整数范围。
 */
const limit = ref<number | string>(IOT_SERIES_DEFAULT_LIMIT);

const loading = ref(false);
const queried = ref(false);

/**
 * 最近一次查询的条件快照：明细/图表/导出/自动刷新都按它渲染，
 * 避免用户改了输入框却仍在看（或被导出成）上一次口径的数据。
 */
const results = ref<SeriesQueryResult[]>([]);
/**
 * 查询返回时各点位的原始条数。
 *
 * 为什么单独存：实时跟随会往 `results[*].points` 追加点，若用「当前长度 >= limit」判断截断，
 * 追加几个点就会把原本没打满 limit 的查询误报成「可能截断了较晚的数据」。
 */
const queryPointCounts = ref<Record<string, number>>({});
const usedPoints = ref<string[]>([]);
const usedRange = ref<SeriesResolvedRange>({ unbounded: false });
const usedLimit = ref<number>(IOT_SERIES_DEFAULT_LIMIT);
/** 自动刷新要重放的档位：快捷档位每次按「当前时刻」重算窗口（滑动窗口），自定义档位保持固定。 */
const usedMode = ref<SeriesRangeMode>(IOT_SERIES_DEFAULT_RANGE_MODE);
const usedCustom = ref<{ from?: number; to?: number }>({});

const [Drawer, drawerApi] = useVbenDrawer<SeriesDrawerData>({
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      // 关掉抽屉必须停表、退订：否则切走后仍在后台按周期打后端，或在内存里继续追加实时点
      stopAutoRefresh();
      resetLiveFollow();
      return;
    }
    // 换设备 / 重新打开：跟随开关回到关闭，清空上一轮的计数与订阅
    resetLiveFollow();
    const device = drawerApi.getData();
    // 每次打开都回到初始态：不把上一台设备的查询结果留在抽屉里
    deviceId.value = device?.id ?? '';
    deviceLabel.value =
      device?.deviceName ?? device?.deviceCode ?? deviceId.value;
    productId.value = device?.productId ?? '';
    const presetPropertyId = device?.propertyId ?? '';
    const preferences = loadSeriesPreferences();
    rangeMode.value = preferences.rangeMode ?? IOT_SERIES_DEFAULT_RANGE_MODE;
    limit.value = preferences.limit ?? IOT_SERIES_DEFAULT_LIMIT;
    customRange.value = undefined;
    // 上次用的是自定义档位：把时间框预填成默认窗口，避免「档位=自定义但两个时刻为空」→ 空范围查询
    if (rangeMode.value === 'custom') {
      ensureCustomRange();
    }
    manualPoints.value = [];
    manualInput.value = '';
    autoRefresh.value = false;
    selectedPoints.value = [];
    pointOptions.value = [];
    optionErrors.value = { model: '', points: '' };
    results.value = [];
    queried.value = false;
    modelHint.value = null;
    usedPoints.value = [];
    usedRange.value = { unbounded: false };
    usedLimit.value = IOT_SERIES_DEFAULT_LIMIT;
    usedMode.value = rangeMode.value;
    usedCustom.value = {};
    drawerApi.setState({
      title: deviceLabel.value
        ? `${$t('page.iot.series.title')} - ${deviceLabel.value}`
        : $t('page.iot.series.title'),
    });
    await loadOptions(presetPropertyId);
    // 打开即按默认条件（第一个点位 + 最近 24 小时）出图：用户不必先点一次查询才知道能看什么
    if (selectedPoints.value.length > 0) {
      await onQuery();
    }
  },
});

/** 点位显示名：属性名（标识符）；孤儿点只有主键，另外标注。 */
function displayName(option: SeriesPointOption): string {
  if (option.orphan) {
    return $t('page.iot.series.orphanOption', [option.propertyId]);
  }
  const name = option.propertyName?.trim();
  return name ? `${name}（${option.identifier}）` : option.identifier;
}

/** 图例/明细用的短名：属性名优先（下拉里已经带了标识符，图上再重复一遍只会挤）。 */
function chartName(option: SeriesPointOption): string {
  if (option.orphan) {
    return $t('page.iot.series.orphanOption', [option.propertyId]);
  }
  return option.propertyName?.trim() || option.identifier;
}

/**
 * 下拉候选 = 映射点位（经物模型翻译成标识符）+ 未映射的产品属性 + 手工补充的点位。
 *
 * 未映射的属性也列出来是刻意的：设备一个点位都没配时，下拉若是空的，用户连「查了才知道没数据」都做不到。
 */
const selectOptions = computed<SelectOption[]>(() => {
  const options: SelectOption[] = pointOptions.value.map((option) => ({
    chartName: chartName(option),
    label: displayName(option),
    mapped: option.mapped,
    orphan: option.orphan,
    unit: option.unit ?? '',
    value: option.value,
  }));
  const known = new Set(options.map((option) => option.value));
  for (const value of manualPoints.value) {
    if (known.has(value)) {
      continue;
    }
    known.add(value);
    options.push({
      chartName: value,
      label: $t('page.iot.series.manualOption', [value]),
      mapped: true,
      orphan: false,
      unit: '',
      value,
    });
  }
  return options;
});

const optionByValue = computed(
  () => new Map(selectOptions.value.map((option) => [option.value, option])),
);

/** 解析不出属性标识符的候选个数（这些点位只能按属性主键查，多半查不到）。 */
const orphanCount = computed(() => countOrphanPoints(pointOptions.value));

const optionsEmpty = computed(
  () =>
    !optionsLoading.value &&
    selectOptions.value.length === 0 &&
    optionErrors.value.points === '' &&
    optionErrors.value.model === '',
);

/** 物模型不可用的告警文案（降级原因由 {@link resolveModelHint} 判定，这里只负责选词）。 */
const modelWarning = computed(() => {
  if (modelHint.value === 'noProduct') {
    return $t('page.iot.series.noProductHint');
  }
  if (modelHint.value === 'emptyModel') {
    return $t('page.iot.series.emptyModelHint');
  }
  return '';
});

/**
 * 「解析不出属性标识符」的点位个数告警。
 *
 * 与 `modelWarning` 分开判：物模型只有部分属性（部分属性被删）或物模型读取失败时，
 * `modelHint` 是 `null`，但那些点位**同样只能按属性主键查**（坐标统一后存的是标识符 ⇒ 多半 0 条），
 * 不能因为「物模型整体可用」就不告警。
 */
const orphanWarning = computed(() =>
  orphanCount.value > 0
    ? $t('page.iot.series.orphanHint', [String(orphanCount.value)])
    : '',
);

// ---------- 取点位候选 ----------

/** 物模型属性（属性挂在服务下，故先取服务再扇出取属性；服务数量是个位数，不存在按设备循环的 N+1）。 */
async function loadProductProperties(): Promise<
  IotThingModelApi.PropertyResp[]
> {
  const boundProductId = productId.value;
  if (!boundProductId) {
    return [];
  }
  const services = (await listServices(boundProductId)) ?? [];
  const groups = await Promise.all(
    services.map(async (service) => ({
      properties: (await listProperties(boundProductId, service.id)) ?? [],
    })),
  );
  return flattenProperties(groups);
}

/**
 * 拉点位候选并默认选中。
 *
 * 两个数据源各自独立报错（不合并、不静默兜底）：点位映射读不到（如缺 `iot:point:list` 权限）时，
 * 至少还有物模型属性可查；物模型读不到时，映射仍按「属性主键」形态列出（后端对这种形态按原样查，
 * 恰好命中坐标统一之前的存量行）。两条都断时还有「高级选项 → 手动补充点位标识」兜底。
 */
async function loadOptions(presetPropertyId: string) {
  if (!deviceId.value) {
    return;
  }
  optionsLoading.value = true;
  optionErrors.value = { model: '', points: '' };
  const [pointsResult, propertiesResult] = await Promise.allSettled([
    getDevicePoints(deviceId.value),
    loadProductProperties(),
  ]);
  const points: IotPointApi.PointMappingResp[] =
    pointsResult.status === 'fulfilled' ? (pointsResult.value ?? []) : [];
  if (pointsResult.status === 'rejected') {
    optionErrors.value.points = extractErrorMessage(
      pointsResult.reason,
      $t('page.iot.point.loadFailed'),
    );
  }
  const properties: IotThingModelApi.PropertyResp[] =
    propertiesResult.status === 'fulfilled' ? propertiesResult.value : [];
  if (propertiesResult.status === 'rejected') {
    optionErrors.value.model = extractErrorMessage(
      propertiesResult.reason,
      $t('page.iot.product.modelLoadFailed'),
    );
  }
  pointOptions.value = buildPointOptions(points, properties);
  // 物模型**读取失败**时不给「物模型里没有属性」的结论（原因不同，别把失败说成空）
  modelHint.value =
    propertiesResult.status === 'rejected'
      ? null
      : resolveModelHint(productId.value !== '', properties.length);
  optionsLoading.value = false;

  // 详情页逐行点进来时会把标识符带进来：候选里有就选它；没有就当作手工点位补进候选（不丢入口）
  if (presetPropertyId) {
    manualPoints.value = [presetPropertyId];
    selectedPoints.value = [presetPropertyId];
    return;
  }
  // 解析不出标识符（孤儿点）**不默认选中**：按属性主键查多半是 0 条，自动选它再自动查一次，
  // 等于把「查不到」摆成「没有数据」。让用户显式选（或用高级选项里的手动输入填标识符）。
  const first = selectOptions.value[0];
  selectedPoints.value = first && !first.orphan ? [first.value] : [];
}

// ---------- 查询 ----------

/** 自定义档位的时间框为空时预填「最近 24 小时」，避免用户没选时刻就查成「最早的 N 个点」。 */
function ensureCustomRange(): void {
  if (customRange.value) {
    return;
  }
  const preset = resolveSeriesRange(
    IOT_SERIES_DEFAULT_RANGE_MODE,
    {},
    Date.now(),
  );
  customRange.value = [
    dayjs(preset.from ?? Date.now()),
    dayjs(preset.to ?? Date.now()),
  ];
}

function currentRange(): SeriesResolvedRange {
  const custom = customRange.value
    ? {
        from: customRange.value[0].valueOf(),
        to: customRange.value[1].valueOf(),
      }
    : {};
  return resolveSeriesRange(rangeMode.value, custom, Date.now());
}

/**
 * 执行查询。
 *
 * **多点位的实现方式与代价**：后端 `TimeSeriesQueryReq.propertyId` 是单值（一次只能查一个点位），
 * 故多选时前端对每个点位各发一次请求，再用 `Promise.allSettled` 合并渲染。
 * 选 `allSettled` 并发而不是逐条串行：5 个点位串行 = 把 5 次后端查询延迟相加，体感很明显；
 * 代价是瞬时并发 5 个查询，故**点位数上限硬编码为 {@link IOT_SERIES_MAX_SELECTED_POINTS}（5）**。
 * 每个点位的失败各自独立展示：一个点位报错不影响其它曲线渲染，也不会被吞成「无数据」。
 */
async function runQuery(
  targets: string[],
  range: SeriesResolvedRange,
  limitValue: number,
): Promise<void> {
  loading.value = true;
  // 每次重查都会**替换** results：上一轮内存里跟随的点不复存在，计数必须归零（不能虚报已跟随）
  live.resetLiveCounters();
  try {
    const settled = await Promise.allSettled(
      targets.map(
        async (propertyId) =>
          (await getDeviceSeries(deviceId.value, {
            from: range.from,
            limit: limitValue,
            propertyId,
            to: range.to,
          })) ?? [],
      ),
    );
    results.value = settled.map((item, index) => {
      const propertyId = targets[index] ?? '';
      const option = optionByValue.value.get(propertyId);
      const base = {
        name: option?.chartName ?? propertyId,
        propertyId,
        unit: option?.unit ?? '',
      };
      return item.status === 'fulfilled'
        ? { ...base, error: '', points: item.value }
        : {
            ...base,
            error: extractErrorMessage(
              item.reason,
              $t('page.iot.series.queryFailed'),
            ),
            points: [],
          };
    });
  } finally {
    loading.value = false;
  }
  queryPointCounts.value = Object.fromEntries(
    results.value.map((item) => [item.propertyId, item.points.length]),
  );
  queried.value = true;
  usedPoints.value = [...targets];
  usedRange.value = range;
  usedLimit.value = limitValue;
}

/** 查询入口：先把注定失败的请求拦下来（点位/设备缺失、limit 越界、起始晚于结束）。 */
async function onQuery(): Promise<void> {
  if (deviceId.value === '') {
    message.error($t('page.iot.series.deviceMissing'));
    return;
  }
  const targets = [...selectedPoints.value];
  if (targets.length === 0) {
    message.error($t('page.iot.series.propertyIdRequired'));
    return;
  }
  const limitValue = Number(limit.value);
  if (
    !Number.isInteger(limitValue) ||
    limitValue < 1 ||
    limitValue > IOT_SERIES_MAX_LIMIT
  ) {
    message.error(
      $t('page.iot.series.limitInvalid', [String(IOT_SERIES_MAX_LIMIT)]),
    );
    return;
  }
  const range = currentRange();
  if (
    range.from !== undefined &&
    range.to !== undefined &&
    range.from > range.to
  ) {
    message.error($t('page.iot.series.timeRangeInvalid'));
    return;
  }
  usedMode.value = rangeMode.value;
  usedCustom.value = { from: range.from, to: range.to };
  saveSeriesPreferences({ limit: limitValue, rangeMode: rangeMode.value });
  await runQuery(targets, range, limitValue);
  restartAutoRefresh();
}

/** 快捷档位是一次明确点击 ⇒ 直接出曲线（自定义档位等用户把两个时刻选完再自动查）。 */
function onPickRange(mode: SeriesRangeMode): void {
  rangeMode.value = mode;
  if (mode === 'custom') {
    ensureCustomRange();
    return;
  }
  if (selectedPoints.value.length > 0) {
    void onQuery();
  }
}

/**
 * 自定义时间范围变化 ⇒ 写回 `customRange` 并自动重查。
 *
 * 这里显式写回而不是 `v-model`：RangePicker 的 `value` prop 类型是 `[Dayjs, Dayjs] | [string, string]`，
 * 而更新事件给的是 `[Dayjs | null, Dayjs | null] | null`，双向绑定会让「半选的区间」把 null 灌进 ref。
 */
function onCustomRangeChange(value: unknown): void {
  const pair = value as [Dayjs | null, Dayjs | null] | null | undefined;
  if (!pair?.[0] || !pair[1]) {
    customRange.value = undefined;
    return;
  }
  customRange.value = [pair[0], pair[1]];
  if (selectedPoints.value.length > 0) {
    void onQuery();
  }
}

/** 多选上限：Select 的 `maxCount` 在 antdv 4.2 上不保证存在，改在 change 里裁剪（行为可控且能给出提示）。 */
function onPointsChange(values: unknown): void {
  const list = (Array.isArray(values) ? values : [values])
    .map(String)
    .filter((item) => item !== '');
  if (list.length > IOT_SERIES_MAX_SELECTED_POINTS) {
    message.warning(
      $t('page.iot.series.maxPoints', [String(IOT_SERIES_MAX_SELECTED_POINTS)]),
    );
    selectedPoints.value = list.slice(0, IOT_SERIES_MAX_SELECTED_POINTS);
  }
}

/** 手工补一个点位标识（候选不可用时的兜底；口径与后端 `PropertyIdRules` 一致）。 */
function onAddManualPoint(): void {
  const value = manualInput.value.trim();
  if (value === '') {
    return;
  }
  if (!isValidPropertyId(value)) {
    message.error($t('page.iot.series.manualInvalid'));
    return;
  }
  if (selectOptions.value.some((option) => option.value === value)) {
    message.warning($t('page.iot.series.manualExists'));
    return;
  }
  manualPoints.value = [...manualPoints.value, value];
  if (selectedPoints.value.length < IOT_SERIES_MAX_SELECTED_POINTS) {
    selectedPoints.value = [...selectedPoints.value, value];
  }
  manualInput.value = '';
}

// ---------- 图表与明细 ----------

const chartModel = computed(() => buildChartModel(results.value));
const units = computed(() => chartUnits(results.value));
const hasChart = computed(() => chartModel.value.length > 0);

/** 所有**成功**结果的点（失败的点位不参与统计，避免把失败算成 0 条） */
const loadedPoints = computed(() =>
  results.value.flatMap((item) => (item.error === '' ? item.points : [])),
);
const totalCount = computed(() => loadedPoints.value.length);
const numericTotal = computed(() => numericCount(loadedPoints.value));

/** 非数值点的提示：全为文本时不画曲线；部分文本时曲线会断开（都不静默忽略）。 */
const valueHint = computed(() => {
  const nonNumeric = totalCount.value - numericTotal.value;
  if (totalCount.value === 0 || nonNumeric === 0) {
    return '';
  }
  return nonNumeric === totalCount.value
    ? $t('page.iot.series.nonNumeric')
    : $t('page.iot.series.partialNumeric', [String(nonNumeric)]);
});

/** 条数打满本次请求的上限 ⇒ 升序返回，可能截断了较晚的数据（不静默当成「就这么多」）。 */
function reachedLimit(item: SeriesQueryResult): boolean {
  // 只看**查询返回时**的条数：实时跟随追加的点不能把提示误触出来
  const count = queryPointCounts.value[item.propertyId] ?? 0;
  return count > 0 && count >= usedLimit.value;
}

const failedCount = computed(
  () => results.value.filter((item) => item.error !== '').length,
);

const noData = computed(
  () =>
    results.value.length > 0 &&
    failedCount.value === 0 &&
    totalCount.value === 0,
);

const multiSeries = computed(() => usedPoints.value.length > 1);

const detail = computed(() =>
  buildDetailRows(results.value, IOT_SERIES_TABLE_MAX_ROWS),
);

const usedRangeLabel = computed(() =>
  formatRangeLabel(usedRange.value.from, usedRange.value.to),
);

// ---------- 实时跟随 + 自动刷新（组合式） ----------

/**
 * 实时跟随与自动刷新互斥、生命周期一致（关抽屉/卸载都要停），因此由 `useSeriesLive` 统一管理：
 * 这里只注入「设备 id / 曲线是否可见 / 结果容器 / 上次查询条件 / 重放函数」这些宿主能力。
 */
const live = useSeriesLive({
  getDeviceId: () => deviceId.value,
  hasChart,
  isLoading: () => loading.value,
  results,
  runQuery: (targets, range, limitValue) =>
    runQuery(targets, range, limitValue),
  usedCustom,
  usedLimit,
  usedMode,
  usedPoints,
});

const {
  autoRefresh,
  liveDroppedCount,
  liveFollow,
  liveFollowedCount,
  liveNonGoodCount,
  liveState,
  realtimeError,
  realtimeState,
  resetLiveFollow,
  restartAutoRefresh,
  stopAutoRefresh,
} = live;

// ---------- CSV 导出 ----------

/**
 * 导出 CSV（含公式注入防护与毫秒精度）。
 *
 * 单点位沿用既有的三列「时间,数值,质量码」；多点位叠加时首列补「点位」，
 * 否则多行数据混在一起无法区分属于哪个点位。
 */
function onExport(): void {
  if (detail.value.total === 0) {
    return;
  }
  const withPoint = multiSeries.value;
  const header = withPoint
    ? [
        $t('page.iot.series.pointColumn'),
        $t('page.iot.series.ts'),
        $t('page.iot.series.value'),
        $t('page.iot.series.quality'),
      ]
    : [
        $t('page.iot.series.ts'),
        $t('page.iot.series.value'),
        $t('page.iot.series.quality'),
      ];
  const csv = buildCsv(header, buildCsvRows(results.value, withPoint));
  // 前置 BOM：Excel 直接打开 UTF-8 CSV 时不乱码
  downloadByBlob(
    new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }),
    seriesCsvFileName(deviceId.value, usedPoints.value, Date.now()),
  );
}
</script>
<template>
  <Drawer class="w-[min(1200px,96vw)]">
    <div class="mb-3 text-sm text-muted-foreground">
      {{ $t('page.iot.series.device') }}：{{ deviceLabel || '-' }}
    </div>

    <!-- ===== 第 1 步：选点位（下拉候选，不再手填标识符） ===== -->
    <div class="mb-1 text-sm font-medium">
      {{ $t('page.iot.series.stepPoint') }}
    </div>
    <Spin :spinning="optionsLoading">
      <Alert
        v-if="optionErrors.points"
        :message="optionErrors.points"
        class="mb-2"
        show-icon
        type="error"
      />
      <Alert
        v-if="optionErrors.model"
        :message="optionErrors.model"
        class="mb-2"
        show-icon
        type="warning"
      />
      <!--
        降级提示按「最相关的先说」排成 v-else-if 链，同一时刻**只给一条**：
        物模型不可用（根因 + 动作）→ 个别点位解析不出标识符（数量 + 手动补录）→ 候选为空（去配点位映射）。
        上面的两条 error Alert 是**真实失败**，与提示不互斥（失败必须报，提示负责给下一步）。
      -->
      <Alert
        v-if="modelWarning"
        :message="modelWarning"
        class="mb-2"
        show-icon
        type="warning"
      />
      <Alert
        v-else-if="orphanWarning"
        :message="orphanWarning"
        class="mb-2"
        show-icon
        type="warning"
      />
      <Alert
        v-else-if="optionsEmpty"
        :message="$t('page.iot.series.optionsEmpty')"
        class="mb-2"
        show-icon
        type="warning"
      />
      <Select
        v-model:value="selectedPoints"
        :disabled="!deviceId"
        :max-tag-count="1"
        :options="selectOptions"
        :placeholder="$t('page.iot.series.pointPlaceholder')"
        allow-clear
        class="w-full"
        mode="multiple"
        option-filter-prop="label"
        show-search
        @change="onPointsChange"
      >
        <template #option="option">
          <div class="flex items-center justify-between gap-2">
            <span>{{ option.label }}</span>
            <span class="flex shrink-0 items-center gap-1">
              <Tag v-if="option.unit">{{ option.unit }}</Tag>
              <Tag v-if="option.orphan" color="orange">
                {{ $t('page.iot.series.orphanTag') }}
              </Tag>
              <Tag v-else-if="!option.mapped" color="default">
                {{ $t('page.iot.series.unmappedTag') }}
              </Tag>
            </span>
          </div>
        </template>
      </Select>
    </Spin>
    <div class="mt-1 text-xs text-muted-foreground">
      {{
        $t('page.iot.series.pointHint', [
          String(IOT_SERIES_MAX_SELECTED_POINTS),
        ])
      }}
    </div>

    <!-- ===== 第 2 步：选时间（默认最近 24 小时 + 快捷档位） ===== -->
    <div class="mt-4 mb-1 text-sm font-medium">
      {{ $t('page.iot.series.stepTime') }}
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <RadioGroup v-model:value="rangeMode" button-style="solid" size="small">
        <RadioButton value="1h" @click="onPickRange('1h')">
          {{ $t('page.iot.series.range1h') }}
        </RadioButton>
        <RadioButton value="6h" @click="onPickRange('6h')">
          {{ $t('page.iot.series.range6h') }}
        </RadioButton>
        <RadioButton value="24h" @click="onPickRange('24h')">
          {{ $t('page.iot.series.range24h') }}
        </RadioButton>
        <RadioButton value="7d" @click="onPickRange('7d')">
          {{ $t('page.iot.series.range7d') }}
        </RadioButton>
        <RadioButton value="custom" @click="onPickRange('custom')">
          {{ $t('page.iot.series.rangeCustom') }}
        </RadioButton>
      </RadioGroup>
      <DatePicker.RangePicker
        v-if="rangeMode === 'custom'"
        :allow-clear="false"
        class="w-[360px]"
        show-time
        :value="customRange"
        @change="onCustomRangeChange"
      />
    </div>
    <div class="mt-1 text-xs text-muted-foreground">
      {{ $t('page.iot.series.rangeHint') }}
    </div>

    <!-- ===== 第 3 步：查（limit 与自动刷新都不在主流程上） ===== -->
    <div class="mt-4 flex flex-wrap items-center gap-3">
      <Button :loading="loading" type="primary" @click="onQuery">
        {{ $t('page.iot.series.query') }}
      </Button>
      <!-- 无数据时禁用导出并说明原因（灰按钮不给理由 = 用户以为功能坏了） -->
      <Tooltip :title="detail.total === 0 ? $t('page.iot.series.empty') : ''">
        <span :tabindex="detail.total === 0 ? 0 : -1" class="inline-block">
          <Button :disabled="detail.total === 0" @click="onExport">
            {{ $t('page.iot.series.exportCsv') }}
          </Button>
        </span>
      </Tooltip>
      <span class="flex items-center gap-2 text-sm">
        <Switch
          v-model:checked="autoRefresh"
          :aria-label="$t('page.iot.series.autoRefresh')"
          size="small"
        />
        {{ $t('page.iot.series.autoRefresh') }}
        <span class="text-xs text-muted-foreground">
          {{
            $t('page.iot.series.autoRefreshHint', [
              String(IOT_SERIES_AUTO_REFRESH_MS / 1000),
            ])
          }}
        </span>
      </span>
      <span class="flex items-center gap-2 text-sm">
        <Switch
          v-model:checked="liveFollow"
          :disabled="!hasChart"
          size="small"
        />
        {{ $t('page.iot.series.liveFollow') }}
        <Tag :color="liveState.color">{{ liveState.text }}</Tag>
        <span class="text-xs text-muted-foreground">
          {{
            hasChart
              ? $t('page.iot.series.liveFollowHint', [
                  String(IOT_SERIES_LIVE_MAX_POINTS),
                ])
              : $t('page.iot.series.liveUnavailable')
          }}
        </span>
      </span>
    </div>

    <Collapse class="mt-3" ghost>
      <CollapsePanel key="advanced" :header="$t('page.iot.series.advanced')">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-sm">{{ $t('page.iot.series.limit') }}</span>
          <InputNumber
            v-model:value="limit"
            class="w-[140px]"
            :max="IOT_SERIES_MAX_LIMIT"
            :min="1"
            :step="100"
          />
          <span class="text-xs text-muted-foreground">
            {{
              $t('page.iot.series.limitHint', [
                String(IOT_SERIES_DEFAULT_LIMIT),
                String(IOT_SERIES_MAX_LIMIT),
              ])
            }}
          </span>
        </div>
        <div class="mt-3">
          <div class="text-sm">{{ $t('page.iot.series.manualPoint') }}</div>
          <div class="mt-1 text-xs text-muted-foreground">
            {{ $t('page.iot.series.manualHint') }}
          </div>
          <div class="mt-2 flex items-center gap-2">
            <Input
              v-model:value="manualInput"
              class="w-[240px]"
              :placeholder="$t('page.iot.series.manualPlaceholder')"
              @press-enter="onAddManualPoint"
            />
            <Button size="small" @click="onAddManualPoint">
              {{ $t('page.iot.series.manualAdd') }}
            </Button>
          </div>
          <div class="mt-2 text-xs text-muted-foreground">
            {{
              manualPoints.length > 0
                ? manualPoints.join(', ')
                : $t('page.iot.series.manualEmpty')
            }}
          </div>
        </div>
      </CollapsePanel>
    </Collapse>

    <Spin :spinning="loading">
      <div class="mt-4">
        <template v-if="queried">
          <div class="mb-2 text-sm text-muted-foreground">
            {{ $t('page.iot.series.seriesCount', [String(usedPoints.length)]) }}
            ·
            {{ usedRangeLabel || $t('page.iot.series.rangeUnboundedShort') }}
            ·
            {{ $t('page.iot.series.limitUsed', [String(usedLimit)]) }}
            <span v-if="totalCount > 0">
              ·
              {{ $t('page.iot.series.pointCount', [String(totalCount)]) }}
            </span>
          </div>

          <!-- 未限定时间范围：这是「最早的 N 个点」，不是「最近的 N 个点」，必须说清楚 -->
          <Alert
            v-if="usedRange.unbounded"
            :message="$t('page.iot.series.rangeUnbounded', [String(usedLimit)])"
            class="mb-2"
            show-icon
            type="warning"
          />
          <Alert
            v-if="autoRefresh && !loading"
            :message="
              $t('page.iot.series.autoRefreshing', [
                String(IOT_SERIES_AUTO_REFRESH_MS / 1000),
              ])
            "
            class="mb-2"
            show-icon
            type="info"
          />
          <template v-if="liveFollow">
            <!-- 断线必须可见（Tag 变黄 + 这条 Alert），不得让曲线静止而用户以为设备没上报 -->
            <Alert
              v-if="realtimeState === 'reconnecting'"
              class="mb-2"
              :description="realtimeError || undefined"
              :message="$t('page.iot.series.liveReconnectingDesc')"
              show-icon
              type="warning"
            />
            <div class="mb-2 text-xs text-muted-foreground">
              {{
                $t('page.iot.series.liveFollowed', [String(liveFollowedCount)])
              }}
              <span v-if="liveDroppedCount > 0">
                ·
                {{
                  $t('page.iot.series.liveDropped', [String(liveDroppedCount)])
                }}
              </span>
              <span v-if="liveNonGoodCount > 0">
                ·
                {{
                  $t('page.iot.series.liveNonGood', [String(liveNonGoodCount)])
                }}
              </span>
            </div>
          </template>

          <!-- 逐点位状态：失败原样展示后端 message，空数据与失败严格分开 -->
          <div v-for="item in results" :key="item.propertyId" class="mb-2">
            <Alert
              v-if="item.error"
              :message="`${item.name}：${item.error}`"
              show-icon
              type="error"
            />
            <Alert
              v-else-if="item.points.length === 0 && !noData"
              :message="$t('page.iot.series.pointEmpty', [item.name])"
              show-icon
              type="info"
            />
            <Alert
              v-else-if="reachedLimit(item)"
              :message="`${item.name}：${$t('page.iot.series.limitReachedAsc', [String(usedLimit)])}`"
              show-icon
              type="warning"
            />
          </div>

          <Empty v-if="noData" :description="$t('page.iot.series.empty')" />
          <template v-else-if="detail.total > 0">
            <!-- 图表子组件：model/units 一变就重绘，宿主不再手工调 renderChart() -->
            <SeriesChart :model="chartModel" :units="units" />
            <Alert
              v-if="valueHint"
              :message="valueHint"
              show-icon
              type="warning"
            />

            <div class="mt-3 max-h-[320px] overflow-auto">
              <table class="w-full min-w-[560px] text-sm">
                <thead>
                  <tr class="text-left text-muted-foreground">
                    <th v-if="multiSeries" class="py-1">
                      {{ $t('page.iot.series.pointColumn') }}
                    </th>
                    <th class="py-1">{{ $t('page.iot.series.ts') }}</th>
                    <th class="py-1">{{ $t('page.iot.series.value') }}</th>
                    <th class="py-1">{{ $t('page.iot.series.quality') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in detail.rows"
                    :key="row.key"
                    class="border-t"
                  >
                    <td v-if="multiSeries" class="py-1">{{ row.name }}</td>
                    <td class="py-1">{{ row.ts }}</td>
                    <td class="py-1">{{ displayOrFallback(row.value) }}</td>
                    <td class="py-1">{{ qualityLabel(row.quality) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div
              v-if="detail.truncated"
              class="mt-1 text-xs text-muted-foreground"
            >
              {{
                $t('page.iot.series.detailTruncated', [
                  String(IOT_SERIES_TABLE_MAX_ROWS),
                  String(detail.total),
                ])
              }}
            </div>
          </template>
        </template>
        <Empty v-else :description="$t('page.iot.series.idle')" />
      </div>
    </Spin>
  </Drawer>
</template>
