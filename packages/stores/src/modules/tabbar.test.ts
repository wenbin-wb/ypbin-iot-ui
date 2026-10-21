import { createRouter, createWebHistory } from 'vue-router';

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTabbarStore } from './tabbar';

describe('useAccessStore', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [],
  });
  router.push = vi.fn();
  router.replace = vi.fn();
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('adds a new tab', () => {
    const store = useTabbarStore();
    const tab: any = {
      fullPath: '/home',
      meta: {},
      key: '/home',
      name: 'Home',
      path: '/home',
    };
    const addNewTab = store.addTab(tab);
    expect(store.tabs.length).toBe(1);
    expect(store.tabs[0]).toEqual(addNewTab);
  });

  it('adds a new tab if it does not exist', () => {
    const store = useTabbarStore();
    const newTab: any = {
      fullPath: '/new',
      meta: {},
      name: 'New',
      path: '/new',
    };
    const addNewTab = store.addTab(newTab);
    expect(store.tabs).toContainEqual(addNewTab);
  });

  it('updates an existing tab instead of adding a new one', () => {
    const store = useTabbarStore();
    const initialTab: any = {
      fullPath: '/existing',
      meta: {
        fullPathKey: false,
      },
      name: 'Existing',
      path: '/existing',
      query: {},
    };
    store.addTab(initialTab);
    const updatedTab = { ...initialTab, query: { id: '1' } };
    store.addTab(updatedTab);
    expect(store.tabs.length).toBe(1);
    expect(store.tabs[0]?.query).toEqual({ id: '1' });
  });

  it('closes all tabs', async () => {
    const store = useTabbarStore();
    store.addTab({
      fullPath: '/home',
      meta: {},
      name: 'Home',
      path: '/home',
    } as any);
    router.replace = vi.fn();

    await store.closeAllTabs(router);

    expect(store.tabs.length).toBe(1);
  });

  it('closes a non-affix tab', () => {
    const store = useTabbarStore();
    const tab: any = {
      fullPath: '/closable',
      meta: {},
      name: 'Closable',
      path: '/closable',
    };
    store.tabs.push(tab);
    store._close(tab);
    expect(store.tabs.length).toBe(0);
  });

  it('does not close an affix tab', () => {
    const store = useTabbarStore();
    const affixTab: any = {
      fullPath: '/affix',
      meta: { affixTab: true },
      name: 'Affix',
      path: '/affix',
    };
    store.tabs.push(affixTab);
    store._close(affixTab);
    expect(store.tabs.length).toBe(1); // Affix tab should not be closed
  });

  it('returns all cache tabs', () => {
    const store = useTabbarStore();
    store.cachedTabs.add('Home');
    store.cachedTabs.add('About');
    expect(store.getCachedTabs).toEqual(['Home', 'About']);
  });

  it('returns all tabs, including affix tabs', () => {
    const store = useTabbarStore();
    const normalTab: any = {
      fullPath: '/normal',
      meta: {},
      name: 'Normal',
      path: '/normal',
    };
    const affixTab: any = {
      fullPath: '/affix',
      meta: { affixTab: true },
      name: 'Affix',
      path: '/affix',
    };
    store.tabs.push(normalTab);
    store.affixTabs.push(affixTab);
    expect(store.getTabs).toContainEqual(normalTab);
    expect(store.affixTabs).toContainEqual(affixTab);
  });

  it('navigates to a specific tab', async () => {
    const store = useTabbarStore();
    const tab: any = { meta: {}, name: 'Dashboard', path: '/dashboard' };

    await store._goToTab(tab, router);

    expect(router.replace).toHaveBeenCalledWith({
      params: {},
      path: '/dashboard',
      query: {},
    });
  });

  it('closes multiple tabs by paths', async () => {
    const store = useTabbarStore();
    store.addTab({
      fullPath: '/home',
      meta: {},
      name: 'Home',
      path: '/home',
    } as any);
    store.addTab({
      fullPath: '/about',
      meta: {},
      name: 'About',
      path: '/about',
    } as any);
    store.addTab({
      fullPath: '/contact',
      meta: {},
      name: 'Contact',
      path: '/contact',
    } as any);

    await store._bulkCloseByKeys(['/home', '/contact']);

    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.name).toBe('About');
  });

  it('closes all tabs to the left of the specified tab', async () => {
    const store = useTabbarStore();
    store.addTab({
      fullPath: '/home',
      meta: {},
      name: 'Home',
      path: '/home',
    } as any);
    store.addTab({
      fullPath: '/about',
      meta: {},
      name: 'About',
      path: '/about',
    } as any);
    const targetTab: any = {
      fullPath: '/contact',
      meta: {},
      name: 'Contact',
      path: '/contact',
    };
    const addTargetTab = store.addTab(targetTab);
    await store.closeLeftTabs(addTargetTab);

    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.name).toBe('Contact');
  });

  it('closes all tabs except the specified tab', async () => {
    const store = useTabbarStore();
    store.addTab({
      fullPath: '/home',
      meta: {},
      name: 'Home',
      path: '/home',
    } as any);
    const targetTab: any = {
      fullPath: '/about',
      meta: {},
      name: 'About',
      path: '/about',
    };
    const addTargetTab = store.addTab(targetTab);
    store.addTab({
      fullPath: '/contact',
      meta: {},
      name: 'Contact',
      path: '/contact',
    } as any);

    await store.closeOtherTabs(addTargetTab);

    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.name).toBe('About');
  });

  it('closes all tabs to the right of the specified tab', async () => {
    const store = useTabbarStore();
    const targetTab: any = {
      fullPath: '/home',
      meta: {},
      name: 'Home',
      path: '/home',
    };
    const addTargetTab = store.addTab(targetTab);
    store.addTab({
      fullPath: '/about',
      meta: {},
      name: 'About',
      path: '/about',
    } as any);
    store.addTab({
      fullPath: '/contact',
      meta: {},
      name: 'Contact',
      path: '/contact',
    } as any);

    await store.closeRightTabs(addTargetTab);

    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.name).toBe('Home');
  });

  it('closes the tab with the specified key', async () => {
    const store = useTabbarStore();
    const keyToClose = '/about';
    store.addTab({
      fullPath: '/home',
      meta: {},
      name: 'Home',
      path: '/home',
    } as any);
    store.addTab({
      fullPath: keyToClose,
      meta: {},
      name: 'About',
      path: '/about',
    } as any);
    store.addTab({
      fullPath: '/contact',
      meta: {},
      name: 'Contact',
      path: '/contact',
    } as any);

    await store.closeTabByKey(keyToClose, router);

    expect(store.tabs).toHaveLength(2);
    expect(
      store.tabs.find((tab) => tab.fullPath === keyToClose),
    ).toBeUndefined();
  });

  it('refreshes the current tab', async () => {
    const store = useTabbarStore();
    const currentTab: any = {
      fullPath: '/dashboard',
      meta: { name: 'Dashboard' },
      name: 'Dashboard',
      path: '/dashboard',
    };
    router.currentRoute.value = currentTab;

    await store.refresh(router);

    expect(store.excludeCachedTabs.has('Dashboard')).toBe(false);
    expect(store.renderRouteView).toBe(true);
  });

  it('★ 页内 query 变化不得新开标签（数字孪生切场景 / 设备台账开抽屉）', () => {
    // 现场：/iot/twin?sceneId=A 切到 ?sceneId=B 会多一个「数字孪生」标签。
    // 根因：getTabKey 默认用 fullPath（含 query）。修复：路由 meta 统一兜底
    // fullPathKey: false（见 effects/access/src/accessible.ts 的 fork 定制）。
    const store = useTabbarStore();
    const base = {
      meta: { fullPathKey: false, title: '数字孪生' },
      name: 'IotDigitalTwin',
      path: '/iot/twin',
    };
    store.addTab({ ...base, fullPath: '/iot/twin?sceneId=1', query: { sceneId: '1' } } as any);
    store.addTab({ ...base, fullPath: '/iot/twin?sceneId=2', query: { sceneId: '2' } } as any);
    store.addTab({
      ...base,
      fullPath: '/iot/twin?sceneId=2&pointId=9',
      query: { pointId: '9', sceneId: '2' },
    } as any);

    expect(store.tabs.length, '同一 path 的不同 query 必须复用同一个标签').toBe(1);
    // 标签上的 query 应更新为最新值（深链可分享）
    expect(store.tabs[0]?.query).toEqual({ pointId: '9', sceneId: '2' });
  });

  it('显式 fullPathKey: true 的页面仍按 query 开多标签（不破坏该能力）', () => {
    // 兜底只在「未显式设置」时生效；需要「一个 query 一个标签」的页面仍可自行声明。
    const store = useTabbarStore();
    const base = {
      meta: { fullPathKey: true },
      name: 'Detail',
      path: '/detail',
    };
    store.addTab({ ...base, fullPath: '/detail?id=1', query: { id: '1' } } as any);
    store.addTab({ ...base, fullPath: '/detail?id=2', query: { id: '2' } } as any);
    expect(store.tabs.length).toBe(2);
  });
});
