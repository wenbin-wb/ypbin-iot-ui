/**
 * 历史曲线「查询域」组合式（审查 P2-6 / 05 §2.3 拆分之二）。
 *
 * 收口一次查询的全部逻辑，页面只剩「条件 UI + 图表 + 实时跟随」：
 * 1. **点位候选**：点位映射 + 物模型属性（两个数据源各自失败各自报错，不互相掩盖），
 *    外加「手工补充点位标识」兜底；
 * 2. **时间范围**：快捷档位（滑动窗口，按当前时刻重算）与自定义区间；
 * 3. **扇出查询**：后端一次只接受一个 `propertyId` ⇒ 多选时 `Promise.allSettled` 并发合并，
 *    每个点位独立失败（一个点位报错不影响其它曲线，也不被吞成「无数据」）；
 * 4. **结果派生**：图表模型/单位、明细行（含截断）、非数值提示、空/失败判据、CSV 导出数据源。
 *
 * 依赖注入说明：本文件不直接 import 任何 UI 组件，`useSeriesLive` 需要的
 * 「查询前清实时计数 / 查询后重启自动刷新」通过 `hooks` 可变钩子注入，避免与 live 组合式循环依赖。
 */
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

import { message } from 'ant-design-vue';
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
  IOT_SERIES_DEFAULT_RANGE_MODE,
  IOT_SERIES_MAX_SELECTED_POINTS,
  IOT_SERIES_TABLE_MAX_ROWS,
  isValidPropertyId,
  numericCount,
  resolveModelHint,
  resolveSeriesRange,
  saveSeriesPreferences,
  seriesCsvFileName,
} from './series-utils';

/** 下拉里的一个候选（`label` 供搜索，`chartName` 供图例/明细，避免两处重复拼字符串）。 */
export interface SeriesSelectOption {
  chartName: string;
  label: string;
  mapped: boolean;
  orphan: boolean;
  unit: string;
  value: string;
}

/**
 * 查询域与实时跟随域之间的钩子（可变，装配阶段由宿主注入）。
 *
 * 为什么不直接依赖 `useSeriesLive`：live 需要本组合式的 `runQuery`，本组合式又要在
 * 「查询前清计数 / 查询后重启自动刷新」时调用 live ⇒ 互相 import 会成环。
 */
export interface SeriesQueryHooks {
  /** 每次重查前：清空实时跟随计数（`results` 被整批替换，内存点已不存在）。 */
  onBeforeQuery?: () => void;
  /** 查询成功后：重启自动刷新，让「上次条件」成为最新一次。 */
  onAfterQuery?: () => void;
}

export function useSeriesQuery(hooks: SeriesQueryHooks = {}) {
  // ---------------------------------------------------------------- 查询上下文

  const deviceId = ref('');
  const deviceLabel = ref('');
  const productId = ref('');

  // ---------------------------------------------------------------- 点位候选

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

  // ---------------------------------------------------------------- 条件与结果

  const rangeMode = ref<SeriesRangeMode>(IOT_SERIES_DEFAULT_RANGE_MODE);
  const customRange = ref<[Dayjs, Dayjs]>();
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
  const selectOptions = computed<SeriesSelectOption[]>(() => {
    const options: SeriesSelectOption[] = pointOptions.value.map((option) => ({
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

  // ---------------------------------------------------------------- 取点位候选

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

  // ---------------------------------------------------------------- 时间范围

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

  // ---------------------------------------------------------------- 查询

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
    hooks.onBeforeQuery?.();
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
    hooks.onAfterQuery?.();
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
        $t('page.iot.series.maxPoints', [
          String(IOT_SERIES_MAX_SELECTED_POINTS),
        ]),
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

  // ---------------------------------------------------------------- 结果派生

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

  // ---------------------------------------------------------------- 复位与导出

  /**
   * 打开抽屉时把查询域恢复到初始态（不把上一台设备的结果留在抽屉里）。
   *
   * @param preferencesRangeMode 上次使用的档位（localStorage 记忆）
   * @param preferencesLimit     上次使用的返回条数上限
   */
  function resetQuery(
    preferencesRangeMode: SeriesRangeMode,
    preferencesLimit: number | string,
  ) {
    rangeMode.value = preferencesRangeMode;
    limit.value = preferencesLimit;
    customRange.value = undefined;
    // 上次用的是自定义档位：把时间框预填成默认窗口，避免「档位=自定义但两个时刻为空」→ 空范围查询
    if (rangeMode.value === 'custom') {
      ensureCustomRange();
    }
    manualPoints.value = [];
    manualInput.value = '';
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
    queryPointCounts.value = {};
  }

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

  return {
    chartModel,
    customRange,
    detail,
    deviceId,
    deviceLabel,
    ensureCustomRange,
    failedCount,
    hasChart,
    limit,
    loadOptions,
    loading,
    manualInput,
    manualPoints,
    modelHint,
    modelWarning,
    multiSeries,
    noData,
    onAddManualPoint,
    onCustomRangeChange,
    onExport,
    onPickRange,
    onPointsChange,
    onQuery,
    optionByValue,
    optionErrors,
    optionsEmpty,
    optionsLoading,
    orphanCount,
    orphanWarning,
    pointOptions,
    productId,
    queried,
    queryPointCounts,
    rangeMode,
    reachedLimit,
    resetQuery,
    results,
    runQuery,
    selectOptions,
    selectedPoints,
    totalCount,
    units,
    usedCustom,
    usedLimit,
    usedMode,
    usedPoints,
    usedRange,
    usedRangeLabel,
    valueHint,
  };
}
