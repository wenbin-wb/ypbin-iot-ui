import { createApp, defineComponent, h, nextTick } from 'vue';

import { i18n } from '@vben/locales';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import PanelErrorBoundary from '../../shared/panel-error-boundary.vue';
import availabilitySource from './availability.vue?raw';
import alertSource from './detail-alert.vue?raw';
import debugSource from './detail-debug.vue?raw';
import Detail from './detail.vue';
import detailSource from './detail.vue?raw';
import seriesSource from './series.vue?raw';
import traceSource from './trace.vue?raw';

/**
 * 设备详情「宽度 + 概览分区」布局契约用例。
 *
 * 用户反馈是「抽屉太窄、概览拥挤」——这类回归 typecheck/lint 都抓不到，因此这里显式锁：
 * 1. 三个抽屉的**宽度类是布局契约**（detail 92vw/max1560、series min(1200,96vw)、
 *    availability min(920,96vw)），源码级断言 + detail.vue 真实挂载断言 class 落到 DOM；
 * 2. 概览必须按卡片分区（`data-section` 标记），方便测试与后续维护定位；
 * 3. 基本信息 9 个字段齐全、顺序固定；信息密集表格必须 `overflow-x-auto`（窄屏横向滚动，
 *    而不是把列压扁）；两卡并排的区域统一 `md:grid-cols-2`；
 * 4. 其它信息密集页签（trace/告警/调试）的表格保留横向滚动。
 */
const { deviceRow, drawerCalls, mockGet } = vi.hoisted(() => ({
  deviceRow: {
    deviceCode: 'DEMO-001',
    deviceName: '演示设备',
    endpoint: 'tcp://10.0.0.1:502',
    id: '9300012',
    lastSeenAt: '2026-10-15 08:00:00',
    onlineStatus: 'online',
    productId: '9100001',
    productVersion: 'v1.0',
    protocol: 'modbus',
    remark: '布局用例设备',
    status: 1,
  },
  drawerCalls: [] as Record<string, any>[],
  mockGet: vi.fn(),
}));

vi.mock('#/api/request', () => ({
  requestClient: {
    delete: vi.fn(),
    get: (...args: unknown[]) => mockGet(...args),
    post: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock('@vben/stores', async () => {
  const { reactive } = await import('vue');
  return {
    useAccessStore: () =>
      reactive({ accessCodes: ['*:*:*'], accessToken: 'test-token' }),
    useUserStore: () => reactive({ userRoles: [] }),
  };
});

vi.mock('@vben/preferences', () => ({
  preferences: { app: { accessMode: 'frontend', locale: 'zh-CN' } },
  updatePreferences: () => {},
}));

vi.mock('../../shared/use-iot-realtime', async () => {
  const { ref } = await import('vue');
  return {
    useIotRealtime: () => ({
      error: ref(''),
      onEvent: () => () => {},
      state: ref('closed'),
    }),
  };
});

vi.mock('@vben/common-ui', async () => {
  const { defineComponent, h } = await import('vue');
  const DrawerStub = defineComponent({
    name: 'DrawerStub',
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () =>
        h(
          'div',
          { ...attrs, 'data-testid': 'detail-drawer' },
          slots.default?.(),
        );
    },
  });
  return {
    useVbenDrawer: (options: Record<string, any>) => {
      drawerCalls.push(options);
      const api = {
        close: vi.fn(),
        getData: () => deviceRow,
        open: vi.fn(),
        setData: vi.fn(),
        setState: vi.fn(),
      };
      return [DrawerStub, api];
    },
  };
});

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

beforeEach(() => {
  drawerCalls.length = 0;
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url.includes('/latest')) {
      return Promise.resolve([
        {
          propertyId: 'temperature',
          quality: 'GOOD',
          ts: 1_790_400_000_000,
          value: '20',
        },
      ]);
    }
    if (url.includes('/availability')) {
      return Promise.resolve({
        availability: '0.9999',
        outageCount: 1,
        outageSeconds: 60,
        outages: [
          {
            durationSec: 60,
            endTs: '2026-10-15 08:01:00',
            id: '1',
            reason: '本机探针',
            startTs: '2026-10-15 08:00:00',
          },
        ],
      });
    }
    if (url.includes('/shadow')) {
      return Promise.resolve({
        desired: { temperature: 21 },
        desiredTs: '2026-10-15 08:00:00',
        reported: { temperature: 20 },
        reportTs: '2026-10-15 08:00:00',
      });
    }
    if (url.includes('/events')) {
      return Promise.resolve({ items: [], total: '0' });
    }
    if (url.includes('/credential')) {
      return Promise.resolve({});
    }
    if (url.includes('/connection')) {
      return Promise.resolve({});
    }
    if (url.includes('/tags')) {
      return Promise.resolve([]);
    }
    if (url.includes('/products/')) {
      return Promise.resolve({ productName: '演示产品' });
    }
    return Promise.resolve({});
  });
});

