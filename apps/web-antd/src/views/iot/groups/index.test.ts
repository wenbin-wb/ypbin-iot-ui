import { createApp, defineComponent, h, nextTick, ref } from 'vue';

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

import GroupsPage from './index.vue';

/**
 * 设备分组列表页（`groups/index.vue`）的行为用例。
 *
 * 覆盖两层：
 * 1. **三态**（失败 / 真的为空 / 有数据）——与 `devices/list-states.test.ts` 的跨页判据同源，
 *    这里再在本页文件内锁一遍（该文件是跨 5 个列表页的一致性用例，本页文件保证本页自身可回归）；
 * 2. **交互**（本页此前完全没有用例）：行内「删除」确认后必须真的调 `deleteGroup` 并刷新列表；
 *    失败时**不得**刷新（不能把失败当成功）；「新增/编辑/成员管理」三个入口要正确打开对应抽屉。
 *
 * 用真实 vue-i18n（不 mock `#/locales`）：文案编译不过会让用例一起红。
 */

const { captured, drawerApis, gridApiMock, gridStub, mockApi } = vi.hoisted(
  () => ({
    /** 抓取页面传给 `useVbenVxeGrid` 的配置（用于直接触发 `ajax.query`）。 */
    captured: { options: null as any },
    /** 按 `useVbenDrawer` 的调用顺序抓取两个抽屉 api（0=表单，1=成员）。 */
    drawerApis: [] as any[],
    /** 页面调用 `gridApi.query()` 刷新列表；这里抓 spies 以便断言。 */
    gridApiMock: { query: vi.fn() },
    /** 表格桩：默认不渲染 `#empty` 槽（证明失败提示不依赖槽位）；可切换渲染 action 槽。 */
    gridStub: { renderAction: false, renderEmpty: false, row: null as any },
    mockApi: {
      deleteGroup: vi.fn(),
      getGroupList: vi.fn(),
      getGroupTreeOptions: vi.fn(),
    },
  }),
);

vi.mock('#/api/iot', () => ({
  deleteGroup: (...args: unknown[]) => mockApi.deleteGroup(...args),
  getGroupList: (...args: unknown[]) => mockApi.getGroupList(...args),
}));

vi.mock('#/api/iot/group', () => ({
  getGroupTreeOptions: (...args: unknown[]) =>
    mockApi.getGroupTreeOptions(...args),
  // 与 api/iot/group.ts 的真实语义一致：空值/0/"0" 都是根分组
  isRootGroup: (parentId?: null | number | string) =>
    parentId === undefined ||
    parentId === null ||
    parentId === '' ||
    parentId === '0' ||
    parentId === 0,
}));

vi.mock('@vben/common-ui', () => ({
  Page: defineComponent({
    name: 'PageStub',
    setup:
      (_props, { slots }) =>
      () =>
        h('div', slots.default?.()),
  }),
  useVbenDrawer: () => {
    const api: any = { close: vi.fn(), open: vi.fn(), setData: vi.fn() };
    // 真实抽屉 api 可链式调用（页面写的是 `setData(row).open()`）⇒ 桩必须返回自身
    api.setData.mockReturnValue(api);
    drawerApis.push(api);
    return [
      defineComponent({ name: 'DrawerStub', setup: () => () => null }),
      api,
    ];
  },
}));

vi.mock('#/adapter/vxe-table', () => ({
  /** 行内动作桩：点击按钮 = 用户点动作（带确认的直接走「已确认」分支）。 */
  VbenTableAction: defineComponent({
    name: 'TableActionStub',
    props: { actions: { default: () => [], type: Array } },
    setup(props) {
      return () =>
        h(
          'div',
          (props.actions as any[]).map((action) =>
            h(
              'button',
              {
                'data-action': action.text,
                onClick: () => {
                  if (action.popConfirm) {
                    action.popConfirm.confirm?.();
                  } else {
                    action.onClick?.();
                  }
                },
              },
              action.text,
            ),
          ),
        );
    },
  }),
  useVbenVxeGrid: (options: any) => {
    captured.options = options;
    const GridStub = defineComponent({
      name: 'GridStub',
      setup:
        (_props, { slots }) =>
        () =>
          h('div', { class: 'grid-stub' }, [
            // 工具栏「新增」按钮挂在 #toolbar-tools 槽里
            slots['toolbar-tools']?.(),
            gridStub.renderEmpty ? slots.empty?.() : undefined,
            gridStub.renderAction && slots.action
              ? h('div', slots.action({ row: gridStub.row }))
              : undefined,
          ]),
    });
    return [GridStub, gridApiMock];
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores, useAccessStore } = await import('@vben/stores');
  await initStores(app, { namespace: 'test' });
  // 页面模板里有 `v-access:code`：不授权按钮会被指令摘掉，交互用例就跑不到
  useAccessStore().setAccessCodes(['*:*:*']);
});

/** 后端「业务失败」信封（HTTP 200 + `R.code != 200`，全仓约定）。 */
function bizFailure(code: number, message: string) {
  return Object.assign(new Error(message), {
    response: { data: { code, data: null, message } },
  });
}

const ROW = {
  createTime: '2026-01-01 00:00:00',
  groupName: '产线 A',
  id: 'g-1',
  remark: '',
  sort: 1,
};

let mounted: undefined | { app: { unmount: () => void } };

async function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(GroupsPage as never) });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await nextTick();
  return container;
}

