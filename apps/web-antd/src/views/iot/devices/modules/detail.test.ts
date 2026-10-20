import { createApp, h, nextTick } from 'vue';

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

import Detail from './detail.vue';
import detailSource from './detail.vue?raw';

/**
 * 设备详情抽屉「页签 + 概览分区」挂载安全网（批次 5 拆分前的回归基线）。
 *
 * 为什么先补这一层：`detail.vue` 是 60 天改动 19 次的全仓最热文件，当前只有
 * `detail-layout.test.ts` 的间接覆盖（布局/分区局部），**没有一条断言「7 个页签都能渲染」
 * 与「概览 API 失败时可见错误态」**。拆分概览卡片前先把这两条钉住，任何拆分导致的
 * 页签丢失/分区丢失/失败态被画成空白都会在这里立刻变红。
 *
 * 断言口径（拆分前后都必须成立，因此不绑定卡片文件名/内部结构）：
 * 1. 7 个页签（含权限页签）全部渲染；
 * 2. 概览 9 个 `data-section` 分区齐全（卡片拆分后标记必须保留）；
 * 3. 概览四类数据源全部失败时，各分区展示**原样后端 message** 的错误态，页面不空白；
 * 4. `PanelErrorBoundary(overviewRenderFailed)` 仍包住整个概览（子卡片抛错不能整抽屉崩）。
 */

const { apiMock, accessState, drawerCalls } = vi.hoisted(() => ({
  accessState: { accessCodes: ['*:*:*'], accessToken: 'test-token' },
  apiMock: {
    getDeviceAvailability: vi.fn(),
    getDeviceConnection: vi.fn(),
    getDeviceCredential: vi.fn(),
    getDeviceEvents: vi.fn(),
    getDeviceLatest: vi.fn(),
    getDeviceShadow: vi.fn(),
    getDeviceTags: vi.fn(),
    getProductDetail: vi.fn(),
  },
  drawerCalls: [] as Record<string, any>[],
}));

/**
 * 只替换「打开概览就会调用」的 8 个 API，其余导出保留真实实现。
 *
 * 用 `importOriginal` 而不是手写导出清单：detail.vue 的 import 图覆盖 7 个子组件 +
 * 十余个 API 函数，手写清单漏一个就会在模块加载期报「No export is defined」的假故障。
 */
