import { createApp, defineComponent, h, nextTick } from 'vue';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import TenantLedgerPage from './index.vue';
import AccessTopology from './modules/access-topology.vue';

/**
 * 接入拓扑用例。
 *
 * 本文件锁四类行为（与文件头的字段诚实性约定一一对应）：
 * 1. **节点/边生成**：只画「平台 → 接入节点」「平台 → 租户」两类星形边，
 *    **绝不允许**出现 accessNode → tenant 的归属边（后端没有这层映射，画了就是编造）；
 *    节点大小按 holdingCount/deviceCount，颜色按 leaseAlive/reportLag 阈值；
 * 2. **字段诚实性**：reported=false 时指标卡显示「尚未上报」，不把缺省当 0；
 * 3. **租户名回落**：名称接口失败时节点名回落 tenantId，拓扑照常渲染，且失败可见；
 * 4. **空态/失败态**：空数组给空态；两个关键数据源任一失败给原样后端 message，不画半张图。
 */
const { chartOptions, mockApi } = vi.hoisted(() => ({
  chartOptions: [] as Record<string, any>[],
  mockApi: {
    getAccessOverview: vi.fn(),
    getTenantLedgerList: vi.fn(),
    getTenantList: vi.fn(),
  },
}));

vi.mock('@vben/plugins/echarts', async () => {
  const { defineComponent, h } = await import('vue');
  const EchartsUI = defineComponent({
    name: 'EchartsUIStub',
    setup: () => () => h('div', { class: 'echarts-stub' }),
  });
  return {
    EchartsUI,
    useEcharts: () => ({
      isActive: { value: false },
      renderEcharts: (options: Record<string, any>) => {
        chartOptions.push(options);
        return Promise.resolve(null);
      },
    }),
  };
});

vi.mock('#/api/iot/accessOverview', () => ({
  getAccessOverview: (...args: unknown[]) => mockApi.getAccessOverview(...args),
}));

vi.mock('#/api/iot', () => ({
  getTenantLedgerList: (...args: unknown[]) =>
    mockApi.getTenantLedgerList(...args),
}));

vi.mock('#/api/system/tenant', () => ({
  getTenantList: (...args: unknown[]) => mockApi.getTenantList(...args),
}));

// 页壳用例只需要 Page 容器，子内容用桩，避免把 ledger/access-overview 的网络请求带进来。
vi.mock('@vben/common-ui', () => ({
  Page: defineComponent({
    name: 'PageStub',
    setup:
      (_props, { slots }) =>
      () =>
        h('div', { class: 'page-stub' }, slots.default?.()),
  }),
}));

vi.mock('./modules/ledger.vue', () => ({
  default: defineComponent({
    name: 'TenantLedgerStub',
    setup: () => () => h('div', { 'data-testid': 'ledger-stub' }),
  }),
}));

vi.mock('./modules/access-overview.vue', () => ({
  default: defineComponent({
    name: 'AccessOverviewStub',
    setup: () => () => h('div', { 'data-testid': 'overview-stub' }),
  }),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

beforeEach(() => {
  mockApi.getAccessOverview.mockReset();
  mockApi.getTenantLedgerList.mockReset();
  mockApi.getTenantList.mockReset();
});

let mounted: undefined | { app: { unmount: () => void } };

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  chartOptions.length = 0;
  document.body.innerHTML = '';
});

function bizFailure(code: number, message: string) {
  return Object.assign(new Error(message), {
    response: { data: { code, data: null, message } },
  });
}

function accessOverview(
  overrides: Record<string, any> = {},
  metrics: Record<string, any> = {},
) {
  return {
    metrics: {
      egressPendingCount: 0,
      nodeFencedCount: 0,
      reconcileDeferredCount: 0,
      renewFailureCount: 0,
      reported: true,
      reportLagMs: 1200,
      selfFencedCount: 0,
      specLoadDurationMaxMs: 2,
      tickDurationMaxMs: 3,
      ...metrics,
    },
    nodes: [],
    ...overrides,
  };
}

function ledgerRow(tenantId: string, overrides: Record<string, any> = {}) {
  return { assignable: true, deviceCount: 5, tenantId, ...overrides };
}

function tenant(id: string, name: string) {
  return { code: id, id, name };
}

/** 等待 load 的 allSettled + 名称解析 + watch(flush post) 全部落定。 */
async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountComponent(component: unknown) {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(component as never) });
  app.mount(container);
  mounted = { app };
  await flush();
  return container;
}