let mounted: undefined | { app: { unmount: () => void } };

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountDetail() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(Detail as never) });
  app.mount(container);
  mounted = { app };
  await flush();
  const options = drawerCalls.find(
    (item) => typeof item.onOpenChange === 'function',
  );
  expect(options, 'useVbenDrawer(onOpenChange) 未被调用').toBeTruthy();
  await options?.onOpenChange?.(true);
  await flush();
  return container;
}

function findDrawerByClass(container: HTMLElement, className: string) {
  return [
    ...container.querySelectorAll<HTMLElement>('[data-testid="detail-drawer"]'),
  ].find((element) =>
    (element.getAttribute('class') ?? '').includes(className),
  );
}

describe('设备详情抽屉宽度契约', () => {
  it('三个抽屉宽度类符合布局规范（源码级）', () => {
    expect(detailSource).toContain('w-[92vw] max-w-[1560px]');
    expect(seriesSource).toContain('w-[min(1200px,96vw)]');
    expect(availabilitySource).toContain('w-[min(920px,96vw)]');
  });

  it('详情抽屉真实挂载后宽度 class 落到 DOM', async () => {
    const container = await mountDetail();
    const drawer = findDrawerByClass(container, 'w-[92vw]');
    expect(drawer).toBeTruthy();
    expect(drawer?.getAttribute('class')).toContain('max-w-[1560px]');
  });
});

describe('概览卡片分区', () => {
  it('概览按卡片分区：9 个 section 标记 + space-y-4 节奏', async () => {
    const container = await mountDetail();
    for (const marker of [
      'overview-basic',
      'overview-latest',
      'overview-availability',
      'overview-recent-events',
      'overview-shadow-reported',
      'overview-shadow-desired',
      'overview-shadow-diff',
      'overview-tags',
      'overview-credential',
    ]) {
      expect(
        container.querySelector(`[data-section="${marker}"]`),
        `缺少分区：${marker}`,
      ).toBeTruthy();
    }
    expect(
      container.querySelector('[data-section="overview"]')?.className,
    ).toContain('space-y-4');
  });

  it('基本信息卡：9 个字段齐全且顺序固定，分区标题在位', async () => {
    const container = await mountDetail();
    const basic = container.querySelector('[data-section="overview-basic"]');
    expect(basic).toBeTruthy();
    expect(basic?.textContent).toContain('基本信息');
    const labels = [
      ...(basic?.querySelectorAll('.ant-descriptions-item-label') ?? []),
    ].map((element) => element.textContent?.trim());
    expect(labels).toEqual([
      '设备编码',
      '设备名称',
      '所属产品',
      '接入协议',
      '端点',
      '启停',
      '在线状态',
      '最近在线',
      '备注',
    ]);
    // 响应式列数：sm 1 列 / md 2 列 / xl 3 列（源码契约，antd 渲染不出断点对象）
    expect(detailSource).toContain(':column="{ sm: 1, md: 2, xl: 3 }"');
  });

  it('信息密集区域：两卡并排 + 表格横向滚动 + 表格最小宽度', async () => {
    const container = await mountDetail();

    // 三组并排卡片（latest+availability / shadow / tags+credential）
    const grids = container.querySelectorAll('[class*="md:grid-cols-2"]');
    expect(grids.length).toBeGreaterThanOrEqual(3);

    const latestTable = container.querySelector(
      '[data-section="overview-latest"] table',
    );
    expect(latestTable).toBeTruthy();
    expect(latestTable?.className).toContain('min-w-[480px]');
    expect(
      latestTable?.closest('.overflow-x-auto'),
      '最新值表缺 overflow-x-auto',
    ).toBeTruthy();

    const shadowTables = [
      container.querySelector(
        '[data-section="overview-shadow-reported"] table',
      ),
      container.querySelector('[data-section="overview-shadow-desired"] table'),
    ];
    for (const table of shadowTables) {
      expect(table).toBeTruthy();
      expect(table?.closest('.overflow-x-auto')).toBeTruthy();
    }
  });

  it('🔴 影子区不再有过时误导文案：reported 空态不得推断成「设备没上报」', async () => {
    const container = await mountDetail();
    const reportedCard = container.querySelector(
      '[data-section="overview-shadow-reported"]',
    );
    expect(reportedCard).toBeTruthy();
    // 旧文案把「reported 为空」说成「生产代码无写入方」——后端上报链路已存在，属过时结论
    expect(detailSource).not.toContain('reportedDisabled');
    expect(reportedCard?.textContent).not.toContain('尚无数据不代表设备没上报');
    // 有上报数据时直接展示表格（不再无条件挂一条 Alert）
    expect(reportedCard?.querySelector('table')).toBeTruthy();
  });

  it('影子差异区块已接线（data-section + 真实差异表）', async () => {
    const container = await mountDetail();
    const diffSection = container.querySelector(
      '[data-section="overview-shadow-diff"]',
    );
    expect(diffSection).toBeTruthy();
    // mock 里 reported={temperature:20} / desired={temperature:21} ⇒ 一行「值不一致」
    const differ = diffSection?.querySelector(
      '[data-diff-status="value-differs"]',
    );
    expect(differ).toBeTruthy();
    expect(differ?.textContent).toContain('temperature');
  });

  it('事件与断档页签：卡片分组 + 断档表横向滚动', async () => {
    const container = await mountDetail();
    const tab = [...container.querySelectorAll('.ant-tabs-tab')].find((item) =>
      item.textContent?.includes('事件与断档'),
    ) as HTMLElement | undefined;
    expect(tab).toBeTruthy();
    tab?.click();
    await flush();

    const outagesTable = container.querySelector(
      '.ant-tabs-tabpane-active table[class*="min-w-[640px]"]',
    );
    expect(outagesTable).toBeTruthy();
    expect(outagesTable?.closest('.overflow-x-auto')).toBeTruthy();
    const sections = [
      ...container.querySelectorAll('.ant-tabs-tabpane-active section'),
    ];
    expect(sections.length).toBeGreaterThanOrEqual(2);
  });
});

