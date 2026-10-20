import type { IotThingModelApi } from '#/api/iot/thingmodel';

/**
 * api/iot 请求契约测试（防「URL/参数序列化漂移」）。
 *
 * ## 为什么必须有这一层
 *
 * 现有 18 个页面测试**全量 mock `#/api/iot`**（`vi.mock('#/api/iot', ...)`），
 * 于是「页面拿到的数据形状」有覆盖，但「请求到底打到哪个 URL、带什么参数」零覆盖：
 * 页面测试里的替身永远返回「理想结果」，即使 api 层把 `/iot/devices` 写成 `/iot/device`、
 * 把 `deviceIds.join(',')` 改成数组、把 `page/pageSize` 写错，所有门禁仍然全绿。
 *
 * 这不是假想风险：2026-10-20 审查发现的 P0-3「设备消息跟踪必 400」就是这条链路上的事故——
 * `views/iot/devices/modules/trace.vue` 用 `Date#toISOString()`（尾随 `Z`）传 `from/to`，
 * 而后端 `DeviceTraceQuery` 是 `LocalDateTime` 且**没有** `@DateTimeFormat`
 * （同仓 availability/maintenance 都显式写了 `pattern="yyyy-MM-dd HH:mm:ss"`），
 * 于是请求稳定 400；`trace-state.test.ts` 因为 mock 掉 api 层，门禁全绿也发现不了。
 *
 * ## 本文件守什么
 *
 * 1. 每个代表函数的 **method + path** 与后端 Controller 完全一致
 *    （网关 `/iot/**` StripPrefix=1，见各用例断言里的后端 `path:line` 注释）；
 * 2. 关键 **params / body** 原样透传（不隐式改名、不隐式转换、不吞字段）；
 * 3. 约定俗成的短路行为（空 ids 不发请求、批量名称回填分页/提前停止）；
 * 4. `trace` 的时间窗**调用约定**：`from/to` 必须是 `yyyy-MM-dd HH:mm:ss`。
 *    ⚠️ 当前 `getDeviceTrace` 只做透传（api 层无法替调用方换格式），因此
 *    用例 1 断言「透传不改写」，用例 3 用本地 `formatTraceWindow()` 固化约定格式并
 *    显式断言带 `Z` 的 ISO 串不合法。等设备页按约定修复后，这两条用例 + 页面用例
 *    共同构成「页面格式化 → api 透传」的跨层防线。
 *
 * ## 约束
 *
 * - 纯单元测试：`#/api/request` 被完整 mock，**不发任何真实网络请求**；
 * - 不依赖组件/DOM（`importDevicesCsv` 只用到标准 `FormData`/`File`）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ackAlerts,
  exportAlertsCsv,
  getActiveAlertCounts,
  getAlertPage,
  getAlertRulePage,
  getDeviceAlertPage,
  setAlertRulesEnabled,
  silenceAlerts,
  updateAlertRule,
} from '#/api/iot/alert';
import {
  getDeviceCommands,
  resendDeviceCommand,
  sendBatchDeviceCommands,
  sendDeviceCommand,
} from '#/api/iot/command';
import {
  batchDeleteDevices,
  batchUpdateDeviceStatus,
  deleteDevice,
  exportDevicesCsv,
  getDeviceNameMap,
  getDeviceOptions,
  getDevicePage,
  updateDeviceStatus,
} from '#/api/iot/device';
import {
  downloadDeviceImportFailedCsv,
  downloadDeviceImportTemplate,
  getDeviceImportBatchDetail,
  getDeviceImportBatchPage,
  importDevicesCsv,
} from '#/api/iot/device-import';
import {
  addGroupMember,
  addGroupMembersBatch,
  getGroupList,
  removeGroupMember,
  removeGroupMembersBatch,
} from '#/api/iot/group';
import {
  createDevicePoint,
  deleteDevicePoint,
  getDevicePoints,
  updateDevicePoint,
} from '#/api/iot/point';
import {
  createProperty,
  exportTsl,
  importTsl,
  listProperties,
} from '#/api/iot/thingmodel';
import { getDeviceTrace } from '#/api/iot/trace';

/**
 * `#/api/request` 的替身：只捕获调用，不实现任何网络/拦截器语义。
 *
 * 注意：这里必须覆盖 `download`（导出/模板下载走 `requestClient.download`，
 * `get + responseType:'blob'` 会被默认响应拦截器误判），漏掉它会让下载类函数在
 * 测试里抛 `requestClient.download is not a function`——那反而是有用的信号。
 */
