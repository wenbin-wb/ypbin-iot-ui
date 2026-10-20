import { createApp, h, nextTick, ref } from 'vue';

import { registerAccessDirective } from '@vben/access';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { $t } from '#/locales';

import DetailAlert from './detail-alert.vue';

/**
 * 设备详情「告警中心」活动告警分页用例（审查 03 P2-5：固定 20 条静默截断）。
 *
 * 旧实现只取第 1 页、分页器关闭、无任何截断提示 ⇒ 用户看到 20 条既不知道总数、
 * 也看不到更多。本文件钉住改造后的四条用户可见契约 + 一条历史分页不回归：
 * 1. 展示「共 N 条（当前第 x 页）」，N 来自后端 total（Long 字符串经 toBackendNumber）；
 * 2. 「加载更多」请求 page=2 且**追加**行（不是替换）；
 * 3. 加载更多失败**保留已加载行**并原样展示后端 message（不清空）；
 * 4. 切换设备 ⇒ 回到第 1 页、重新从 page=1 拉；
 * 5. 历史告警分页保持原语义（page 变化带 state=RESOLVED，不受活动告警改造影响）。
 *
 * mock 口径：只替换本组件调用的 4 个 API，其余导出保留真实实现；i18n 用真实语言包。
 */

const { accessState, apiMock } = vi.hoisted(() => ({
  accessState: { accessCodes: ['*:*:*'], accessToken: 'test-token' },
  apiMock: {
    ackAlerts: vi.fn(),
    getDeviceAlertPage: vi.fn(),
    getDeviceAlertSummary: vi.fn(),
    silenceAlerts: vi.fn(),
  },
}));

vi.mock('#/api/iot', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    ackAlerts: (...args: unknown[]) => apiMock.ackAlerts(...args),
    getDeviceAlertPage: (...args: unknown[]) =>
      apiMock.getDeviceAlertPage(...args),
    getDeviceAlertSummary: (...args: unknown[]) =>
      apiMock.getDeviceAlertSummary(...args),
    silenceAlerts: (...args: unknown[]) => apiMock.silenceAlerts(...args),
  };
});

vi.mock('@vben/stores', async () => {
  const { reactive } = await import('vue');
  return {
    useAccessStore: () => reactive(accessState),
    useUserStore: () => reactive({ userRoles: [] }),
  };
});

vi.mock('@vben/preferences', () => ({
  preferences: { app: { accessMode: 'frontend', locale: 'zh-CN' } },
  updatePreferences: () => {},
}));

const DEVICE_ID = '9001';
const ACTIVE_PAGE_SIZE = 20;

/** 一条活动告警（够表格渲染的最小字段集）。 */
function alertRow(id: string) {
  return {
    deviceId: DEVICE_ID,
    durationSeconds: 60,
    firingTs: '2026-10-15 08:00:00',
    id,
    propertyId: 'temperature',
    severity: 'WARNING',
    startTs: '2026-10-15 08:00:00',
    state: 'FIRING',
    thresholdSnapshot: '> 80',
    triggerValue: '85',
  };
}

/** 后端 total 是 long ⇒ 全局序列化成字符串（这是必须走 toBackendNumber 的口径来源）。 */
function pageResp(ids: string[], total: string) {
  return { items: ids.map((id) => alertRow(id)), total };
}

let activePages: Record<number, { items: any[]; total: string }>;
let historyPages: Record<number, { items: any[]; total: string }>;
/** 置 true 时，下一次「活动告警第 2 页」请求失败（用于「失败保留已加载行」用例）。 */
let failNextActivePage: Error | null;