vi.mock('#/api/iot', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    getDeviceAvailability: (...args: unknown[]) =>
      apiMock.getDeviceAvailability(...args),
    getDeviceConnection: (...args: unknown[]) =>
      apiMock.getDeviceConnection(...args),
    getDeviceCredential: (...args: unknown[]) =>
      apiMock.getDeviceCredential(...args),
    getDeviceEvents: (...args: unknown[]) => apiMock.getDeviceEvents(...args),
    getDeviceLatest: (...args: unknown[]) => apiMock.getDeviceLatest(...args),
    getDeviceShadow: (...args: unknown[]) => apiMock.getDeviceShadow(...args),
    getDeviceTags: (...args: unknown[]) => apiMock.getDeviceTags(...args),
    getProductDetail: (...args: unknown[]) => apiMock.getProductDetail(...args),
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

/** 实时订阅打桩：概览用例不关心 SSE，只需要不建立真实连接。 */
vi.mock('../../shared/use-iot-realtime', async () => {
  const { ref } = await import('vue');
  return {
    useIotRealtime: () => ({
      authError: ref(''),
      error: ref(''),
      onEvent: () => () => {},
      state: ref('closed'),
    }),
  };
});

/** 抽屉壳桩：把默认插槽渲染出来，并暴露 `onOpenChange` 供用例「打开」详情。 */
vi.mock('@vben/common-ui', async () => {
  const { defineComponent, h: render } = await import('vue');
  const DrawerStub = defineComponent({
    name: 'DrawerStub',
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () =>
        render(
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
        getData: () => ({
          deviceCode: 'DEMO-001',
          deviceName: '演示设备',
          endpoint: 'tcp://10.0.0.1:502',
          id: '9300012',
          lastSeenAt: '2026-10-15 08:00:00',
          onlineStatus: 'online',
          productId: '9100001',
          productVersion: 'v1.0',
          protocol: 'modbus',
          remark: '安全网用例设备',
          status: 1,
        }),
        open: vi.fn(),
        setData: vi.fn(),
        setState: vi.fn(),
      };
      return [DrawerStub, api];
    },
  };
});

const OVERVIEW_SECTIONS = [
  'overview-basic',
  'overview-latest',
  'overview-availability',
  'overview-recent-events',
  'overview-shadow-reported',
  'overview-shadow-desired',
  'overview-shadow-diff',
  'overview-tags',
  'overview-credential',
];

/** 7 个页签文案（拆分前后都必须全部出现；权限已全开）。 */
const TAB_TEXTS = [
  '概览',
  '属性与点位',
  '历史曲线',
  '事件与断档',
  '在线调试',
  '消息跟踪',
  '告警中心',
];

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

beforeEach(() => {
  drawerCalls.length = 0;
  for (const fn of Object.values(apiMock)) fn.mockReset();
  // 默认成功形态：每块都有数据，便于断言「渲染出来」而不是只测空态
  apiMock.getDeviceLatest.mockResolvedValue([
    {
      propertyId: 'temperature',
      quality: 'GOOD',
      ts: 1_790_400_000_000,
      value: '20',
    },
  ]);
  apiMock.getDeviceAvailability.mockResolvedValue({
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
  apiMock.getDeviceShadow.mockResolvedValue({
    desired: { temperature: 21 },
    desiredTs: '2026-10-15 08:00:00',
    reported: { temperature: 20 },
    reportTs: '2026-10-15 08:00:00',
  });
  apiMock.getDeviceEvents.mockResolvedValue({ items: [], total: '0' });
  apiMock.getProductDetail.mockResolvedValue({ productName: '演示产品' });
  apiMock.getDeviceTags.mockResolvedValue([]);
  apiMock.getDeviceCredential.mockResolvedValue({});
  apiMock.getDeviceConnection.mockResolvedValue({});
});

let mounted: undefined | { app: { unmount: () => void } };

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function flush() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountDetail() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(Detail as never) });
  registerAccessDirective(app);
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

describe('设备详情：7 个页签全部渲染（拆分安全网）', () => {
  it('★ 概览/属性与点位/历史曲线/事件与断档/在线调试/消息跟踪/告警中心 一个不少', async () => {
    const container = await mountDetail();
    const tabs = [...container.querySelectorAll('.ant-tabs-tab')].map((tab) =>
      tab.textContent?.trim(),
    );
    expect(tabs).toHaveLength(7);
    for (const text of TAB_TEXTS) {
      expect(
        tabs.some((label) => label?.includes(text)),
        `缺少页签：${text}（实际：${tabs.join(' / ')}）`,
      ).toBe(true);
    }
  });
});

describe('设备详情概览：9 个分区齐全（拆分安全网）', () => {
  it('★ 概览 9 个 data-section 分区都在，且容器保持 space-y-4 节奏', async () => {
    const container = await mountDetail();
    for (const marker of OVERVIEW_SECTIONS) {
      expect(
        container.querySelector(`[data-section="${marker}"]`),
        `缺少分区：${marker}`,
      ).toBeTruthy();
    }
    expect(
      container.querySelector('[data-section="overview"]')?.className,
    ).toContain('space-y-4');
  });

  it('★ 每个分区恰好渲染 1 次（拆卡后不得重复/遗漏），并排网格仍为 3 组', async () => {
    const container = await mountDetail();
    for (const marker of OVERVIEW_SECTIONS) {
      expect(
        container.querySelectorAll(`[data-section="${marker}"]`),
        `分区重复或缺失：${marker}`,
      ).toHaveLength(1);
    }
    // 布局契约：三组「≥md 两列」网格的子项必须仍然成对（用三个代表性分区的父节点取证，
    // 不按 class 全局计数——子组件内部也可能出现同名字段，会数错）
    for (const marker of [
      'overview-latest', // 最新值 + 可用率
      'overview-shadow-reported', // 影子 reported + desired
      'overview-tags', // 标签 + 凭据
    ]) {
      const grid = container.querySelector(
        `[data-section="${marker}"]`,
      )?.parentElement;
      expect(
        grid?.className,
        `${marker} 的父级不再是 md:grid-cols-2 并排网格`,
      ).toContain('md:grid-cols-2');
    }
  });
});

describe('设备详情概览：API 失败必须显示错误态，不得留空白', () => {
  it('★ 四类数据源全失败 ⇒ 各分区给出原样错误原因，页面不空白', async () => {
    // 用「后端 message 原样展示」口径断言：失败原因必须可见，而不是只剩空态/空白
    apiMock.getDeviceLatest.mockRejectedValue(
      new Error('最新值接口 500：时序库不可用'),
    );
    apiMock.getDeviceAvailability.mockRejectedValue(
      new Error('可用率接口 500：统计任务失败'),
    );
    apiMock.getDeviceShadow.mockRejectedValue(
      new Error('影子接口 500：影子表缺失'),
    );
    apiMock.getDeviceEvents.mockRejectedValue(
      new Error('事件接口 500：查询超时'),
    );

    const container = await mountDetail();
    const html = container.innerHTML;

    // 概览整体仍在（不是空白页/整块炸掉）
    expect(container.querySelector('[data-section="overview"]')).toBeTruthy();
    expect(container.querySelectorAll('.ant-tabs-tab')).toHaveLength(7);

    const latestSection = container.querySelector(
      '[data-section="overview-latest"]',
    );
    expect(latestSection?.textContent).toContain('最新值接口 500');
    const availabilitySection = container.querySelector(
      '[data-section="overview-availability"]',
    );
    expect(availabilitySection?.textContent).toContain('可用率接口 500');
    const shadowSection = container.querySelector(
      '[data-section="overview-shadow-reported"]',
    );
    expect(shadowSection?.textContent).toContain('影子接口 500');
    const eventsSection = container.querySelector(
      '[data-section="overview-recent-events"]',
    );
    expect(eventsSection?.textContent).toContain('事件接口 500');

    // 失败不能被画成「空态」文案（空态文案出现即等于把失败伪装成没有数据）
    expect(html).not.toContain($t('page.iot.device.latestEmpty'));
  });
});

describe('设备详情概览：错误边界仍包住整个概览', () => {
  it('源码契约：PanelErrorBoundary(overviewRenderFailed) 包住 data-section=overview 的整块', () => {
    // 边界必须在概览容器之前打开、在概览内容之后关闭；否则子卡片抛错会整抽屉崩
    const pattern =
      /<PanelErrorBoundary title-key="page\.iot\.device\.overviewRenderFailed">[\s\S]*data-section="overview"[\s\S]*<\/PanelErrorBoundary>/;
    expect(detailSource).toMatch(pattern);
    // 四个防线（overview/debug/trace/alert）一个都不能少
    expect(detailSource.match(/<PanelErrorBoundary/g) ?? []).toHaveLength(4);
  });
});