const { requestMock } = vi.hoisted(() => ({
  requestMock: {
    delete: vi.fn(),
    download: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock('#/api/request', () => ({
  baseRequestClient: {},
  requestClient: requestMock,
}));

type RequestMock = ReturnType<typeof vi.fn>;

/** 取本次（且仅本次）请求的实参；请求次数不符会直接失败并带上 label。 */
function singleRequest(mock: RequestMock, label: string): unknown[] {
  const calls = mock.mock.calls as unknown[][];
  expect(
    calls.length,
    `${label}：必须恰好发出 1 个请求（多/少都说明调用链变了）`,
  ).toBe(1);
  return calls[0] ?? [];
}

/** 统计所有 requestClient 方法累计发出的请求数（短路口径用它断言 0）。 */
function requestCount(): number {
  let count = 0;
  for (const mock of Object.values(requestMock)) {
    count += ((mock as RequestMock).mock.calls as unknown[][]).length;
  }
  return count;
}

/** 读第二参的 `params`（GET/download 用），失败信息带到具体函数。 */
function paramsOf(config: unknown, label: string): Record<string, unknown> {
  const params = (config as undefined | { params?: unknown })?.params;
  expect(
    params,
    `${label}：第二参必须带 params（口径：{ params }）`,
  ).toBeDefined();
  return params as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ====================================================================
// trace：消息跟踪（P0-3 回归：时间窗格式 + 路径）
// ====================================================================

/** 后端 `DeviceTraceQuery`（LocalDateTime）接受的唯一格式。 */
const TRACE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * 时间窗格式化的**约定实现**（与修复后的设备页同口径）。
 *
 * api 层只透传，本文件用它固化「调用方该传什么」；设备页修复后应改为引用真实
 * 格式化实现（`views/iot/shared/display.ts#formatDateTime` 或页面内联），
 * 届时删除本 helper。
 */
function formatTraceWindow(
  fromMs: number,
  toMs: number,
): {
  from: string;
  to: string;
} {
  const pad = (n: number) => String(n).padStart(2, '0');
  const format = (ms: number) => {
    const d = new Date(ms);
    return [
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    ].join(' ');
  };
  return { from: format(fromMs), to: format(toMs) };
}

describe('trace：消息跟踪时间窗（P0-3「每次查询必 400」回归防线）', () => {
  it('getDeviceTrace：GET /iot/devices/{id}/messages，from/to/stage 原样透传', async () => {
    requestMock.get.mockResolvedValue({ items: [] });
    const window = formatTraceWindow(
      Date.UTC(2026, 9, 20, 1, 0, 0),
      Date.UTC(2026, 9, 20, 2, 0, 0),
    );

    await getDeviceTrace('9300012', {
      from: window.from,
      stage: 'up-received',
      to: window.to,
    });

    const [url, config] = singleRequest(
      requestMock.get,
      'getDeviceTrace（GET /iot/devices/{deviceId}/messages）',
    );
    expect(
      url,
      'getDeviceTrace path 漂移：后端 IotDeviceTraceController 为 /devices/{deviceId}/messages',
    ).toBe('/iot/devices/9300012/messages');
    const params = paramsOf(config, 'getDeviceTrace');
    expect(
      params,
      'getDeviceTrace：时间窗与筛选条件必须原样透传（api 层不得改写格式）',
    ).toEqual({
      from: window.from,
      stage: 'up-received',
      to: window.to,
    });
    expect(
      String(params.from),
      'getDeviceTrace：from 必须是 yyyy-MM-dd HH:mm:ss（后端 LocalDateTime，无 @DateTimeFormat）',
    ).toMatch(TRACE_TIME_RE);
    expect(
      String(params.to),
      'getDeviceTrace：to 必须是 yyyy-MM-dd HH:mm:ss（后端 LocalDateTime，无 @DateTimeFormat）',
    ).toMatch(TRACE_TIME_RE);
  });

  it('getDeviceTrace：不传 query 时仍以 params:{} 发 GET（不产生 undefined 参数）', async () => {
    requestMock.get.mockResolvedValue({ items: [] });

    await getDeviceTrace(7);

    const [url, config] = singleRequest(
      requestMock.get,
      'getDeviceTrace（空 query）',
    );
    expect(url, 'getDeviceTrace：数字 deviceId 必须原样进入路径').toBe(
      '/iot/devices/7/messages',
    );
    expect(
      config,
      'getDeviceTrace：空 query 必须传 params:{}，不能省掉 config',
    ).toEqual({
      params: {},
    });
  });

  it('时间窗调用约定：yyyy-MM-dd HH:mm:ss 合法；带 Z 的 ISO 串不合法（P0-3 根因）', () => {
    const window = formatTraceWindow(
      Date.UTC(2026, 9, 20, 1, 0, 0),
      Date.UTC(2026, 9, 20, 2, 0, 0),
    );
    expect(window.from, '约定格式必须是 yyyy-MM-dd HH:mm:ss').toMatch(
      TRACE_TIME_RE,
    );
    expect(window.to, '约定格式必须是 yyyy-MM-dd HH:mm:ss').toMatch(
      TRACE_TIME_RE,
    );
    // 正向锁死「旧写法」不被重新引入：toISOString() 的结果后端解析不了。
    expect(
      TRACE_TIME_RE.test(new Date(2026, 9, 20, 1, 0, 0).toISOString()),
      'Date#toISOString()（尾随 Z）不是后端可接受格式——设备页曾因此在 trace 页签稳定 400',
    ).toBe(false);
  });
});

// ====================================================================
// device：分页 / 批量 / 导出 / 名称回填 / 单状态端点
// ====================================================================

describe('device：设备台账请求契约', () => {
  it('getDevicePage：GET /iot/devices + 分页/筛选 params 原样透传', async () => {
    requestMock.get.mockResolvedValue({ items: [], total: 0 });

    await getDevicePage({
      keyword: 'modbus',
      page: 2,
      pageSize: 20,
      productId: '9100001',
    });

    const [url, config] = singleRequest(
      requestMock.get,
      'getDevicePage（GET /iot/devices）',
    );
    expect(
      url,
      'getDevicePage path 漂移：后端 IotDeviceController.java:69 为 GET /devices',
    ).toBe('/iot/devices');
    expect(
      paramsOf(config, 'getDevicePage'),
      'getDevicePage：page/pageSize/keyword/productId 必须原样传',
    ).toEqual({
      keyword: 'modbus',
      page: 2,
      pageSize: 20,
      productId: '9100001',
    });
  });

  it('getDeviceOptions：取前 200 条（page=1 & pageSize=200，与后端下拉口径一致）', async () => {
    requestMock.get.mockResolvedValue({ items: [], total: 0 });

    await getDeviceOptions('gw');

    const [url, config] = singleRequest(requestMock.get, 'getDeviceOptions');
    expect(url, 'getDeviceOptions：走 GET /iot/devices').toBe('/iot/devices');
    expect(
      paramsOf(config, 'getDeviceOptions'),
      'getDeviceOptions：必须固定 page=1/pageSize=200',
    ).toEqual({ keyword: 'gw', page: 1, pageSize: 200 });
  });

  it('exportDevicesCsv：走 requestClient.download（GET /iot/devices/export），不是 get+blob', async () => {
    requestMock.download.mockResolvedValue(new Blob(['x']));

    await exportDevicesCsv({ keyword: 'abc' });

    const [url, config] = singleRequest(
      requestMock.download,
      'exportDevicesCsv（download /iot/devices/export）',
    );
    expect(
      url,
      'exportDevicesCsv path 漂移：后端 IotDeviceController.java:84 为 GET /devices/export',
    ).toBe('/iot/devices/export');
    expect(
      paramsOf(config, 'exportDevicesCsv'),
      'exportDevicesCsv：导出必须沿用当前筛选条件',
    ).toEqual({
      keyword: 'abc',
    });
    expect(
      requestMock.get,
      'exportDevicesCsv：不得改回 get+responseType:blob（会被 responseReturn:"data" 的拦截器误判失败）',
    ).not.toHaveBeenCalled();
  });

  it('updateDeviceStatus：PUT /iot/devices/{id}/status/{status}（状态在路径里，不是 body）', async () => {
    requestMock.put.mockResolvedValue(undefined);

    await updateDeviceStatus('9300012', 0);

    const [url, body] = singleRequest(
      requestMock.put,
      'updateDeviceStatus（PUT /iot/devices/{id}/status/{status}）',
    );
    expect(
      url,
      'updateDeviceStatus path 漂移：后端 IotDeviceController.java:146 为 PUT /devices/{id}/status/{status}',
    ).toBe('/iot/devices/9300012/status/0');
    expect(
      body,
      'updateDeviceStatus：状态在路径里，不应再传 body',
    ).toBeUndefined();
  });

  it('batchUpdateDeviceStatus：PUT /iot/devices/batch/status，body {ids,status}', async () => {
    requestMock.put.mockResolvedValue(undefined);

    await batchUpdateDeviceStatus(['1', '2'], 1);

    const [url, body] = singleRequest(
      requestMock.put,
      'batchUpdateDeviceStatus（PUT /iot/devices/batch/status）',
    );
    expect(
      url,
      'batchUpdateDeviceStatus path 漂移：后端 IotDeviceController.java:164 为 PUT /devices/batch/status',
    ).toBe('/iot/devices/batch/status');
    expect(
      body,
      'batchUpdateDeviceStatus：ids 必须保持字符串数组（Long 字符串口径），status 为码值数字',
    ).toEqual({
      ids: ['1', '2'],
      status: 1,
    });
  });

  it('batchUpdateDeviceStatus：空 ids 短路（不发请求，防止空批量打后端）', async () => {
    await batchUpdateDeviceStatus([], 0);

    expect(
      requestCount(),
      'batchUpdateDeviceStatus([])：空 ids 必须短路（不应发出任何请求）',
    ).toBe(0);
  });

  it('batchDeleteDevices：POST /iot/devices/batch/delete，body {ids}', async () => {
    requestMock.post.mockResolvedValue(undefined);

    await batchDeleteDevices(['3', '4']);

    const [url, body] = singleRequest(
      requestMock.post,
      'batchDeleteDevices（POST /iot/devices/batch/delete）',
    );
    expect(
      url,
      'batchDeleteDevices path 漂移：后端 IotDeviceController.java:180 为 POST /devices/batch/delete',
    ).toBe('/iot/devices/batch/delete');
    expect(
      body,
      'batchDeleteDevices：破坏性操作必须只发 ids（不得夹带其它字段）',
    ).toEqual({
      ids: ['3', '4'],
    });
  });

  it('batchDeleteDevices：空 ids 短路（不发请求）', async () => {
    await batchDeleteDevices([]);

    expect(
      requestCount(),
      'batchDeleteDevices([])：空 ids 必须短路（不应发出任何请求）',
    ).toBe(0);
  });

  it('deleteDevice：DELETE /iot/devices/{id}', async () => {
    requestMock.delete.mockResolvedValue(undefined);

    await deleteDevice('9300012');

    const [url] = singleRequest(
      requestMock.delete,
      'deleteDevice（DELETE /iot/devices/{id}）',
    );
    expect(
      url,
      'deleteDevice path 漂移：后端 IotDeviceController.java:110 为 DELETE /devices/{id}',
    ).toBe('/iot/devices/9300012');
  });

  it('getDeviceNameMap：按 200/页 分页拉取，全部命中后提前停止', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      deviceCode: `D${i}`,
      id: String(1000 + i),
    }));
    const page2 = [{ deviceCode: 'TARGET', deviceName: '目标设备', id: '3' }];
    requestMock.get
      .mockResolvedValueOnce({ items: page1, total: 201 })
      .mockResolvedValueOnce({ items: page2, total: 201 });

    const names = await getDeviceNameMap(['3']);

    const calls = requestMock.get.mock.calls as unknown[][];
    expect(
      calls.length,
      'getDeviceNameMap：命中目标后必须提前停止，不能继续扫到第 10 页',
    ).toBe(2);
    expect(calls[0]?.[0], 'getDeviceNameMap：第一页 GET /iot/devices').toBe(
      '/iot/devices',
    );
    expect(
      (calls[0]?.[1] as undefined | { params?: unknown })?.params,
      'getDeviceNameMap：第一页必须 page=1&pageSize=200',
    ).toEqual({ page: 1, pageSize: 200 });
    expect(
      (calls[1]?.[1] as undefined | { params?: unknown })?.params,
      'getDeviceNameMap：第二页必须 page=2&pageSize=200',
    ).toEqual({ page: 2, pageSize: 200 });
    expect(names, 'getDeviceNameMap：设备名优先、无则 code、再兜底 id').toEqual(
      { '3': '目标设备' },
    );
  });

  it('getDeviceNameMap：空/全空串入参短路（不发请求，返回空映射）', async () => {
    const names = await getDeviceNameMap(['', '']);

    expect(
      requestCount(),
      'getDeviceNameMap([无有效 id])：空入参必须短路（不应发出任何请求）',
    ).toBe(0);
    expect(
      names,
      'getDeviceNameMap：空入参必须返回空映射（不是 null）',
    ).toEqual({});
  });
});

// ====================================================================
// alert：列表 / 导出 / 批量确认与静默 / 规则启停
// ====================================================================

describe('alert：告警中心请求契约', () => {
  it('getAlertPage：GET /iot/alerts + 多值筛选原样透传（state 是逗号串）', async () => {
    requestMock.get.mockResolvedValue({ items: [], total: 0 });

    await getAlertPage({
      activeOnly: true,
      page: 2,
      pageSize: 50,
      state: 'FIRING,ACKED',
    });

    const [url, config] = singleRequest(
      requestMock.get,
      'getAlertPage（GET /iot/alerts）',
    );
    expect(
      url,
      'getAlertPage path 漂移：后端 IotAlertController.java:85 为 GET /alerts',
    ).toBe('/iot/alerts');
    expect(
      paramsOf(config, 'getAlertPage'),
      'getAlertPage：activeOnly/state/page 必须原样传',
    ).toEqual({
      activeOnly: true,
      page: 2,
      pageSize: 50,
      state: 'FIRING,ACKED',
    });
  });

  it('getDeviceAlertPage：GET /iot/devices/{id}/alerts（设备详情告警页签）', async () => {
    requestMock.get.mockResolvedValue({ items: [], total: 0 });

    await getDeviceAlertPage('9300012', { page: 1, pageSize: 10 });

    const [url, config] = singleRequest(requestMock.get, 'getDeviceAlertPage');
    expect(
      url,
      'getDeviceAlertPage path 漂移：后端 IotDeviceAlertController 为 /devices/{id}/alerts',
    ).toBe('/iot/devices/9300012/alerts');
    expect(paramsOf(config, 'getDeviceAlertPage')).toEqual({
      page: 1,
      pageSize: 10,
    });
  });

  it('exportAlertsCsv：走 download（GET /iot/alerts/export），不是 get+blob', async () => {
    requestMock.download.mockResolvedValue(new Blob(['x']));

    await exportAlertsCsv({ state: 'RESOLVED' });

    const [url] = singleRequest(requestMock.download, 'exportAlertsCsv');
    expect(
      url,
      'exportAlertsCsv path 漂移：后端 IotAlertController.java:100 为 GET /alerts/export',
    ).toBe('/iot/alerts/export');
    expect(
      requestMock.get,
      'exportAlertsCsv：不得改回 get+blob',
    ).not.toHaveBeenCalled();
  });

  it('getActiveAlertCounts：deviceIds 逗号拼接成单个参数（不是数组/[] 形式）', async () => {
    requestMock.get.mockResolvedValue({ '1': 2 });

    await getActiveAlertCounts(['1', '2', '3']);

    const [url, config] = singleRequest(
      requestMock.get,
      'getActiveAlertCounts',
    );
    expect(
      url,
      'getActiveAlertCounts path 漂移：后端 IotAlertController.java:135 为 GET /alerts/active-counts',
    ).toBe('/iot/alerts/active-counts');
    expect(
      paramsOf(config, 'getActiveAlertCounts').deviceIds,
      'getActiveAlertCounts：后端是 @RequestParam List<Long>，必须 join(",") 单值；数组形态会被序列化成 deviceIds[] 后端不认',
    ).toBe('1,2,3');
  });

  it('getActiveAlertCounts：空数组短路（不发请求）', async () => {
    const counts = await getActiveAlertCounts([]);

    expect(
      requestCount(),
      'getActiveAlertCounts([])：空入参必须短路（不应发出任何请求）',
    ).toBe(0);
    expect(
      counts,
      'getActiveAlertCounts：空入参必须返回空对象（不是 null）',
    ).toEqual({});
  });

  it('ackAlerts：POST /iot/alerts/ack，body {ids}', async () => {
    requestMock.post.mockResolvedValue(1);

    await ackAlerts(['11', '12']);

    const [url, body] = singleRequest(requestMock.post, 'ackAlerts');
    expect(
      url,
      'ackAlerts path 漂移：后端 IotAlertController.java:147 为 POST /alerts/ack',
    ).toBe('/iot/alerts/ack');
    expect(body, 'ackAlerts：ids 必须保持字符串数组').toEqual({
      ids: ['11', '12'],
    });
  });

  it('silenceAlerts：POST /iot/alerts/silence，默认 60 分钟 / 可覆盖', async () => {
    requestMock.post.mockResolvedValue(1);

    await silenceAlerts(['11']);
    let [, body] = singleRequest(
      requestMock.post,
      'silenceAlerts（默认 60 分钟）',
    );
    expect(
      body,
      'silenceAlerts：默认静默时长必须是 60 分钟（后端默认口径）',
    ).toEqual({
      ids: ['11'],
      minutes: 60,
    });

    vi.resetAllMocks();
    requestMock.post.mockResolvedValue(1);
    await silenceAlerts(['11'], 30);
    [, body] = singleRequest(
      requestMock.post,
      'silenceAlerts（自定义 30 分钟）',
    );
    expect(body, 'silenceAlerts：minutes 必须透传调用方传入值').toEqual({
      ids: ['11'],
      minutes: 30,
    });
  });

  it('setAlertRulesEnabled：POST /iot/alerts/rules/enabled，body {ids,enabled}', async () => {
    requestMock.post.mockResolvedValue(2);

    await setAlertRulesEnabled(['21', '22'], false);

    const [url, body] = singleRequest(requestMock.post, 'setAlertRulesEnabled');
    expect(
      url,
      'setAlertRulesEnabled path 漂移：后端 IotAlertController.java:236 为 POST /alerts/rules/enabled',
    ).toBe('/iot/alerts/rules/enabled');
    expect(
      body,
      'setAlertRulesEnabled：enabled 必须是布尔（不是 0/1）',
    ).toEqual({
      enabled: false,
      ids: ['21', '22'],
    });
  });

  it('updateAlertRule / getAlertRulePage：规则 CRUD 路径与 params', async () => {
    requestMock.put.mockResolvedValue(undefined);
    requestMock.get.mockResolvedValue({ items: [], total: 0 });

    const rule = {
      enabled: true,
      ruleName: '温度过高',
      scopeType: 'DEVICE',
      severity: 'CRITICAL',
    };
    await updateAlertRule('88', rule);
    await getAlertRulePage({ enabled: 1, page: 1, pageSize: 20 });

    const [putUrl, putBody] = singleRequest(requestMock.put, 'updateAlertRule');
    expect(
      putUrl,
      'updateAlertRule path 漂移：后端 IotAlertController.java:222 为 PUT /alerts/rules/{id}',
    ).toBe('/iot/alerts/rules/88');
    expect(
      putBody,
      'updateAlertRule：规则体必须整体透传（含 enabled/severity）',
    ).toEqual(rule);

    const [getUrl, getConfig] = singleRequest(
      requestMock.get,
      'getAlertRulePage',
    );
    expect(
      getUrl,
      'getAlertRulePage path 漂移：后端 IotAlertController.java:184 为 GET /alerts/rules',
    ).toBe('/iot/alerts/rules');
    expect(paramsOf(getConfig, 'getAlertRulePage')).toEqual({
      enabled: 1,
      page: 1,
      pageSize: 20,
    });
  });
});

// ====================================================================
// command：单台下发 / 历史 / 批量 / 重发
// ====================================================================

describe('command：命令下发请求契约', () => {
  it('sendDeviceCommand：POST /iot/devices/{id}/commands，body 整体透传（含 writeDesired）', async () => {
    requestMock.post.mockResolvedValue({ id: '1' });

    const body = {
      identifier: 'setTemp',
      kind: 'service',
      params: { target: 25 },
      timeoutMs: 10_000,
      writeDesired: true,
    };
    await sendDeviceCommand('9300012', body);

    const [url, sent] = singleRequest(requestMock.post, 'sendDeviceCommand');
    expect(
      url,
      'sendDeviceCommand path 漂移：后端 IotCommandController.java:62 为 POST /devices/{deviceId}/commands',
    ).toBe('/iot/devices/9300012/commands');
    expect(
      sent,
      'sendDeviceCommand：api 层不得裁剪字段——writeDesired 必须原样送达（否则 UI 勾了「同时写影子」也不会生效）',
    ).toEqual(body);
    expect(
      (sent as { writeDesired?: boolean }).writeDesired,
      'sendDeviceCommand：writeDesired 必须保留（后端 CommandSendReq 已支持）',
    ).toBe(true);
  });

  it('getDeviceCommands：GET /iot/devices/{id}/commands + 历史查询 params', async () => {
    requestMock.get.mockResolvedValue({ items: [], total: 0 });

    await getDeviceCommands('9300012', {
      page: 2,
      pageSize: 20,
      statusCode: 'failed',
    });

    const [url, config] = singleRequest(requestMock.get, 'getDeviceCommands');
    expect(
      url,
      'getDeviceCommands path 漂移：后端 IotCommandController.java:108 为 GET /devices/{deviceId}/commands',
    ).toBe('/iot/devices/9300012/commands');
    expect(paramsOf(config, 'getDeviceCommands')).toEqual({
      page: 2,
      pageSize: 20,
      statusCode: 'failed',
    });
  });

  it('sendBatchDeviceCommands：POST /iot/devices/commands/batch，body 原样（deviceIds 为安全整数数组）', async () => {
    requestMock.post.mockResolvedValue({ accepted: 2, total: 2 });

    const body = {
      clientRequestId: 'batch-1',
      command: {
        identifier: 'setTemp',
        kind: 'service',
        params: { target: 25 },
      },
      deviceIds: [9_300_012, 9_300_013],
    };
    await sendBatchDeviceCommands(body);

    const [url, sent] = singleRequest(
      requestMock.post,
      'sendBatchDeviceCommands',
    );
    expect(
      url,
      'sendBatchDeviceCommands path 漂移：后端 IotCommandController.java:92 为 POST /devices/commands/batch',
    ).toBe('/iot/devices/commands/batch');
    expect(
      sent,
      'sendBatchDeviceCommands：幂等键/命令模板/deviceIds 必须整体透传（api 层不做隐式转换）',
    ).toEqual(body);
  });

  it('resendDeviceCommand：requestId 进路径且必须 encodeURIComponent', async () => {
    requestMock.post.mockResolvedValue({ id: '1' });

    await resendDeviceCommand('9300012', 'req/with space');

    const [url] = singleRequest(requestMock.post, 'resendDeviceCommand');
    expect(
      url,
      'resendDeviceCommand：path 必须编码（后端 IotCommandController.java:122 为 POST /devices/{deviceId}/commands/{requestId}/resend）',
    ).toBe('/iot/devices/9300012/commands/req%2Fwith%20space/resend');
  });
});

// ====================================================================
// device-import：上传 multipart / 批次分页 / 模板与失败行下载
// ====================================================================

describe('device-import：设备导入请求契约', () => {
  it('importDevicesCsv：POST /iot/devices/import，FormData 单文件 + multipart 头', async () => {
    requestMock.post.mockResolvedValue({ id: '1' });
    const file = new File(['deviceCode,deviceName\nD1,测试'], 'devices.csv', {
      type: 'text/csv',
    });

    await importDevicesCsv(file);

    const [url, body, config] = singleRequest(
      requestMock.post,
      'importDevicesCsv',
    );
    expect(
      url,
      'importDevicesCsv path 漂移：后端 DeviceImportController.java:100 为 POST /devices/import',
    ).toBe('/iot/devices/import');
    expect(
      body instanceof FormData,
      'importDevicesCsv：body 必须是 FormData（multipart）',
    ).toBe(true);
    expect(
      (body as FormData).get('file'),
      'importDevicesCsv：文件字段名必须叫 file（后端 @RequestPart("file")）',
    ).toBe(file);
    expect(
      (config as undefined | { headers?: unknown })?.headers,
      'importDevicesCsv：必须显式声明 multipart/form-data',
    ).toEqual({ 'Content-Type': 'multipart/form-data' });
  });

  it('getDeviceImportBatchPage：GET /iot/devices/import，默认 page=1&pageSize=10', async () => {
    requestMock.get.mockResolvedValue({ items: [], total: 0 });

    await getDeviceImportBatchPage();

    const [url, config] = singleRequest(
      requestMock.get,
      'getDeviceImportBatchPage',
    );
    expect(
      url,
      'getDeviceImportBatchPage path 漂移：后端 DeviceImportController.java:116 为 GET /devices/import',
    ).toBe('/iot/devices/import');
    expect(
      paramsOf(config, 'getDeviceImportBatchPage'),
      'getDeviceImportBatchPage：默认分页必须 1/10',
    ).toEqual({ page: 1, pageSize: 10 });
  });

  it('getDeviceImportBatchDetail：GET /iot/devices/import/{batchId} + 明细分页/结果筛选', async () => {
    requestMock.get.mockResolvedValue({ batch: {}, rows: { items: [] } });

    await getDeviceImportBatchDetail('batch-9', {
      page: 2,
      pageSize: 20,
      rowResult: 'failed',
    });

    const [url, config] = singleRequest(
      requestMock.get,
      'getDeviceImportBatchDetail',
    );
    expect(
      url,
      'getDeviceImportBatchDetail path 漂移：后端 DeviceImportController.java:131 为 GET /devices/import/{batchId}',
    ).toBe('/iot/devices/import/batch-9');
    expect(paramsOf(config, 'getDeviceImportBatchDetail')).toEqual({
      page: 2,
      pageSize: 20,
      rowResult: 'failed',
    });
  });

  it('模板与失败行下载必须走 download（裸 CSV 不能按 {code,data} 解析）', async () => {
    requestMock.download.mockResolvedValue(new Blob(['x']));

    await downloadDeviceImportTemplate();
    await downloadDeviceImportFailedCsv('batch-9');

    const calls = requestMock.download.mock.calls as unknown[][];
    expect(calls.length, '下载模板 + 失败行 = 2 次 download 调用').toBe(2);
    expect(
      calls[0]?.[0],
      'downloadDeviceImportTemplate path 漂移：后端 DeviceImportController.java:82 为 GET /devices/import/template',
    ).toBe('/iot/devices/import/template');
    expect(
      calls[1]?.[0],
      'downloadDeviceImportFailedCsv path 漂移：后端 DeviceImportController.java:144 为 GET /devices/import/{batchId}/failed.csv',
    ).toBe('/iot/devices/import/batch-9/failed.csv');
    expect(
      requestMock.get,
      '下载类接口不得走 get（会被 responseReturn:"data" 拦截器读 code 误判）',
    ).not.toHaveBeenCalled();
  });
});

// ====================================================================
// thingmodel：物模型 CRUD 与 TSL 导入导出
// ====================================================================

describe('thingmodel：物模型请求契约', () => {
  it('listProperties：GET /iot/products/{productId}/services/{serviceId}/properties', async () => {
    requestMock.get.mockResolvedValue([]);

    await listProperties('9100001', '7');

    const [url] = singleRequest(requestMock.get, 'listProperties');
    expect(
      url,
      'listProperties path 漂移：后端 IotThingModelController.java:127',
    ).toBe('/iot/products/9100001/services/7/properties');
  });

  it('createProperty：POST 同一路径，属性体整体透传', async () => {
    requestMock.post.mockResolvedValue(1);

    // 后端 PropertySaveReq 的必填项：identifier / propertyName / dataType / accessMode
    const body = {
      accessMode: 'R',
      dataType: 'int',
      identifier: 'temp',
      propertyName: '温度',
    };
    await createProperty('9100001', '7', body);

    const [url, sent] = singleRequest(requestMock.post, 'createProperty');
    expect(
      url,
      'createProperty path 漂移：后端 IotThingModelController.java:141',
    ).toBe('/iot/products/9100001/services/7/properties');
    expect(sent, 'createProperty：属性体必须整体透传').toEqual(body);
  });

  it('exportTsl：GET /iot/products/{productId}/tsl（前端拿到 JSON 文档而不是 Blob）', async () => {
    requestMock.get.mockResolvedValue({ properties: [] });

    await exportTsl('9100001');

    const [url] = singleRequest(requestMock.get, 'exportTsl');
    expect(
      url,
      'exportTsl path 漂移：后端 IotThingModelController.java:322 为 GET /products/{id}/tsl',
    ).toBe('/iot/products/9100001/tsl');
  });

  it('importTsl：POST /iot/products/{productId}/tsl（全量替换草稿，body 为 TSL 文档）', async () => {
    requestMock.post.mockResolvedValue({ errors: [], successCount: 2 });

    const doc: IotThingModelApi.TslDocument = {
      services: [{ identifier: 'temp', properties: [] }],
    };
    await importTsl('9100001', doc);

    const [url, sent] = singleRequest(requestMock.post, 'importTsl');
    expect(
      url,
      'importTsl path 漂移：后端 IotThingModelController.java:335 为 POST /products/{id}/tsl',
    ).toBe('/iot/products/9100001/tsl');
    expect(
      sent,
      'importTsl：TSL 文档必须整体透传（不得只发部分字段，否则后端会当成删除）',
    ).toEqual(doc);
  });
});

// ====================================================================
// point：点位映射 CRUD
// ====================================================================

describe('point：点位映射请求契约', () => {
  it('getDevicePoints：GET /iot/devices/{deviceId}/points', async () => {
    requestMock.get.mockResolvedValue([]);

    await getDevicePoints('9300012');

    const [url] = singleRequest(requestMock.get, 'getDevicePoints');
    expect(
      url,
      'getDevicePoints path 漂移：后端 IotPointMappingController.java:52 为 GET /devices/{deviceId}/points',
    ).toBe('/iot/devices/9300012/points');
  });

  it('createDevicePoint：POST 同路径，映射体透传（含 rw/rawAddress）', async () => {
    requestMock.post.mockResolvedValue(1);

    // 后端 PointMappingSaveReq 的必填项：propertyId / refType / rawAddress / addressType / rw
    const body = {
      addressType: 'holding',
      propertyId: 'p1',
      rawAddress: '40001',
      refType: 'property',
      rw: 'RW',
    };
    await createDevicePoint('9300012', body);

    const [url, sent] = singleRequest(requestMock.post, 'createDevicePoint');
    expect(
      url,
      'createDevicePoint path 漂移：后端 IotPointMappingController.java:65',
    ).toBe('/iot/devices/9300012/points');
    expect(sent, 'createDevicePoint：映射体必须整体透传').toEqual(body);
  });

  it('updateDevicePoint / deleteDevicePoint：PUT、DELETE 均带点位 id', async () => {
    requestMock.put.mockResolvedValue(undefined);
    requestMock.delete.mockResolvedValue(undefined);

    await updateDevicePoint('9300012', '55', {
      addressType: 'holding',
      propertyId: 'p1',
      rawAddress: '40001',
      refType: 'property',
      rw: 'R',
    });
    await deleteDevicePoint('9300012', '55');

    const [putUrl] = singleRequest(requestMock.put, 'updateDevicePoint');
    expect(
      putUrl,
      'updateDevicePoint path 漂移：后端 IotPointMappingController.java:82',
    ).toBe('/iot/devices/9300012/points/55');
    const [deleteUrl] = singleRequest(requestMock.delete, 'deleteDevicePoint');
    expect(
      deleteUrl,
      'deleteDevicePoint path 漂移：后端 IotPointMappingController.java:100',
    ).toBe('/iot/devices/9300012/points/55');
  });
});

// ====================================================================
// group：设备分组 CRUD 与批量成员
// ====================================================================

describe('group：设备分组请求契约', () => {
  it('getGroupList：GET /iot/groups（无分页，整表）', async () => {
    requestMock.get.mockResolvedValue([]);

    await getGroupList();

    const [url] = singleRequest(requestMock.get, 'getGroupList');
    expect(
      url,
      'getGroupList path 漂移：后端 IotDeviceGroupController.java:54 为 GET /groups',
    ).toBe('/iot/groups');
  });

  it('addGroupMember：POST /iot/groups/{id}/members，body {deviceId}', async () => {
    requestMock.post.mockResolvedValue(1);

    await addGroupMember('5', '9300012');

    const [url, body] = singleRequest(requestMock.post, 'addGroupMember');
    expect(
      url,
      'addGroupMember path 漂移：后端 IotDeviceGroupController.java:124 为 POST /groups/{id}/members',
    ).toBe('/iot/groups/5/members');
    expect(body, 'addGroupMember：body 字段名必须是 deviceId').toEqual({
      deviceId: '9300012',
    });
  });

  it('addGroupMembersBatch：POST /groups/{id}/members/batch，body {deviceIds}', async () => {
    requestMock.post.mockResolvedValue({ added: 2, skipped: 0 });

    await addGroupMembersBatch('5', ['1', '2']);

    const [url, body] = singleRequest(requestMock.post, 'addGroupMembersBatch');
    expect(
      url,
      'addGroupMembersBatch path 漂移：后端 IotDeviceGroupController.java:141 为 POST /groups/{id}/members/batch',
    ).toBe('/iot/groups/5/members/batch');
    expect(body, 'addGroupMembersBatch：批量加入用 deviceIds').toEqual({
      deviceIds: ['1', '2'],
    });
  });

  it('removeGroupMembersBatch：body 必须是 memberIds（成员行主键），不是 deviceIds', async () => {
    requestMock.post.mockResolvedValue(2);

    await removeGroupMembersBatch('5', ['701', '702']);

    const [url, body] = singleRequest(
      requestMock.post,
      'removeGroupMembersBatch',
    );
    expect(
      url,
      'removeGroupMembersBatch path 漂移：后端 IotDeviceGroupController.java:159 为 POST /groups/{id}/members/batch-remove',
    ).toBe('/iot/groups/5/members/batch-remove');
    expect(
      body,
      'removeGroupMembersBatch：必须发 memberIds（GroupMemberResp.id）；发 deviceIds 后端删不到行且静默无效',
    ).toEqual({ memberIds: ['701', '702'] });
    expect(
      Object.keys(body as Record<string, unknown>),
      'removeGroupMembersBatch：不得出现 deviceIds 字段',
    ).not.toContain('deviceIds');
  });

  it('removeGroupMember：DELETE /groups/{id}/members/{memberId}（memberId 是成员行主键）', async () => {
    requestMock.delete.mockResolvedValue(undefined);

    await removeGroupMember('5', '701');

    const [url] = singleRequest(requestMock.delete, 'removeGroupMember');
    expect(
      url,
      'removeGroupMember path 漂移：后端 IotDeviceGroupController.java:175 为 DELETE /groups/{id}/members/{memberId}',
    ).toBe('/iot/groups/5/members/701');
  });
});