function graphNodes(): Record<string, any>[] {
  const options = chartOptions.at(-1);
  return (options?.series?.[0]?.data ?? []) as Record<string, any>[];
}

function graphEdges(): Record<string, any>[] {
  const options = chartOptions.at(-1);
  return (options?.series?.[0]?.edges ?? []) as Record<string, any>[];
}

describe('access-topology：节点与边生成', () => {
  it('平台为中心，星形直连节点与租户；不生成 accessNode→tenant 归属边', async () => {
    mockApi.getAccessOverview.mockResolvedValue(
      accessOverview({
        nodes: [
          {
            accessNode: 'access-a',
            holdingCount: 16,
            leaseAlive: true,
            leaseRemainingSec: 30,
            maxTenants: 5,
          },
          {
            accessNode: 'access-b',
            holdingCount: 1,
            leaseAlive: false,
            leaseRemainingSec: -5,
            maxTenants: 5,
          },
        ],
      }),
    );
    mockApi.getTenantLedgerList.mockResolvedValue([
      ledgerRow('t1', { deviceCount: 20 }),
      ledgerRow('t2', { assignable: false, deviceCount: 1 }),
    ]);
    mockApi.getTenantList.mockResolvedValue([
      tenant('t1', '租户甲'),
      tenant('t2', '租户乙'),
    ]);

    const container = await mountComponent(AccessTopology);
    expect(container.querySelector('.echarts-stub')).toBeTruthy();

    const nodes = graphNodes();
    expect(nodes).toHaveLength(5);

    const platform = nodes.find((node) => node.id === 'platform');
    expect(platform?.category).toBe(0);
    expect(platform?.itemStyle?.color).toBe('#00b42a'); // reportLag 1200 < 45s

    const accessA = nodes.find((node) => node.id === 'access:access-a');
    const accessB = nodes.find((node) => node.id === 'access:access-b');
    expect(accessA?.itemStyle?.color).toBe('#00b42a'); // leaseAlive=true
    expect(accessB?.itemStyle?.color).toBe('#f2547b'); // leaseAlive=false
    expect(accessA?.symbolSize).toBeGreaterThan(accessB?.symbolSize ?? 0);
    expect(accessA?.name).toContain('持有 16 个租户');

    const tenantNodes = nodes.filter((node) =>
      String(node.id).startsWith('tenant:'),
    );
    expect(tenantNodes.map((node) => node.name)).toEqual(['租户甲', '租户乙']);
    expect(tenantNodes[0]?.symbolSize).toBeGreaterThan(
      tenantNodes[1]?.symbolSize ?? 0,
    );
    expect(tenantNodes[1]?.itemStyle?.color).toBe('#8a94a6'); // 不可接入置灰

    const edges = graphEdges();
    expect(edges).toHaveLength(4);
    expect(edges.every((edge) => edge.source === 'platform')).toBe(true);
    // 后端没有 accessNode→tenant 映射 ⇒ 绝不能出现这类边
    expect(
      edges.some(
        (edge) =>
          String(edge.source).startsWith('access:') &&
          String(edge.target).startsWith('tenant:'),
      ),
    ).toBe(false);
  });

  it('平台颜色按 reportLag 阈值切换：≥45s 变红；legend/categories 走 i18n', async () => {
    mockApi.getAccessOverview.mockResolvedValue(
      accessOverview(
        {
          nodes: [
            { accessNode: 'access-a', holdingCount: 1, leaseAlive: true },
          ],
        },
        { reported: true, reportLagMs: 60_000 },
      ),
    );
    mockApi.getTenantLedgerList.mockResolvedValue([]);
    mockApi.getTenantList.mockResolvedValue([]);

    await mountComponent(AccessTopology);
    const nodes = graphNodes();
    expect(nodes.find((node) => node.id === 'platform')?.itemStyle?.color).toBe(
      '#f2547b',
    );
    const options = chartOptions.at(-1);
    expect(options?.legend?.data).toEqual(['IoT 平台', '接入节点', '租户']);
  });
});

