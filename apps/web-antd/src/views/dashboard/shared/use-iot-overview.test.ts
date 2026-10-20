import { createApp, defineComponent, h, nextTick } from 'vue';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { useIotOverview } from './use-iot-overview';

/**
 * 运行总览数据域（`useIotOverview`）的失败口径用例。
 *
 * 为什么必须单列：这是本次审查唯一的 **P0** ——
 * 原先 `catch` 里无条件把整屏换成演示数据、`failed` 没人接、原因只进 hover tooltip，
 * 生产后端 5xx 时运维会拿伪造 KPI 当真实指标做判断。
 * 三条硬约束在这里锁死：
 *   1. 失败 ⇒ `failed = true` 且 `demoReason` 非空（页面据此渲染常驻错误 + 重试）；
 *   2. **生产（`import.meta.env.PROD`）失败不回落演示数据**（只保留错误态）；
 *   3. 非生产失败仍可兜底，但必须置 `usingDemo = true`（页面据此常驻「演示数据」提示）。
 */

const { getIotOverviewMock } = vi.hoisted(() => ({
  getIotOverviewMock: vi.fn(),
}));

vi.mock('#/api/dashboard/iot-overview', () => ({
  getIotOverview: getIotOverviewMock,
}));

// 只替换 `$t`：用例断言的是「原因非空」，不需要真实文案；
// 真实 i18n 编译已由 pages 的挂载用例与 i18n 门禁覆盖。
vi.mock('#/locales', () => ({
  $t: (key: string) => key,
}));

function mountProbe() {
  let api: ReturnType<typeof useIotOverview> | undefined;
  const Probe = defineComponent({
    name: 'UseIotOverviewProbe',
    setup() {
      api = useIotOverview();
      return () => h('div');
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp(Probe);
  app.mount(container);
  if (!api) {
    throw new Error('composable 未在 setup 中执行');
  }
  return { api, app };
}

/** 让 mock 的 promise 链与 onMounted 回调都跑完。 */
async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await nextTick();
  }
}

const validOverview = {
  alertPending: 1,
  alertResolvedToday: 0,
  alertRuleTop: [],
  alertToday: 1,
  alertTrend: [],
  deviceDisabled: 0,
  deviceGrowthTrend: [],
  deviceOffline: 0,
  deviceOnline: 1,
  deviceTotal: 1,
  messageDownlinkToday: 0,
  messageToday: 0,
  messageTrend: [],
  messageUplinkToday: 0,
  newDevicesWeek: 0,
  onlineRate: 100,
  onlineTrend: [],
  pointTotal: 0,
  productTop: [],
  productTotal: 1,
  protocolDistribution: [],
  recentAlerts: [],
  severityDistribution: [],
};

let mounted: ReturnType<typeof createApp> | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  getIotOverviewMock.mockReset();
  vi.unstubAllEnvs();
  document.body.innerHTML = '';
});

describe('useIotOverview：成功路径', () => {
  it('拿到真实数据 ⇒ failed/usingDemo 均为 false，overview 为接口数据', async () => {
    getIotOverviewMock.mockResolvedValue(validOverview);
    const probe = mountProbe();
    mounted = probe.app;
    await flush();

    expect(probe.api.loading.value).toBe(false);
    expect(probe.api.failed.value).toBe(false);
    expect(probe.api.usingDemo.value).toBe(false);
    expect(probe.api.demoReason.value).toBe('');
    expect(probe.api.overview.value?.deviceTotal).toBe(1);
  });

  it('响应缺关键字段（结构不完整）⇒ 视为失败，不把残缺数据当真实总览', async () => {
    getIotOverviewMock.mockResolvedValue({ deviceTotal: undefined });
    const probe = mountProbe();
    mounted = probe.app;
    await flush();

    expect(probe.api.failed.value).toBe(true);
    expect(probe.api.demoReason.value).not.toBe('');
  });
});

