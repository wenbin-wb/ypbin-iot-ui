import { createApp, defineComponent, h, nextTick } from 'vue';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import HelpDrawer from '../../shared/help-drawer.vue';

/**
 * 术语词典抽屉的结构化用例。
 *
 * 硬约束：**10 条术语一条不能少**，且每条都要有「是什么」与「什么时候会用到」两段；
 * 用真实 vue-i18n（与 detail-debug.test.ts 同一套 setupI18n）渲染，顺带把
 * `page.iot.help.*` 文案编译一遍——字面 `{}` 之类会让整块空白的事故在这里暴露。
 */
const { drawerCalls, lastApi } = vi.hoisted(() => ({
  drawerCalls: [] as Record<string, unknown>[],
  lastApi: { current: null as null | Record<string, unknown> },
}));

vi.mock('@vben/common-ui', () => ({
  useVbenDrawer: (options: Record<string, unknown>) => {
    drawerCalls.push(options);
    const api = { close: vi.fn(), open: vi.fn(), setState: vi.fn() };
    lastApi.current = api;
    const Stub = defineComponent({
      name: 'DrawerStub',
      setup:
        (_props, { slots }) =>
        () =>
          h('div', { class: 'drawer-stub' }, slots.default?.()),
    });
    return [Stub, api];
  },
}));

vi.mock('@vben/preferences', () => ({
  preferences: { app: { accessMode: 'frontend', locale: 'zh-CN' } },
  updatePreferences: () => {},
}));

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
  drawerCalls.length = 0;
  lastApi.current = null;
});

function mountHelp() {
  const container = document.createElement('div');
  document.body.append(container);
  app = createApp({ render: () => h(HelpDrawer) });
  app.mount(container);
  return container;
}

describe('术语词典抽屉', () => {
  it('渲染全部 10 条术语，每条都有「是什么」与「什么时候会用到」', async () => {
    const container = mountHelp();
    await nextTick();
    const html = container.innerHTML;

    const titles = [
      '接入协议',
      '端点',
      '物模型',
      '点位映射',
      '设备影子',
      '可用率与断档',
      '维护窗口',
      '告警规则',
      '开放 API Key',
      '平台自告警',
    ];
    for (const title of titles) {
      expect(html, `缺少术语：${title}`).toContain(title);
    }
    // 标题由抽屉 setState 设置（见下一条用例），不在内容里重复渲染
    expect(html).toContain('这里用大白话解释平台里的常见术语');
    // 每条词条都应带两段标注（10 条 = 10 次），少一条即结构缺失
    expect(html.match(/是什么：/g) ?? []).toHaveLength(10);
    expect(html.match(/什么时候会用到：/g) ?? []).toHaveLength(10);
    // 不允许把 i18n 键名漏到界面上（两种语言包都合并后才会有值）
    expect(html).not.toContain('page.iot.help.');
  });

  it('打开时设置抽屉标题（标题走 i18n，不在模板里硬编码中文）', async () => {
    mountHelp();
    expect(drawerCalls).toHaveLength(1);
    const options = drawerCalls[0] as {
      onOpenChange?: (open: boolean) => unknown;
    };
    expect(typeof options.onOpenChange).toBe('function');
    await options.onOpenChange?.(true);
    expect(lastApi.current?.setState).toHaveBeenCalledWith({
      title: '术语词典',
    });
  });

  it('不渲染 emoji 充当图标（企业界面规则）', async () => {
    const container = mountHelp();
    await nextTick();
    const emoji = /[\u2600-\u27BF\u{1F000}-\u{1FAFF}]/u;
    expect(emoji.test(container.textContent ?? '')).toBe(false);
  });
});
