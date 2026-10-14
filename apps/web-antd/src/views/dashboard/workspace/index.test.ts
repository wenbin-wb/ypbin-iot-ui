import { createApp, h, nextTick } from 'vue';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import WorkspacePage from './index.vue';

/**
 * 工作台运行时冒烟用例。
 *
 * 为什么需要：页头三个关键计数是「裸插值」高发区——写成 `{ overview ? ... }`（单花括号）
 * 时 typecheck/oxlint 都不会报错，但界面会直接把表达式原样显示出来。这里用真实 i18n +
 * 真实页面挂载断言「数字确实渲染成了数字」，同时确认新手卡片与帮助入口在位。
 */
const { drawerApis, pushMock } = vi.hoisted(() => ({
  drawerApis: [] as Record<string, ReturnType<typeof vi.fn>>[],
  pushMock: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@vben/preferences', () => ({
  preferences: { app: { defaultAvatar: '' } },
  updatePreferences: () => {},
}));

vi.mock('@vben/stores', () => ({
  useUserStore: () => ({ userInfo: { realName: '值班员' } }),
}));

vi.mock('@vben/common-ui', async () => {
  const { defineComponent, h } = await import('vue');
  const SlotStub = (name: string) =>
    defineComponent({
      name,
      setup:
        (_props, { slots }) =>
        () =>
          h('div', [
            slots.title?.(),
            slots.description?.(),
            slots.actions?.(),
            slots.default?.(),
          ]),
    });
  return {
    useVbenDrawer: () => {
      const api = {
        close: vi.fn(),
        open: vi.fn(),
        setState: vi.fn(),
      };
      drawerApis.push(api);
      return [SlotStub('DrawerStub'), api];
    },
    WorkbenchHeader: SlotStub('WorkbenchHeader'),
    WorkbenchProject: SlotStub('WorkbenchProject'),
    WorkbenchQuickNav: SlotStub('WorkbenchQuickNav'),
    WorkbenchTodo: SlotStub('WorkbenchTodo'),
    WorkbenchTrends: SlotStub('WorkbenchTrends'),
  };
});

vi.mock('../shared/use-iot-overview', async () => {
  const { ref } = await import('vue');
  const overview = ref({
    alertPending: 3,
    deviceOffline: 3,
    deviceOnline: 7,
    deviceTotal: 42,
    messageDownlinkToday: 10,
    messageToday: 120,
    onlineRate: 70,
    recentAlerts: [],
  });
  return {
    useIotOverview: () => ({
      failed: false,
      load: () => {},
      loading: false,
      overview,
      usingDemo: true,
    }),
  };
});

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

let app: ReturnType<typeof createApp> | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = '';
  drawerApis.length = 0;
  pushMock.mockReset();
});

describe('工作台页面', () => {
  it('页头关键计数渲染成数字而不是表达式文本', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    app = createApp({ render: () => h(WorkspacePage) });
    app.mount(container);
    await nextTick();

    const text = container.textContent ?? '';
    expect(text).toContain('值班员');
    expect(text).toContain('42');
    expect(text).toContain('7');
    expect(text).not.toContain('overview ?');
  });

  it('新手卡片与演示数据徽标在位，帮助入口能打开共享抽屉', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    app = createApp({ render: () => h(WorkspacePage) });
    app.mount(container);
    await nextTick();

    const text = container.textContent ?? '';
    expect(text).toContain('新手快速上手');
    expect(text).toContain('演示数据');

    const helpButton = [...container.querySelectorAll('button')].find(
      (element) => element.textContent?.includes('术语看不懂？打开帮助'),
    );
    expect(helpButton, '未找到术语帮助入口').toBeTruthy();
    helpButton?.click();
    // 第一个 useVbenDrawer 是宿主页面自己的抽屉 API，帮助入口必须调用它打开
    expect(drawerApis[0]?.open).toHaveBeenCalledTimes(1);
  });
});
