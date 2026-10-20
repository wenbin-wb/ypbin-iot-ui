import type { SeriesQueryHooks } from './use-series-query';

import { createApp, defineComponent, h, nextTick } from 'vue';

import { i18n } from '@vben/locales';

import { message } from 'ant-design-vue';
import dayjs from 'dayjs';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { chartSeriesColorAt } from '#/utils/chart-tokens';

import SeriesChart from './series-chart.vue';
import SeriesDetailTable from './series-detail-table.vue';
import { buildChartModel, chartUnits } from './series-utils';
import { useSeriesQuery } from './use-series-query';

/**
 * 历史曲线「查询域 + 结果展示」用例（审查 P2-6 拆分后的新文件）。
 *
 * 守四件拆分后**最容易破**的事：
 * 1. **时间范围非法**：`from > to` 必须在前端拦下（后端会返回最早的 N 条，用户会误读成「没有数据」）；
 * 2. **空结果**：后端成功返回 0 条 ⇒ `noData`（空态），与「失败」严格分开；
 * 3. **多单位多 Y 轴**：不同量纲共轴会把曲线压扁 ⇒ 单位必须各自一条 Y 轴（图表组件级断言）；
 * 4. **截断行数**：明细超过上限时表格只展示前 N 行，但**必须**明确提示总行数（不静默「就这么多」）。
 *
 * 查询域是纯组合式（无 UI），用最小宿主组件驱动；图表/明细表直接挂真实组件（真实 i18n + 真实 antd）。
 */

const { chartOptions, fileMock, mockApi } = vi.hoisted(() => ({
  chartOptions: [] as Record<string, any>[],
  fileMock: { downloadBlobSafe: vi.fn(), downloadByBlob: vi.fn() },
  mockApi: {
    getDevicePoints: vi.fn(),
    getDeviceSeries: vi.fn(),
    listProperties: vi.fn(),
    listServices: vi.fn(),
  },
}));

vi.mock('#/utils/file', () => ({
  downloadBlobSafe: (...args: unknown[]) => fileMock.downloadBlobSafe(...args),
  downloadByBlob: (...args: unknown[]) => fileMock.downloadByBlob(...args),
}));

vi.mock('#/api/iot/point', () => ({
  getDevicePoints: (...args: unknown[]) => mockApi.getDevicePoints(...args),
}));

vi.mock('#/api/iot/series', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDeviceSeries: (...args: unknown[]) => mockApi.getDeviceSeries(...args),
  };
});

vi.mock('#/api/iot/thingmodel', () => ({
  listProperties: (...args: unknown[]) => mockApi.listProperties(...args),
  listServices: (...args: unknown[]) => mockApi.listServices(...args),
}));

vi.mock('@vben/plugins/echarts', async () => {
  const { defineComponent: define, h: render } = await import('vue');
  const EchartsUI = define({
    name: 'EchartsUIStub',
    setup: () => () => render('div', { class: 'echarts-stub' }),
  });
  return {
    EchartsUI,
    useEcharts: () => ({
      isActive: { value: false },
      renderEcharts: (options: Record<string, unknown>) => {
        chartOptions.push(options);
        return Promise.resolve(null);
      },
    }),
  };
});

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  chartOptions.length = 0;
  for (const fn of Object.values(mockApi)) fn.mockReset();
  fileMock.downloadBlobSafe.mockReset();
  fileMock.downloadByBlob.mockReset();
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

// ====================================================================
// 查询域（use-series-query）
// ====================================================================

const queryHooks: SeriesQueryHooks = {};

/** 最小宿主：真正调用组合式（测的是可在组件里跑的完整逻辑，而不是复制一份）。 */
const QueryHarness = defineComponent({
  name: 'QueryHarness',
  setup() {
    const query = useSeriesQuery(queryHooks);
    harnessQuery = query;
    return () => null;
  },
});

let harnessQuery: ReturnType<typeof useSeriesQuery>;

async function mountQuery() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(QueryHarness) });
  app.mount(container);
  mounted = { app };
  await flush();
  return harnessQuery;
}