function setupApi() {
  activePages = {
    1: pageResp(['a1', 'a2'], '25'),
    2: pageResp(['a3', 'a4'], '25'),
  };
  historyPages = {
    1: {
      items: Array.from({ length: 10 }, (_v, index) => alertRow(`h${index + 1}`)),
      total: '25',
    },
    2: {
      items: Array.from({ length: 10 }, (_v, index) =>
        alertRow(`h${index + 11}`),
      ),
      total: '25',
    },
  };
  failNextActivePage = null;

  apiMock.getDeviceAlertPage.mockImplementation(
    async (deviceId: string, params: Record<string, any> = {}) => {
      if (params.state === 'RESOLVED') {
        return historyPages[params.page ?? 1] ?? { items: [], total: '0' };
      }
      if (params.page === 2 && failNextActivePage) {
        const failure = new Error(failNextActivePage.message);
        failNextActivePage = null;
        // 用 async 函数抛出 Error：既保持「后端失败 = 被拒绝的请求」语义，也满足 lint 约束
        throw failure;
      }
      // 切换设备后：新设备只给一页数据，便于断言「重置到第 1 页」
      if (deviceId !== DEVICE_ID) {
        return pageResp(['b1'], '1');
      }
      return activePages[params.page ?? 1] ?? { items: [], total: '25' };
    },
  );
  apiMock.getDeviceAlertSummary.mockResolvedValue({
    ackedCount: '1',
    activeCount: '3',
    firingCount: '2',
  });
  apiMock.ackAlerts.mockResolvedValue(1);
  apiMock.silenceAlerts.mockResolvedValue(1);
}

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  accessState.accessCodes = ['*:*:*'];
  setupApi();
});

let mounted: undefined | { app: { unmount: () => void } };

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function flush(times = 24) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
  await nextTick();
}

/** 挂载真实组件；`deviceIdRef` 可变，用于「切换设备」用例。 */
async function mountAlert(deviceIdRef = ref(DEVICE_ID)) {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({
    render: () =>
      h(DetailAlert as never, {
        deviceId: deviceIdRef.value,
        productId: '9100001',
      }),
  });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await flush();
  return { container, deviceIdRef };
}

function byTestId<T extends HTMLElement>(
  root: ParentNode,
  id: string,
): null | T {
  return root.querySelector<T>(`[data-testid="${id}"]`);
}

/** 活动告警请求（`activeOnly=true`）。 */
function activeCalls() {
  return apiMock.getDeviceAlertPage.mock.calls.filter(
    (call) => call[1]?.activeOnly === true,
  );
}

/** 历史告警请求（`state=RESOLVED`）。 */
function historyCalls() {
  return apiMock.getDeviceAlertPage.mock.calls.filter(
    (call) => call[1]?.state === 'RESOLVED',
  );
}

/** 活动告警表格当前渲染的行（antd 的展开行不算数据行）。 */
function activeRowEls(container: HTMLElement) {
  const table = byTestId<HTMLElement>(container, 'active-alert-table');
  return [
    ...(table?.querySelectorAll('tbody tr.ant-table-row') ?? []),
  ];
}

describe('活动告警分页：总数与页码可见（P2-5 核心）', () => {
  it('★ 首屏展示「共 25 条（当前第 1 页）」，请求参数 page=1/pageSize=20/activeOnly', async () => {
    const { container } = await mountAlert();

    const info = byTestId<HTMLElement>(container, 'active-page-info');
    expect(info, '活动告警区缺少总数/页码信息').toBeTruthy();
    // total 来自后端 long 字符串 '25'，展示前必须 toBackendNumber 归一
    expect(info?.textContent?.trim()).toBe(
      $t('page.iot.alert.activeTotal', [25, 1]),
    );
    expect(activeRowEls(container)).toHaveLength(2);

    const [firstCall] = activeCalls();
    expect(firstCall?.[0]).toBe(DEVICE_ID);
    expect(firstCall?.[1]).toEqual(
      expect.objectContaining({
        activeOnly: true,
        page: 1,
        pageSize: ACTIVE_PAGE_SIZE,
      }),
    );
    // 还有 23 条没加载 ⇒ 「加载更多」可见
    expect(byTestId(container, 'active-load-more')).toBeTruthy();
  });
});

describe('活动告警分页：加载更多请求第 2 页并追加行', () => {
  it('★ 点「加载更多」⇒ 请求 page=2，行数 2→4，页码变第 2 页', async () => {
    const { container } = await mountAlert();
    expect(activeRowEls(container)).toHaveLength(2);

    byTestId<HTMLButtonElement>(container, 'active-load-more')?.click();
    await flush();

    const calls = activeCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]).toEqual(
      expect.objectContaining({ page: 2, pageSize: ACTIVE_PAGE_SIZE }),
    );
    // 追加而非替换：第 1 页的 a1/a2 仍在
    expect(activeRowEls(container)).toHaveLength(4);
    expect(
      byTestId<HTMLElement>(container, 'active-page-info')?.textContent?.trim(),
    ).toBe($t('page.iot.alert.activeTotal', [25, 2]));
  });
});

