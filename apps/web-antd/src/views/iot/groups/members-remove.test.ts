import { createApp, defineComponent, h, nextTick } from 'vue';

import { message } from 'ant-design-vue';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import Members from './modules/members.vue';

/**
 * 分组成员批量移除（task-29）行为用例。
 *
 * 桩掉抽屉/弹层/表单容器，让真实 `members.vue` 挂载（成员表用真实 a-table 行选择）：
 * 通过 Table 的 `rowSelection.onChange` 模拟勾选，通过 Popconfirm 的 confirm 回调模拟用户确认，
 * 覆盖：权限入口、未选禁用、请求参数、成功计数/刷新/清选、失败原样提示且不清选、重复确认防重。
 */

const { accessState, drawerState, formApi, modalState, mockApi } = vi.hoisted(
  () => ({
    accessState: { allowed: true, codes: [] as string[][] },
    drawerState: { api: null as any, options: null as any },
    formApi: {
      getValues: vi.fn(),
      reset: vi.fn(),
      validate: vi.fn(),
    },
    modalState: { api: null as any, options: null as any },
    mockApi: {
      addGroupMember: vi.fn(),
      addGroupMembersBatch: vi.fn(),
      getDeviceOptions: vi.fn(),
      getGroupMembers: vi.fn(),
      removeGroupMember: vi.fn(),
      removeGroupMembersBatch: vi.fn(),
    },
  }),
);

vi.mock('@vben/access', () => ({
  useAccess: () => ({
    hasAccessByCodes: (codes: string[]) => {
      accessState.codes.push(codes);
      return accessState.allowed;
    },
  }),
}));

vi.mock('@vben/common-ui', () => ({
  useVbenDrawer: (options: any) => {
    drawerState.options = options;
    const api: any = {
      close: vi.fn(),
      getData: () => ({ groupName: '产线 A', id: 'g-1' }),
      setState: vi.fn(),
    };
    drawerState.api = api;
    return [
      defineComponent({
        name: 'DrawerStub',
        setup:
          (_props, { slots }) =>
          () =>
            h('div', slots.default?.()),
      }),
      api,
    ];
  },
  useVbenModal: (options: any) => {
    modalState.options = options;
    const api: any = {
      close: vi.fn(),
      lock: vi.fn(),
      open: vi.fn(),
      setState: vi.fn(),
      unlock: vi.fn(),
    };
    modalState.api = api;
    return [
      defineComponent({
        name: 'ModalStub',
        setup:
          (_props, { slots }) =>
          () =>
            h('div', slots.default?.()),
      }),
      api,
    ];
  },
}));

vi.mock('#/adapter/form', () => ({
  useVbenForm: () => [
    defineComponent({
      name: 'BatchFormStub',
      setup: () => () => null,
    }),
    formApi,
  ],
}));

vi.mock('#/api/iot', () => ({
  addGroupMember: mockApi.addGroupMember,
  addGroupMembersBatch: mockApi.addGroupMembersBatch,
  getDeviceOptions: mockApi.getDeviceOptions,
  getGroupMembers: mockApi.getGroupMembers,
  removeGroupMember: mockApi.removeGroupMember,
  removeGroupMembersBatch: mockApi.removeGroupMembersBatch,
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

function bizFailure(code: number, messageText: string) {
  return Object.assign(new Error(messageText), {
    response: { data: { code, data: null, message: messageText } },
  });
}

let mounted: undefined | { app: { unmount: () => void } };

async function mountMembers() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(Members as never) });
  app.mount(container);
  mounted = { app };
  await nextTick();
  return container;
}

async function flush() {
  // 等待 loadMembers/请求回调/antd Table 重渲染
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

async function openMembersDrawer() {
  await drawerState.options?.onOpenChange?.(true);
  await flush();
}

function removeButton(container: HTMLElement) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('批量移除'),
  ) as HTMLButtonElement | undefined;
}

/** 沿 Vue 内部组件链找 Table 实例并取其 rowSelection 配置（驱动真实行选择）。 */
function findRowSelection(container: HTMLElement) {
  const anchor =
    container.querySelector('.ant-table') ?? container.firstElementChild;
  let node: any = (anchor as any)?.__vueParentComponent;
  while (node) {
    const rowSelection =
      node.props?.rowSelection ?? node.vnode?.props?.rowSelection;
    if (rowSelection !== undefined) {
      return rowSelection;
    }
    node = node.parent;
  }
  return null;
}

