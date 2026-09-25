<script lang="ts" setup>
import type { IotSeriesApi } from '#/api/iot';
import type { EchartsUIType } from '@vben/plugins/echarts';
import type { Dayjs } from 'dayjs';

import { computed, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import {
  Alert,
  Button,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  message,
  Spin,
} from 'ant-design-vue';
import dayjs from 'dayjs';

import {
  getDeviceSeries,
  IOT_SERIES_DEFAULT_LIMIT,
  IOT_SERIES_MAX_LIMIT,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';
import { downloadByBlob } from '#/utils/file';

/** 抽屉数据：设备行（vben 的 `getData()` 不带类型参数，泛型要写在 useVbenDrawer 上）。 */
interface SeriesDrawerData {
  deviceCode?: string;
  deviceName?: string;
  id: string;
  /**
   * 可选：打开时就填好的点位标识。
   * 供设备详情「属性与点位」逐行点「历史曲线」复用本抽屉（不重画一套图表逻辑）。
   */
  propertyId?: string;
}

type SeriesPoint = IotSeriesApi.TimeSeriesPointResp;

const deviceId = ref('');
const deviceLabel = ref('');
const propertyId = ref('');
const fromValue = ref<Dayjs>();
const toValue = ref<Dayjs>();
/**
 * `InputNumber` 的 `value`/`update:value` 类型是 `string | number`（antdv 4.2.6 的 `ValueType`），
 * 故按组件实际类型声明；提交查询前统一 `Number()` 并校验整数范围。
 */
const limit = ref<number | string>(IOT_SERIES_DEFAULT_LIMIT);

const loading = ref(false);
const points = ref<SeriesPoint[]>([]);
/** 是否已发起过查询：区分「还没查」与「查了但没有数据」 */
const queried = ref(false);
/** 后端业务错误原文（如「历史时序查询未启用…」）——如实展示，绝不能显示成「没有数据」 */
const errorMessage = ref('');
/**
 * 最近一次查询的条件快照：明细/图表/导出都按它渲染，
 * 避免用户改了输入框却仍在看（或被导出成）上一次口径的数据。
 */
const usedPropertyId = ref('');
const usedLimit = ref<number>(IOT_SERIES_DEFAULT_LIMIT);

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

/** 图表配置类型取自 `renderEcharts` 的入参：echarts 不是本应用的直接依赖，不能直接 import 它的类型。 */
type SeriesChartOption = Parameters<typeof renderEcharts>[0];

const [Drawer, drawerApi] = useVbenDrawer<SeriesDrawerData>({
  onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      return;
    }
    const device = drawerApi.getData();
    // 每次打开都回到初始态：不把上一台设备的查询结果留在抽屉里
    deviceId.value = device?.id ?? '';
    deviceLabel.value =
      device?.deviceName ?? device?.deviceCode ?? deviceId.value;
    // 详情页逐行点「历史曲线」时会把点位带进来；不带时仍是空白（原行为不变）
    propertyId.value = device?.propertyId ?? '';
    fromValue.value = undefined;
    toValue.value = undefined;
    limit.value = IOT_SERIES_DEFAULT_LIMIT;
    points.value = [];
    queried.value = false;
    errorMessage.value = '';
    usedPropertyId.value = '';
    usedLimit.value = IOT_SERIES_DEFAULT_LIMIT;
    drawerApi.setState({
      title: deviceLabel.value
        ? `${$t('page.iot.series.title')} - ${deviceLabel.value}`
        : $t('page.iot.series.title'),
    });
  },
});