describe('活动告警分页：加载更多失败保留已加载行', () => {
  it('★ 第 2 页失败 ⇒ 原有 2 行不动 + 原样后端 message 可见', async () => {
    const { container } = await mountAlert();
    expect(activeRowEls(container)).toHaveLength(2);

    failNextActivePage = new Error('活动告警第 2 页查询失败：后端 502');
    byTestId<HTMLButtonElement>(container, 'active-load-more')?.click();
    await flush();

    // 已加载数据不得清空（故障时用户仍需看到并处置现有活动告警）
    expect(activeRowEls(container)).toHaveLength(2);
    const moreError = byTestId<HTMLElement>(container, 'active-more-error');
    expect(moreError, '加载更多失败必须可见').toBeTruthy();
    expect(moreError?.textContent).toContain('活动告警第 2 页查询失败：后端 502');
    // 总数/页码不被失败请求污染
    expect(
      byTestId<HTMLElement>(container, 'active-page-info')?.textContent?.trim(),
    ).toBe($t('page.iot.alert.activeTotal', [25, 1]));
  });
});

describe('活动告警分页：切换设备重置到第 1 页', () => {
  it('★ 加载到第 2 页后切设备 ⇒ 新设备从 page=1 重新拉、行被替换、页码回 1', async () => {
    const { container, deviceIdRef } = await mountAlert();
    byTestId<HTMLButtonElement>(container, 'active-load-more')?.click();
    await flush();
    expect(
      byTestId<HTMLElement>(container, 'active-page-info')?.textContent?.trim(),
    ).toBe($t('page.iot.alert.activeTotal', [25, 2]));

    deviceIdRef.value = '9002';
    await flush();

    const calls = activeCalls();
    const lastCall = calls.at(-1);
    expect(lastCall?.[0]).toBe('9002');
    expect(lastCall?.[1]).toEqual(
      expect.objectContaining({ page: 1, pageSize: ACTIVE_PAGE_SIZE }),
    );
    // 新设备只有 1 条：旧设备的 4 行不得残留
    expect(activeRowEls(container)).toHaveLength(1);
    expect(
      byTestId<HTMLElement>(container, 'active-page-info')?.textContent?.trim(),
    ).toBe($t('page.iot.alert.activeTotal', [1, 1]));
  });
});

describe('活动告警分页：处置后的刷新回到第 1 页', () => {
  it('★ 第 2 页状态处置一条 ⇒ 刷新重拉回 page=1 且行被整体替换', async () => {
    const { container } = await mountAlert();
    byTestId<HTMLButtonElement>(container, 'active-load-more')?.click();
    await flush();
    expect(activeRowEls(container)).toHaveLength(4);

    // 行内「确认」（FIRING 行可用）⇒ 成功后宿主 reload()，必须从第 1 页重拉
    const ackButton = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="active-alert-table"] tbody button',
      ),
    ].find((button) => (button.textContent ?? '').includes('确认'));
    expect(ackButton, '活动告警行内缺少「确认」按钮').toBeTruthy();
    ackButton?.click();
    await flush();

    const calls = activeCalls();
    expect(calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ page: 1, pageSize: ACTIVE_PAGE_SIZE }),
    );
    // 回到第 1 页后行数 = 第 1 页条数（不是 2+2 的追加结果）
    expect(activeRowEls(container)).toHaveLength(2);
    expect(
      byTestId<HTMLElement>(container, 'active-page-info')?.textContent?.trim(),
    ).toBe($t('page.iot.alert.activeTotal', [25, 1]));
  });
});

describe('历史告警分页保持不动（回归）', () => {
  it('★ 历史页签翻页仍请求 state=RESOLVED + 对应 page，不影响活动告警请求', async () => {
    await mountAlert();
    const activeBefore = activeCalls().length;

    // 历史表分页器（只有历史表开启分页；total=25 会有第 2 页）
    const page2 = document.querySelector<HTMLElement>(
      '.ant-pagination-item-2',
    );
    expect(page2, '历史告警分页器未渲染第 2 页').toBeTruthy();
    page2?.click();
    await flush();

    const calls = historyCalls();
    const lastHistory = calls.at(-1);
    expect(lastHistory?.[1]).toEqual(
      expect.objectContaining({ page: 2, state: 'RESOLVED' }),
    );
    // 活动告警没有被历史翻页触发额外请求
    expect(activeCalls()).toHaveLength(activeBefore);
  });
});