describe('useIotOverview：失败路径（非生产，允许演示兜底）', () => {
  it('reject ⇒ failed=true、demoReason 非空、usingDemo=true（页面必须能常驻提示）', async () => {
    getIotOverviewMock.mockRejectedValue(
      new Error('ECONNREFUSED 127.0.0.1:3000'),
    );
    const probe = mountProbe();
    mounted = probe.app;
    await flush();

    expect(probe.api.failed.value).toBe(true);
    expect(probe.api.demoReason.value).toContain('ECONNREFUSED');
    expect(probe.api.usingDemo.value).toBe(true);
    // 非生产才允许兜底：此时 overview 是演示数据（非 null）
    expect(probe.api.overview.value).not.toBeNull();
    expect(probe.api.overview.value?.deviceTotal).toBeGreaterThan(0);
  });

  it('后端业务 message 优先作为 demoReason（不是兜底文案）', async () => {
    // 真实形态是 AxiosError：Error 实例 + `response.data.message`（后端业务文案）
    const axiosLike = Object.assign(
      new Error('Request failed with status 500'),
      {
        response: { data: { message: '统计服务暂不可用' } },
      },
    );
    getIotOverviewMock.mockRejectedValue(axiosLike);
    const probe = mountProbe();
    mounted = probe.app;
    await flush();

    expect(probe.api.demoReason.value).toBe('统计服务暂不可用');
  });
});

describe('useIotOverview：失败提示只有一条（notice）', () => {
  it('成功 ⇒ notice 为 null（不渲染任何常驻提示）', async () => {
    getIotOverviewMock.mockResolvedValue(validOverview);
    const probe = mountProbe();
    mounted = probe.app;
    await flush();

    expect(probe.api.notice.value).toBeNull();
  });

  it('非生产兜底 ⇒ 一条 warning，标题是「演示数据」而不是「加载失败」', async () => {
    getIotOverviewMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const probe = mountProbe();
    mounted = probe.app;
    await flush();

    const notice = probe.api.notice.value;
    expect(notice?.type).toBe('warning');
    // $t 在本用例里被 mock 成「返回键名」，因此断言的是用了哪个 i18n 键
    expect(notice?.title).toBe('page.dashboard.demoModeTitle');
  });

  it('生产失败 ⇒ 一条 error，标题是「加载失败」', async () => {
    vi.stubEnv('PROD', true);
    getIotOverviewMock.mockRejectedValue(new Error('502'));
    const probe = mountProbe();
    mounted = probe.app;
    await flush();

    const notice = probe.api.notice.value;
    expect(notice?.type).toBe('error');
    expect(notice?.title).toBe('page.dashboard.overviewLoadFailed');
  });
});

describe('useIotOverview：生产环境失败不回落演示数据（P0 的回归闸门）', () => {
  it('环境变量 PROD=true 时 reject ⇒ failed=true、overview 保持 null、usingDemo=false', async () => {
    // 判断写在 `load()` 调用时而不是模块顶层，所以这里 stub 后无需重置模块
    vi.stubEnv('PROD', true);
    getIotOverviewMock.mockRejectedValue(new Error('502 Bad Gateway'));
    const probe = mountProbe();
    mounted = probe.app;
    await flush();

    expect(probe.api.failed.value).toBe(true);
    expect(probe.api.demoReason.value).toContain('502');
    // 关键断言：生产绝不允许把演示数字当真实指标渲染
    expect(probe.api.overview.value).toBeNull();
    expect(probe.api.usingDemo.value).toBe(false);
  });

  it('重试成功后可以从错误态恢复（overview 有值、failed 归位）', async () => {
    vi.stubEnv('PROD', true);
    getIotOverviewMock.mockRejectedValueOnce(new Error('500'));
    const probe = mountProbe();
    mounted = probe.app;
    await flush();
    expect(probe.api.failed.value).toBe(true);

    getIotOverviewMock.mockResolvedValueOnce({
      ...validOverview,
      deviceTotal: 7,
    });
    await probe.api.load();
    await flush();

    expect(probe.api.failed.value).toBe(false);
    expect(probe.api.demoReason.value).toBe('');
    expect(probe.api.overview.value?.deviceTotal).toBe(7);
  });
});