/** 沿 Vue 内部组件链找指定名字的祖先组件（Popconfirm 浮层 DOM 不可靠，直接调回调）。 */
function findAncestorComponent(el: Element, name: string): any | null {
  let node: any = (el as any).__vueParentComponent;
  while (node) {
    const typeName = node.type?.name ?? node.type?.__name ?? '';
    if (typeName.includes(name)) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

function componentProp(node: any, name: string) {
  return node?.props?.[name] ?? node?.vnode?.props?.[name];
}

function triggerConfirm(node: any) {
  const handler = componentProp(node, 'onConfirm');
  if (typeof handler === 'function') {
    handler();
    return;
  }
  node?.emit?.('confirm');
}

async function selectRows(container: HTMLElement, ids = ['m-1', 'm-2']) {
  const rowSelection: any = findRowSelection(container);
  expect(rowSelection, '成员表没有接上 row-selection').toBeTruthy();
  rowSelection.onChange(ids);
  await flush();
}

function batchRemovePopconfirm(container: HTMLElement) {
  const button = removeButton(container);
  expect(button, '未渲染出「批量移除」按钮').toBeTruthy();
  const popconfirm = findAncestorComponent(button as Element, 'Popconfirm');
  expect(popconfirm, '「批量移除」必须由 Popconfirm 包裹').toBeTruthy();
  return popconfirm;
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  formApi.getValues.mockReset();
  formApi.reset.mockReset();
  formApi.validate.mockReset();
  formApi.validate.mockResolvedValue({ valid: true });
  formApi.getValues.mockResolvedValue({ deviceIds: [] });

  accessState.allowed = true;
  accessState.codes.length = 0;
  drawerState.api = null;
  drawerState.options = null;
  modalState.api = null;
  modalState.options = null;

  mockApi.getGroupMembers.mockResolvedValue([
    { deviceName: '设备一', id: 'm-1' },
    { deviceName: '设备二', id: 'm-2' },
    { deviceName: '设备三', id: 'm-3' },
  ]);
  mockApi.getDeviceOptions.mockResolvedValue([]);
  mockApi.addGroupMember.mockResolvedValue(1);
  mockApi.removeGroupMember.mockResolvedValue(null);

  vi.spyOn(message, 'success').mockImplementation(() => undefined as never);
  vi.spyOn(message, 'error').mockImplementation(() => undefined as never);
  vi.spyOn(message, 'warning').mockImplementation(() => undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('groups/modules/members.vue 批量移除', () => {
  it('★ 未选禁用；勾选后确认才发请求，参数 = 成员行主键 id 列表', async () => {
    mockApi.removeGroupMembersBatch.mockResolvedValue(2);

    const container = await mountMembers();
    await openMembersDrawer();

    const button = removeButton(container);
    expect(button?.disabled).toBe(true);
    expect(mockApi.removeGroupMembersBatch).not.toHaveBeenCalled();

    await selectRows(container, ['m-1', 'm-3']);
    expect(removeButton(container)?.disabled).toBe(false);

    const popconfirm = batchRemovePopconfirm(container);
    // 未确认不得发请求
    expect(mockApi.removeGroupMembersBatch).not.toHaveBeenCalled();
    expect(String(componentProp(popconfirm, 'title') ?? '')).toContain(
      '确认移除选中的 2 台设备',
    );

    triggerConfirm(popconfirm);
    await flush();

    expect(mockApi.removeGroupMembersBatch).toHaveBeenCalledTimes(1);
    expect(mockApi.removeGroupMembersBatch).toHaveBeenCalledWith('g-1', [
      'm-1',
      'm-3',
    ]);
  });

  it('★ 成功：提示移除数量、清空勾选、刷新成员列表', async () => {
    mockApi.removeGroupMembersBatch.mockResolvedValue(2);

    const container = await mountMembers();
    await openMembersDrawer();
    const before = mockApi.getGroupMembers.mock.calls.length;
    await selectRows(container);

    triggerConfirm(batchRemovePopconfirm(container));
    await flush();

    expect(vi.mocked(message.success).mock.calls[0]?.[0]).toContain(
      '已移除 2 台设备',
    );
    // 初始加载 1 次 + 成功后刷新 1 次
    expect(mockApi.getGroupMembers.mock.calls.length).toBe(before + 1);
    // 清选后按钮回禁用
    expect(removeButton(container)?.disabled).toBe(true);
  });

  it('★ 失败：原样展示后端 message，不清选、不刷新', async () => {
    const backendMessage = '成员不存在或不属于该分组：m-9';
    mockApi.removeGroupMembersBatch.mockRejectedValue(
      bizFailure(50_001, backendMessage),
    );

    const container = await mountMembers();
    await openMembersDrawer();
    const before = mockApi.getGroupMembers.mock.calls.length;
    await selectRows(container);

    triggerConfirm(batchRemovePopconfirm(container));
    await flush();

    expect(vi.mocked(message.error).mock.calls[0]?.[0]).toBe(backendMessage);
    expect(vi.mocked(message.success)).not.toHaveBeenCalled();
    expect(mockApi.getGroupMembers.mock.calls.length).toBe(before);
    // 失败保留勾选，用户可修正重试
    expect(removeButton(container)?.disabled).toBe(false);
  });

  it('★ 提交中重复确认只发一次请求（防重复）', async () => {
    let resolveRemove!: (value: number) => void;
    mockApi.removeGroupMembersBatch.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveRemove = resolve;
        }),
    );

    const container = await mountMembers();
    await openMembersDrawer();
    await selectRows(container);
    const popconfirm = batchRemovePopconfirm(container);

    triggerConfirm(popconfirm);
    await flush();
    expect(mockApi.removeGroupMembersBatch).toHaveBeenCalledTimes(1);

    // 请求在途时再次确认（真实 UI 按钮已 disabled，仍锁一层程序性防重）
    triggerConfirm(popconfirm);
    await flush();
    expect(mockApi.removeGroupMembersBatch).toHaveBeenCalledTimes(1);

    resolveRemove(2);
    await flush();
    expect(vi.mocked(message.success).mock.calls[0]?.[0]).toContain(
      '已移除 2 台设备',
    );
  });

  it('无 iot:group:update 权限：不显示批量移除入口，也没有选择列', async () => {
    accessState.allowed = false;

    const container = await mountMembers();
    await openMembersDrawer();

    expect(container.textContent).not.toContain('批量移除');
    expect(
      container.querySelector(
        '.ant-table-selection-col, .ant-table-selection-column',
      ),
    ).toBeNull();
    expect(mockApi.removeGroupMembersBatch).not.toHaveBeenCalled();
  });
});