describe('use-series-query：时间范围非法', () => {
  it('🔴 from > to ⇒ 前端拦下并提示，绝不发查询（后端会返回最早的 N 条，用户会误读成没数据）', async () => {
    mockApi.getDeviceSeries.mockResolvedValue([]);
    const query = await mountQuery();
    const errorSpy = vi
      .spyOn(message, 'error')
      .mockImplementation(() => ({}) as any);

    query.deviceId.value = '9300012';
    query.selectedPoints.value = ['temperature'];
    query.rangeMode.value = 'custom';
    query.customRange.value = [
      dayjs('2026-10-20 10:00:00'),
      dayjs('2026-10-20 09:00:00'),
    ];

    await query.onQuery();

    expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toMatch(
      /起始时间不能晚于结束时间|timeRangeInvalid/,
    );
    expect(mockApi.getDeviceSeries).not.toHaveBeenCalled();
  });

  it('limit 越界同样被拦下（不发注定失败的请求）', async () => {
    const query = await mountQuery();
    const errorSpy = vi
      .spyOn(message, 'error')
      .mockImplementation(() => ({}) as any);
    query.deviceId.value = '9300012';
    query.selectedPoints.value = ['temperature'];
    query.limit.value = 0;

    await query.onQuery();

    expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toMatch(/1 ~|上限|limit/);
    expect(mockApi.getDeviceSeries).not.toHaveBeenCalled();
  });
});

describe('use-series-query：空结果 vs 失败（严格分开）', () => {
  it('后端成功返回 0 条 ⇒ noData=true（空态），失败计数为 0', async () => {
    mockApi.getDeviceSeries.mockResolvedValue([]);
    const query = await mountQuery();
    query.deviceId.value = '9300012';
    query.selectedPoints.value = ['temperature'];
    query.pointOptions.value = [
      {
        identifier: 'temperature',
        mapped: true,
        orphan: false,
        propertyId: 'p1',
        propertyName: '温度',
        unit: '℃',
        value: 'temperature',
      },
    ];

    await query.onQuery();

    expect(query.results.value).toHaveLength(1);
    expect(query.results.value[0]?.points).toHaveLength(0);
    expect(query.queryPointCounts.value.temperature).toBe(0);
    expect(query.noData.value, '空结果是空态，不是失败').toBe(true);
    expect(query.failedCount.value).toBe(0);
    expect(query.totalCount.value).toBe(0);
  });

  it('某点位失败 ⇒ 该点位带错误、其它点位照常出数（不把失败吞成空）', async () => {
    mockApi.getDeviceSeries.mockImplementation((_deviceId: string, params: { propertyId: string }) =>
      params.propertyId === 'bad'
        ? Promise.reject(new Error('时序库未启用'))
        : Promise.resolve([
            { quality: 'GOOD', ts: 1_790_400_000_000, value: '20' },
          ]),
    );
    const query = await mountQuery();
    query.deviceId.value = '9300012';
    query.selectedPoints.value = ['ok', 'bad'];

    await query.onQuery();

    expect(query.results.value).toHaveLength(2);
    expect(query.results.value[0]?.error).toBe('');
    expect(query.results.value[1]?.error).toContain('时序库未启用');
    // 有成功点位 ⇒ 不是空态；失败单独展示
    expect(query.noData.value).toBe(false);
  });
});

// ====================================================================
// CSV 导出（批次 8：接入共享 useCsvExport）
// ====================================================================

describe('use-series-query · 导出（走 shared/use-csv-export）', () => {
  async function prepareQueryWithOneSeries() {
    mockApi.getDeviceSeries.mockResolvedValue([
      { quality: 'GOOD', ts: 1_790_400_000_000, value: '20' },
    ]);
    const query = await mountQuery();
    query.deviceId.value = '9300012';
    query.selectedPoints.value = ['temperature'];
    query.pointOptions.value = [
      {
        identifier: 'temperature',
        mapped: true,
        orphan: false,
        propertyId: 'p1',
        propertyName: '温度',
        unit: '℃',
        value: 'temperature',
      },
    ];
    await query.onQuery();
    return query;
  }

  it('导出 payload：文件名含「设备+点位+时间窗口」（appendDate:false 原样使用），CSV 含 BOM 与表头', async () => {
    fileMock.downloadBlobSafe.mockResolvedValue(true);
    const query = await prepareQueryWithOneSeries();
    expect(query.exportLoading.value, '初始不在途').toBe(false);

    await query.onExportCsv();

    expect(fileMock.downloadBlobSafe).toHaveBeenCalledTimes(1);
    const [blob, fileName, errorText] =
      fileMock.downloadBlobSafe.mock.calls[0] ?? [];
    // 文件名自备完整名（含 .csv），不得再被追加 `_YYYYMMDD`
    expect(String(fileName)).toMatch(
      /^iot-series-9300012-temperature-\d{8}-\d{6}\.csv$/,
    );
    expect(String(errorText)).toBe(
      i18n.global.t('page.iot.series.exportFailed'),
    );
    const text = await (blob as Blob).text();
    // BOM（Excel 不乱码）+ 三列表头
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).toContain(i18n.global.t('page.iot.series.ts'));
    expect(text).toContain(i18n.global.t('page.iot.series.value'));
    expect(text).toContain(i18n.global.t('page.iot.series.quality'));
    expect(query.exportLoading.value, '导出结束必须复位 loading').toBe(false);
  });

  it('零行 ⇒ 不触发下载（保持原行为：没有数据就不产出空文件）', async () => {
    mockApi.getDeviceSeries.mockResolvedValue([]);
    const query = await mountQuery();
    query.deviceId.value = '9300012';
    query.selectedPoints.value = ['temperature'];
    await query.onQuery();
    fileMock.downloadBlobSafe.mockClear();
    fileMock.downloadBlobSafe.mockResolvedValue(true);

    await query.onExportCsv();

    expect(fileMock.downloadBlobSafe).not.toHaveBeenCalled();
    expect(query.exportLoading.value).toBe(false);
  });
});

