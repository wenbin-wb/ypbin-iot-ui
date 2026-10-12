import { createApp, defineComponent, h, nextTick } from 'vue';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import TenantLedgerPage from './index.vue';

/**
 * 租户台账页壳（`tenant-ledger/index.vue`）的接线用例。
 *
 * 真实的三态（失败/空/有数据）在内容组件 `modules/ledger.vue` 里，由
 * `devices/list-states.test.ts` 覆盖；本用例只锁壳层：默认页签、两个子组件接线、
 * 切换页签后内容确实换掉。子组件用桩替换，避免把内容组件的网络请求重复引进来。
 */
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

vi.mock('@vben/common-ui', () => ({
  Page: defineComponent({
    name: 'PageStub',
    setup:
      (_props, { slots }) =>
      () =>
        h('div', { class: 'page-stub' }, slots.default?.()),
  }),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

let mounted: undefined | { app: { unmount: () => void } };

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('tenant-ledger/index.vue 页壳接线', () => {
  it('默认展示租户台账页签；切到接入节点页签后内容随之切换', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const app = createApp({ render: () => h(TenantLedgerPage as never) });
    app.mount(container);
    mounted = { app };
    await nextTick();

    const html = container.innerHTML;
    expect(html).toContain('租户接入台账');
    expect(html).toContain('接入节点与指标');
    expect(container.querySelector('[data-testid="ledger-stub"]')).toBeTruthy();

    const overviewTab = [
      ...container.querySelectorAll('.ant-tabs-tab'),
    ].find((tab) => tab.textContent?.includes('接入节点与指标')) as
      | HTMLElement
      | undefined;
    expect(overviewTab).toBeTruthy();
    overviewTab?.click();
    await nextTick();

    expect(
      container.querySelector('[data-testid="overview-stub"]'),
    ).toBeTruthy();
  });
});