async function runQuery() {
  const query = captured.options?.gridOptions?.proxyConfig?.ajax?.query;
  expect(query, '页面没有把 ajax.query 交给表格').toBeTypeOf('function');
  return await query({ page: { currentPage: 1, pageSize: 10 } });
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  for (const fn of Object.values(gridApiMock)) fn.mockReset();
  drawerApis.length = 0;
  captured.options = null;
  gridStub.renderAction = false;
  gridStub.renderEmpty = false;
  gridStub.row = null;
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('groups/index.vue 三态', () => {
  it('查询失败 ⇒ 原样展示后端 message + 失败标题，且**不出现**空态引导（即便 #empty 槽被渲染）', async () => {
    const backendMessage = '查询被拒绝：无对应权限';
    mockApi.getGroupList.mockRejectedValue(bizFailure(40_303, backendMessage));
    gridStub.renderEmpty = true;

    const container = await mountPage();
    await expect(runQuery()).rejects.toThrow(backendMessage);
    await nextTick();

    const html = container.innerHTML;
    expect(html).toContain(backendMessage);
    expect(html).toContain('设备分组列表加载失败');
    expect(html).not.toContain('该租户还没有设备分组');
  });

  it('确实没有数据 ⇒ 展示空态引导，且不是失败态', async () => {
    mockApi.getGroupList.mockResolvedValue([]);
    gridStub.renderEmpty = true;

    const container = await mountPage();
    await expect(runQuery()).resolves.toEqual([]);
    await nextTick();

    const html = container.innerHTML;
    expect(html).toContain('该租户还没有设备分组');
    expect(html).not.toContain('设备分组列表加载失败');
  });

  it('有数据 ⇒ 查询把服务端行原样交给表格，且失败提示保持清空', async () => {
    mockApi.getGroupList.mockResolvedValue([ROW]);

    const container = await mountPage();
    await expect(runQuery()).resolves.toEqual([ROW]);
    await nextTick();

    expect(container.innerHTML).not.toContain('设备分组列表加载失败');
  });

  it('层级数据 ⇒ 一次批量补 parentIdName；父分组不存在时保持空（列显示 -）', async () => {
    mockApi.getGroupList.mockResolvedValue([
      { groupName: '产线 A', id: 'g-1' },
      { groupName: '产线 B', id: 'g-2', parentId: 'g-1' },
      { groupName: '设备组 C', id: 'g-3', parentId: 'g-2' },
      { groupName: '孤儿 D', id: 'g-4', parentId: 'g-404' },
    ]);

    await mountPage();
    const rows = await runQuery();

    expect(rows).toEqual([
      { groupName: '产线 A', id: 'g-1' },
      {
        groupName: '产线 B',
        id: 'g-2',
        parentId: 'g-1',
        parentIdName: '产线 A',
      },
      {
        groupName: '设备组 C',
        id: 'g-3',
        parentId: 'g-2',
        parentIdName: '产线 B',
      },
      { groupName: '孤儿 D', id: 'g-4', parentId: 'g-404' },
    ]);
    // 名称映射来自同一次列表结果，不允许逐行再发请求
    expect(mockApi.getGroupList).toHaveBeenCalledTimes(1);
  });
});

describe('groups/index.vue 交互', () => {
  it('行内删除（确认后）⇒ 调 deleteGroup(id) 并刷新列表；成功提示', async () => {
    mockApi.getGroupList.mockResolvedValue([ROW]);
    mockApi.deleteGroup.mockResolvedValue(null);
    gridStub.renderAction = true;
    gridStub.row = ROW;

    const container = await mountPage();
    const del = container.querySelector(
      'button[data-action="删除"]',
    ) as HTMLButtonElement;
    expect(del, '未渲染出行内「删除」动作').toBeTruthy();

    del.click();
    await nextTick();
    await Promise.resolve();

    expect(mockApi.deleteGroup).toHaveBeenCalledTimes(1);
    expect(mockApi.deleteGroup).toHaveBeenCalledWith('g-1');
    // 成功后必须刷新（否则删掉的行还在屏幕上）
    expect(gridApiMock.query).toHaveBeenCalledTimes(1);
  });

  it('删除失败 ⇒ **不得**刷新列表（不能把失败当成功）', async () => {
    mockApi.getGroupList.mockResolvedValue([ROW]);
    mockApi.deleteGroup.mockRejectedValue(bizFailure(50_001, '删除失败'));
    gridStub.renderAction = true;
    gridStub.row = ROW;

    const container = await mountPage();
    (
      container.querySelector('button[data-action="删除"]') as HTMLButtonElement
    ).click();
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockApi.deleteGroup).toHaveBeenCalledWith('g-1');
    expect(gridApiMock.query).not.toHaveBeenCalled();
  });

  it('「编辑」打开表单抽屉并带上当前行；「成员管理」打开成员抽屉', async () => {
    mockApi.getGroupList.mockResolvedValue([ROW]);
    gridStub.renderAction = true;
    gridStub.row = ROW;

    const container = await mountPage();
    (
      container.querySelector('button[data-action="修改"]') as HTMLButtonElement
    ).click();
    await nextTick();
    expect(drawerApis[0]?.setData).toHaveBeenCalledWith(ROW);
    expect(drawerApis[0]?.open).toHaveBeenCalled();

    (
      container.querySelector(
        'button[data-action="成员管理"]',
      ) as HTMLButtonElement
    ).click();
    await nextTick();
    expect(drawerApis[1]?.setData).toHaveBeenCalledWith(ROW);
    expect(drawerApis[1]?.open).toHaveBeenCalled();
  });

  it('工具栏「新增」打开表单抽屉且 setData(null)（新增语义）', async () => {
    mockApi.getGroupList.mockResolvedValue([]);

    const container = await mountPage();
    const create = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('新增'),
    ) as HTMLButtonElement | undefined;
    expect(create, '未渲染出「新增」按钮').toBeTruthy();

    create?.click();
    await nextTick();
    expect(drawerApis[0]?.setData).toHaveBeenCalledWith(null);
    expect(drawerApis[0]?.open).toHaveBeenCalled();
  });
});