// ====================================================================
// 图表：多单位多 Y 轴
// ====================================================================

describe('series-chart.vue：多单位 ⇒ 多 Y 轴（不同量纲不共轴）', () => {
  it('两个单位 ⇒ 两条 Y 轴（左右交替），时间轴为 time，颜色走 chart-tokens 而非硬编码', async () => {
    const results = [
      {
        error: '',
        name: '温度',
        points: [{ quality: 'GOOD', ts: 1_790_400_000_000, value: '20' }],
        propertyId: 'temperature',
        unit: '℃',
      },
      {
        error: '',
        name: '湿度',
        points: [{ quality: 'GOOD', ts: 1_790_400_000_000, value: '55' }],
        propertyId: 'humidity',
        unit: '%',
      },
    ];
    const model = buildChartModel(results);
    const units = chartUnits(results);
    expect(units).toEqual(['℃', '%']);

    const container = document.createElement('div');
    document.body.append(container);
    const app = createApp({
      render: () =>
        h(SeriesChart as never, { model, units }),
    });
    app.mount(container);
    mounted = { app };
    await flush();

    const option = chartOptions.at(-1) as Record<string, any>;
    expect(option, '图表未渲染').toBeTruthy();
    expect(option.yAxis).toHaveLength(2);
    expect(
      option.yAxis.map((axis: any) => axis.name),
      '每个单位一条 Y 轴（量纲不同不共轴）',
    ).toEqual(['℃', '%']);
    expect(option.yAxis.map((axis: any) => axis.position)).toEqual([
      'left',
      'right',
    ]);
    expect(option.series).toHaveLength(2);
    // 时间轴（不是等距类别轴，否则多点位峰谷会被假对齐）
    expect(option.xAxis.type).toBe('time');
    // 颜色来自语义 token 解析层：本环境取不到 :root 变量时应为 undefined（交给 ECharts 兜底），
    // 但**绝不能**是 6 位 hex（静态门禁也禁止硬编码）。
    for (const [index, item] of option.series.entries()) {
      const color = item.itemStyle?.color;
      expect(color).toBe(chartSeriesColorAt(index));
      expect(String(color ?? '')).not.toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

// ====================================================================
// 明细表：截断行数
// ====================================================================

describe('series-detail-table.vue：截断必须显式提示', () => {
  it('超过上限只展示前 N 行，并用「共 M 行」说明被截断（不静默当成就这么多）', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const app = createApp({
      render: () =>
        h(SeriesDetailTable as never, {
          maxRows: 500,
          multiSeries: true,
          rows: [
            {
              key: 'r1',
              name: '温度',
              propertyId: 'temperature',
              quality: 'GOOD',
              ts: '2026-10-20 10:00:00',
              tsMillis: 1,
              value: '20',
            },
            {
              key: 'r2',
              name: '湿度',
              propertyId: 'humidity',
              quality: 'GOOD',
              ts: '2026-10-20 10:00:01',
              tsMillis: 2,
              value: '55',
            },
          ],
          total: 1200,
          truncated: true,
        }),
    });
    app.mount(container);
    mounted = { app };
    await flush();

    // 只渲染传入的行（截断由查询域算好，组件不再自己 slice）
    expect(container.querySelectorAll('table tbody tr')).toHaveLength(2);
    // 多点位 ⇒ 首列点位名
    expect(container.textContent).toContain('点位');
    expect(container.textContent).toContain('温度');
    // 截断提示必须写出上限与总行数
    expect(container.textContent).toMatch(/前 500 行/);
    expect(container.textContent).toContain('1200');
  });

  it('未截断时不渲染提示（避免正常结果被画上警告）', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const app = createApp({
      render: () =>
        h(SeriesDetailTable as never, {
          maxRows: 500,
          multiSeries: false,
          rows: [],
          total: 0,
          truncated: false,
        }),
    });
    app.mount(container);
    mounted = { app };
    await flush();

    expect(container.textContent).not.toMatch(/前 500 行/);
  });
});