describe('概览页签渲染错误边界（P1-8 影子事故的第二道防线）', () => {
  const Exploding = defineComponent({
    name: 'ExplodingOverviewChild',
    setup() {
      return () => {
        throw new Error('模拟概览渲染期异常：影子比对 RangeError 之类');
      };
    },
  });

  /** 还原真实语言包（防止本组用例注入的坏消息泄漏给其它用例）。 */
  async function restoreMessages() {
    const mod = (await import('#/locales/langs/zh-CN/page.json')) as {
      default?: Record<string, unknown>;
    };
    i18n.global.mergeLocaleMessage('zh-CN', {
      page: mod.default ?? mod,
    } as never);
    i18n.global.locale.value = 'zh-CN' as never;
  }

  afterEach(async () => {
    await restoreMessages();
  });

  it('源码契约：概览页签由 PanelErrorBoundary 包裹，标题键是 overviewRenderFailed', () => {
    // 四个页签（overview/debug/trace/alert）必须同一防线；此前只有后三个有
    expect(detailSource).toContain(
      'title-key="page.iot.device.overviewRenderFailed"',
    );
    expect(detailSource.match(/<PanelErrorBoundary/g)?.length ?? 0).toBe(4);
  });

  it('后代 render 抛错时概览边界用 Alert 展示错误，而不是留一片空白', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const app = createApp({
      render: () =>
        h(
          PanelErrorBoundary,
          { titleKey: 'page.iot.device.overviewRenderFailed' },
          { default: () => h(Exploding) },
        ),
    });
    app.mount(container);
    mounted = { app };
    await flush();

    const html = container.innerHTML;
    expect(html).toContain('设备概览渲染失败');
    expect(html).toContain('模拟概览渲染期异常');
  });

  it('真机形态复现：概览子组件 i18n 消息编译失败 ⇒ 抽屉不许空白，必须显示「设备概览渲染失败」', async () => {
    // 影子差异卡（ShadowDiff）是概览里的真实子组件，用它的标题键复现渲染期异常
    i18n.global.mergeLocaleMessage('zh-CN', {
      page: { iot: { shadow: { diffTitle: '{"a":1}' } } },
    } as never);
    i18n.global.locale.value = 'zh-CN' as never;

    const container = await mountDetail();
    const html = container.innerHTML;
    // 关键：不是空白，而是可读的失败态（含完整错误）
    expect(html).toContain('设备概览渲染失败');
    expect(html).toContain('Message compilation error');
  });
});

describe('其它信息密集页签：表格横向滚动保留', () => {
  it('消息跟踪/告警/在线调试的表格都有横向滚动配置', () => {
    expect(traceSource).toContain(':scroll="{ x: 1100, y: 420 }"');
    expect(
      alertSource.match(/:scroll="\{ x: \d+ \}"/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(debugSource).toContain(':scroll="{ x: 920 }"');
  });
});