describe('groups/data.ts 列与表单 schema', () => {
  it('「上级分组」列渲染 parentIdName；根分组显示「根分组」，无法解析显示 `-`', async () => {
    const { useColumns } = await import('./data');
    const columns = useColumns() as any[];
    const parentColumn = columns.find((item) => item.field === 'parentIdName');
    expect(parentColumn?.title).toBe('上级分组');

    expect(
      parentColumn?.formatter({
        row: {
          groupName: '产线 B',
          id: 'g-2',
          parentId: 'g-1',
          parentIdName: '产线 A',
        },
      }),
    ).toBe('产线 A');
    expect(
      parentColumn?.formatter({ row: { groupName: '产线 A', id: 'g-1' } }),
    ).toBe('根分组');
    expect(
      parentColumn?.formatter({
        row: { groupName: '孤儿 D', id: 'g-4', parentId: 'g-404' },
      }),
    ).toBe('-');
  });

  it('表单 schema 含 parentId ApiTreeSelect：allowClear/help，api 按最新 rowId 排除当前行', async () => {
    const { useFormSchema } = await import('./data');
    const rowId = ref('g-1');
    const schema = useFormSchema(rowId);
    const parentField = schema.find((item) => item.fieldName === 'parentId');

    expect(parentField?.component).toBe('ApiTreeSelect');
    // schema 的 componentProps 是按 component 判别的联合类型；测试只断言运行时契约，收窄为 any
    const parentProps = parentField?.componentProps as any;
    expect(parentProps?.allowClear).toBe(true);
    expect(parentProps?.alwaysLoad).toBe(true);
    expect(parentProps?.visibleEvent).toBe('onDropdownVisibleChange');
    expect(parentField?.help).toBe('留空 = 根分组（顶级分组）');

    rowId.value = 'g-2';
    mockApi.getGroupTreeOptions.mockResolvedValue([]);
    await parentProps?.api();
    expect(mockApi.getGroupTreeOptions).toHaveBeenCalledWith('g-2');
  });
});