/** 后端 `ts` 为 epoch 毫秒（Long 序列化成字符串）⇒ 展示前 `Number()` 转换。 */
function toMillis(ts: number | string): null | number {
  const millis = Number(ts);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * 明细表与 CSV 的时间格式：**带毫秒**。
 * 时序点在同一秒内可能有多条读数，截到秒会让两行看起来一模一样，导出的 CSV 也就不是无损的。
 */
function formatTs(ts: number | string): string {
  const millis = toMillis(ts);
  return millis === null
    ? String(ts)
    : dayjs(millis).format('YYYY-MM-DD HH:mm:ss.SSS');
}

/** 图表横轴的时间格式：截到秒（轴标签空间有限，毫秒只会让同一秒的标签挤在一起、刻度变少）。 */
function formatAxisTs(ts: number | string): string {
  const millis = toMillis(ts);
  return millis === null
    ? String(ts)
    : dayjs(millis).format('YYYY-MM-DD HH:mm:ss');
}

/** 值转数字：空/非数值（文本点位）返回 null —— 折线在这些点断开，而不是被画成 0。 */
function toNumeric(value: null | string | undefined): null | number {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const numericCount = computed(
  () => points.value.filter((point) => toNumeric(point.value) !== null).length,
);

/** 是否存在可绘制的数值点：全是文本点位时不画空坐标系，只给明细表。 */
const hasNumeric = computed(() => numericCount.value > 0);

/** 非数值点的提示：全为文本时不画曲线；部分文本时曲线会断开（都不静默忽略）。 */
const valueHint = computed(() => {
  const nonNumeric = points.value.length - numericCount.value;
  if (points.value.length === 0 || nonNumeric === 0) {
    return '';
  }
  return nonNumeric === points.value.length
    ? $t('page.iot.series.nonNumeric')
    : $t('page.iot.series.partialNumeric', [String(nonNumeric)]);
});

/** 返回条数已打满本次请求的上限 ⇒ 可能被截断（不静默当成「就这么多」）。 */
const reachedLimit = computed(
  () => points.value.length > 0 && points.value.length >= usedLimit.value,
);

/** 历史曲线配置（连续量用折线；传感器读数不做 `smooth` 插值，避免读出并不存在的中间值）。 */
function buildChartOption(
  list: SeriesPoint[],
  property: string,
): SeriesChartOption {
  return {
    grid: { bottom: 8, containLabel: true, left: 8, right: 16, top: 24 },
    series: [
      {
        connectNulls: false,
        data: list.map((point) => toNumeric(point.value)),
        itemStyle: { color: '#0066f5' },
        lineStyle: { color: '#0066f5', width: 2 },
        name: property,
        showSymbol: list.length <= 200,
        smooth: false,
        type: 'line',
      },
    ],
    tooltip: { trigger: 'axis' },
    xAxis: {
      axisLabel: { hideOverlap: true },
      axisTick: { show: false },
      boundaryGap: false,
      data: list.map((point) => formatAxisTs(point.ts)),
      splitLine: { show: false },
      type: 'category',
    },
    yAxis: {
      axisTick: { show: false },
      // 传感器量程通常远离 0：强制从 0 起会把曲线压成一条直线，故按数据范围缩放
      scale: true,
      splitNumber: 4,
      type: 'value',
    },
  };
}

/**
 * CSV 单元格：先做公式注入防护，再做 RFC 4180 转义。
 *
 * 读数原值来自设备上报，属不可信输入：以 `=` 或 `@` 开头的文本会被 Excel/Sheets 当**公式**执行
 * （DDE 一类；参见 CVE-2021-41270 这类 CSV 注入案例），故前置单引号使其按文本处理。
 * `+`/`-` 不处理——它们是合法的数值前缀（负数），一刀切会把数值变成文本。
 */
function csvCell(cell: string): string {
  const guarded = /^[=@]/.test(cell) ? `'${cell}` : cell;
  return /["\r\n,]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** 导出文件名：设备 + 点位 + 时间戳（点位里的非安全字符统一换成下划线）。 */
function csvFileName(): string {
  const safeProperty = usedPropertyId.value.replace(/[^\w.-]+/g, '_');
  return `iot-series-${deviceId.value}-${safeProperty}-${dayjs().format('YYYYMMDD-HHmmss')}.csv`;
}

function onExport() {
  if (points.value.length === 0) {
    return;
  }
  const header = [
    $t('page.iot.series.ts'),
    $t('page.iot.series.value'),
    $t('page.iot.series.quality'),
  ];
  const rows = points.value.map((point) => [
    formatTs(point.ts),
    point.value ?? '',
    point.quality ?? '',
  ]);
  const csv = [header, ...rows]
    .map((cells) => cells.map((cell) => csvCell(cell)).join(','))
    .join('\r\n');
  // 前置 BOM：Excel 直接打开 UTF-8 CSV 时不乱码
  downloadByBlob(
    new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }),
    csvFileName(),
  );
}

/**
 * 查询：无效请求前端先拦（点位/设备缺失、limit 越界、起始晚于结束）——
 * 后端同样会拒，但前端不该把注定失败的请求发出去。
 */
async function onQuery() {
  const property = propertyId.value.trim();
  if (property === '') {
    message.error($t('page.iot.series.propertyIdRequired'));
    return;
  }
  if (deviceId.value === '') {
    message.error($t('page.iot.series.deviceMissing'));
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
  const from = fromValue.value?.valueOf();
  const to = toValue.value?.valueOf();
  if (from !== undefined && to !== undefined && from > to) {
    message.error($t('page.iot.series.timeRangeInvalid'));
    return;
  }

  loading.value = true;
  queried.value = true;
  errorMessage.value = '';
  points.value = [];
  usedPropertyId.value = property;
  usedLimit.value = limitValue;

  let loaded: SeriesPoint[] = [];
  let failed = '';
  try {
    loaded = (await getDeviceSeries(deviceId.value, {
      from,
      limit: limitValue,
      propertyId: property,
      to,
    })) ?? [];
  } catch (error) {
    // 「未启用时序库」等业务错误在这里原样落地（extractErrorMessage 优先取后端 message）；
    // 图表渲染失败不并入本分支，避免把渲染问题说成后端错误
    failed = extractErrorMessage(error, $t('page.iot.series.queryFailed'));
  } finally {
    loading.value = false;
  }

  points.value = loaded;
  errorMessage.value = failed;
  if (failed === '' && hasNumeric.value) {
    await renderEcharts(buildChartOption(loaded, property));
  }
}
</script>
<template>
  <Drawer class="w-[860px]">
    <div class="mb-3 text-sm text-muted-foreground">
      {{ $t('page.iot.series.device') }}：
      {{ deviceLabel || '-' }}
    </div>

    <div class="flex flex-wrap items-end gap-3">
      <div class="w-[220px]">
        <div class="mb-1 text-sm">{{ $t('page.iot.series.propertyId') }}</div>
        <Input
          v-model:value="propertyId"
          allow-clear
          :placeholder="$t('page.iot.series.propertyIdPlaceholder')"
          @press-enter="onQuery"
        />
      </div>
      <div>
        <div class="mb-1 text-sm">{{ $t('page.iot.series.from') }}</div>
        <DatePicker v-model:value="fromValue" class="w-[190px]" show-time />
      </div>
      <div>
        <div class="mb-1 text-sm">{{ $t('page.iot.series.to') }}</div>
        <DatePicker v-model:value="toValue" class="w-[190px]" show-time />
      </div>
      <div>
        <div class="mb-1 text-sm">{{ $t('page.iot.series.limit') }}</div>
        <InputNumber
          v-model:value="limit"
          class="w-[120px]"
          :max="IOT_SERIES_MAX_LIMIT"
          :min="1"
          :step="100"
        />
      </div>
      <Button :loading="loading" type="primary" @click="onQuery">
        {{ $t('page.iot.series.query') }}
      </Button>
      <Button :disabled="points.length === 0" @click="onExport">
        {{ $t('page.iot.series.exportCsv') }}
      </Button>
    </div>

    <Spin :spinning="loading">
      <div class="mt-4">
        <!-- 后端业务错误如实展示原文（如「历史时序查询未启用…」），不能显示成「没有数据」 -->
        <Alert
          v-if="errorMessage"
          :message="errorMessage"
          show-icon
          type="error"
        />
        <Empty
          v-else-if="queried && points.length === 0"
          :description="$t('page.iot.series.empty')"
        />
        <template v-else-if="points.length > 0">
          <div class="mb-2 text-sm text-muted-foreground">
            {{ usedPropertyId }} ·
            {{ $t('page.iot.series.pointCount', [String(points.length)]) }}
            <span v-if="reachedLimit" class="text-amber-600">
              （{{
                $t('page.iot.series.limitReached', [String(usedLimit)])
              }}）
            </span>
          </div>
          <EchartsUI v-if="hasNumeric" ref="chartRef" height="320px" />
          <Alert
            v-if="valueHint"
            :message="valueHint"
            show-icon
            type="warning"
          />

          <div class="mt-3 max-h-[320px] overflow-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-500">
                  <th class="py-1">{{ $t('page.iot.series.ts') }}</th>
                  <th class="py-1">{{ $t('page.iot.series.value') }}</th>
                  <th class="py-1">{{ $t('page.iot.series.quality') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(point, index) in points"
                  :key="`${point.ts}-${index}`"
                  class="border-t"
                >
                  <td class="py-1">{{ formatTs(point.ts) }}</td>
                  <td class="py-1">{{ point.value ?? '-' }}</td>
                  <td class="py-1">{{ point.quality ?? '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <Empty v-else :description="$t('page.iot.series.idle')" />
      </div>
    </Spin>
  </Drawer>
</template>