describe('access-topology：reported=false 字段诚实性', () => {
  it('未上报时指标卡统一显示「尚未上报」，不把缺省当 0', async () => {
    mockApi.getAccessOverview.mockResolvedValue(
      accessOverview(
        {},
        {
          reconcileDeferredCount: 777,
          reported: false,
          selfFencedCount: 123,
        },
      ),
    );
    mockApi.getTenantLedgerList.mockResolvedValue([]);
    mockApi.getTenantList.mockResolvedValue([]);

    const container = await mountComponent(AccessTopology);
    const text = container.textContent ?? '';
    expect(text).toContain('access 尚未上报指标');
    expect(text).not.toContain('777');
    expect(text).not.toContain('123');
    // 4 张指标卡 + 卡片标题状态 Tag 都应显示未上报
    expect(
      text.match(/access 尚未上报指标/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(4);
  });
});

describe('access-topology：租户名回落不阻塞拓扑', () => {
  it('名称接口失败 ⇒ 节点名回落 tenantId，仍出图，失败原因可见', async () => {
    const backendMessage = '无系统租户查询权限';
    mockApi.getAccessOverview.mockResolvedValue(
      accessOverview({
        nodes: [{ accessNode: 'access-a', holdingCount: 2, leaseAlive: true }],
      }),
    );
    mockApi.getTenantLedgerList.mockResolvedValue([ledgerRow('t1')]);
    mockApi.getTenantList.mockRejectedValue(bizFailure(40_303, backendMessage));

    const container = await mountComponent(AccessTopology);
    expect(container.querySelector('.echarts-stub')).toBeTruthy();

    const tenantNode = graphNodes().find((node) =>
      String(node.id).startsWith('tenant:'),
    );
    expect(tenantNode?.name).toBe('t1');
    expect(container.textContent).toContain(backendMessage);
    expect(container.textContent).toContain('租户名称加载失败');
    // 接入节点不受名称解析失败影响
    expect(graphNodes().some((node) => node.id === 'access:access-a')).toBe(
      true,
    );
  });
});

describe('access-topology：空态与失败态', () => {
  it('两端都成功但为空 ⇒ 空态文案，不渲染画布', async () => {
    mockApi.getAccessOverview.mockResolvedValue(accessOverview());
    mockApi.getTenantLedgerList.mockResolvedValue([]);
    mockApi.getTenantList.mockResolvedValue([]);

    const container = await mountComponent(AccessTopology);
    expect(container.textContent).toContain('暂无可展示的接入节点与租户');
    expect(container.querySelector('.echarts-stub')).toBeNull();
  });

  it('接入概览失败 ⇒ 原样展示后端 message，不画图也不假装空态', async () => {
    const backendMessage = 'access 概览查询炸了';
    mockApi.getAccessOverview.mockRejectedValue(
      bizFailure(50_000, backendMessage),
    );
    mockApi.getTenantLedgerList.mockResolvedValue([ledgerRow('t1')]);
    mockApi.getTenantList.mockResolvedValue([tenant('t1', '租户甲')]);

    const container = await mountComponent(AccessTopology);
    expect(container.textContent).toContain(backendMessage);
    expect(container.textContent).toContain('加载接入概览失败');
    expect(container.querySelector('.echarts-stub')).toBeNull();
    expect(container.textContent).not.toContain('暂无可展示的接入节点与租户');
  });

  it('租户台账失败 ⇒ 同样可见，且不画半张拓扑', async () => {
    const backendMessage = '租户台账查询炸了';
    mockApi.getAccessOverview.mockResolvedValue(
      accessOverview({
        nodes: [{ accessNode: 'access-a', holdingCount: 2, leaseAlive: true }],
      }),
    );
    mockApi.getTenantLedgerList.mockRejectedValue(
      bizFailure(50_000, backendMessage),
    );

    const container = await mountComponent(AccessTopology);
    expect(container.textContent).toContain(backendMessage);
    expect(container.textContent).toContain('租户接入台账加载失败');
    expect(container.querySelector('.echarts-stub')).toBeNull();
    expect(container.textContent).not.toContain('暂无可展示的接入节点与租户');
  });
});

describe('tenant-ledger 页壳：第三个「接入拓扑」页签', () => {
  it('页签存在，切过去后真的挂载拓扑内容', async () => {
    mockApi.getAccessOverview.mockResolvedValue(accessOverview());
    mockApi.getTenantLedgerList.mockResolvedValue([]);
    mockApi.getTenantList.mockResolvedValue([]);

    const container = await mountComponent(TenantLedgerPage);
    const tabs = [...container.querySelectorAll('.ant-tabs-tab')];
    expect(tabs.map((tab) => tab.textContent?.trim())).toContain('接入拓扑');

    const topologyTab = tabs.find((tab) =>
      tab.textContent?.includes('接入拓扑'),
    ) as HTMLElement | undefined;
    expect(topologyTab).toBeTruthy();
    topologyTab?.click();
    await flush();

    expect(container.textContent).toContain('暂无可展示的接入节点与租户');
  });
});
