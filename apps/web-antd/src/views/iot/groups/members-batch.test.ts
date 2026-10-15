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
 * 分组成员批量加入（task-22）行为用例。
 *
 * 用桩替换 `useVbenDrawer` / `useVbenModal` / `useVbenForm`，直接驱动真实的
 * `members.vue` 提交逻辑，覆盖：请求参数、成功计数提示、失败原样提示、成功后刷新、
 * 提交中重复触发只发一次请求、表单 schema 与权限入口。
 */

const { accessState, drawerState, formApi, formOptions, modalState, mockApi } =
  vi.hoisted(() => ({
    accessState: { allowed: true, codes: [] as string[][] },
    drawerState: { api: null as any, options: null as any },
    formApi: {
      getValues: vi.fn(),
      reset: vi.fn(),
      validate: vi.fn(),
    },
    formOptions: { current: null as any },
    modalState: { api: null as any, options: null as any },
    mockApi: {
      addGroupMember: vi.fn(),
      addGroupMembersBatch: vi.fn(),
      getDeviceOptions: vi.fn(),
      getGroupMembers: vi.fn(),
      removeGroupMember: vi.fn(),
    },
  }));

vi.mock('@vben/access', () => ({
  useAccess: () => ({
    hasAccessByCodes: (codes: string[]) => {
      accessState.codes.push(codes);
      return accessState.allowed;
    },
  }),
}));

vi.mock('@vben/common-ui', () => ({
  // 内容组件需要真实挂载以渲染工具栏/权限按钮
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
  useVbenForm: (options: any) => {
    formOptions.current = options;
    return [
      defineComponent({
        name: 'BatchFormStub',
        setup: () => () => null,
      }),
      formApi,
    ];
  },
}));

vi.mock('#/api/iot', () => ({
  addGroupMember: mockApi.addGroupMember,
  addGroupMembersBatch: mockApi.addGroupMembersBatch,
  getDeviceOptions: mockApi.getDeviceOptions,
  getGroupMembers: mockApi.getGroupMembers,
  removeGroupMember: mockApi.removeGroupMember,
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
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function openMembersDrawer() {
  await drawerState.options?.onOpenChange?.(true);
  await flush();
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  formApi.getValues.mockReset();
  formApi.reset.mockReset();
  formApi.validate.mockReset();
  formApi.validate.mockResolvedValue({ valid: true });
  formApi.getValues.mockResolvedValue({ deviceIds: ['d-1', 'd-2'] });

  accessState.allowed = true;
  accessState.codes.length = 0;
  drawerState.api = null;
  drawerState.options = null;
  modalState.api = null;
  modalState.options = null;
  formOptions.current = null;

  mockApi.getGroupMembers.mockResolvedValue([]);
  mockApi.getDeviceOptions.mockResolvedValue([
    { deviceCode: 'DEV-1', deviceName: '设备一', id: 'd-1' },
    { deviceCode: 'DEV-2', deviceName: '设备二', id: 'd-2' },
  ]);
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

describe('groups/modules/members.vue 批量加入', () => {
  it('★ 提交请求参数正确；成功提示新增/已存在数量并刷新成员列表', async () => {
    mockApi.addGroupMembersBatch.mockResolvedValue({ added: 1, skipped: 1 });

    await mountMembers();
    await openMembersDrawer();

    // 权限码正确 + 批量入口可见
    expect(accessState.codes.flat()).toContain('iot:group:update');
    expect(document.body.textContent).toContain('批量加入');

    await modalState.options.onConfirm();
    await flush();

    expect(mockApi.addGroupMembersBatch).toHaveBeenCalledTimes(1);
    expect(mockApi.addGroupMembersBatch).toHaveBeenCalledWith('g-1', [
      'd-1',
      'd-2',
    ]);
    expect(vi.mocked(message.success)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(message.success).mock.calls[0]?.[0]).toContain(
      '新增 1 台，已存在 1 台',
    );
    // 初始加载 1 次 + 成功后刷新 1 次
    expect(mockApi.getGroupMembers).toHaveBeenCalledTimes(2);
    expect(modalState.api.close).toHaveBeenCalledTimes(1);
    expect(modalState.api.lock).toHaveBeenCalledTimes(1);
  });

  it('★ 提交失败：原样展示后端 message，不刷新列表、不关闭弹层', async () => {
    const backendMessage = '设备不存在：d-9';
    mockApi.addGroupMembersBatch.mockRejectedValue(
      bizFailure(50_001, backendMessage),
    );

    await mountMembers();
    await openMembersDrawer();
    const before = mockApi.getGroupMembers.mock.calls.length;

    await modalState.options.onConfirm();
    await flush();

    expect(vi.mocked(message.error).mock.calls[0]?.[0]).toBe(backendMessage);
    expect(vi.mocked(message.success)).not.toHaveBeenCalled();
    // 失败不得当成功刷新屏幕
    expect(mockApi.getGroupMembers.mock.calls.length).toBe(before);
    expect(modalState.api.close).not.toHaveBeenCalled();
    // 失败后必须解锁，允许用户修正重试
    expect(modalState.api.unlock).toHaveBeenCalled();
  });

  it('★ 提交中重复触发只发一次请求（防重复提交）', async () => {
    let resolveBatch!: (value: { added: number; skipped: number }) => void;
    mockApi.addGroupMembersBatch.mockImplementation(
      () =>
        new Promise<{ added: number; skipped: number }>((resolve) => {
          resolveBatch = resolve;
        }),
    );

    await mountMembers();
    await openMembersDrawer();

    const first = modalState.options.onConfirm();
    await flush();
    expect(mockApi.addGroupMembersBatch).toHaveBeenCalledTimes(1);

    // 请求仍在途时再次触发（真实 UI 的确认按钮此时被 lock 禁用，仍锁一层程序性防重）
    const second = modalState.options.onConfirm();
    await flush();
    expect(mockApi.addGroupMembersBatch).toHaveBeenCalledTimes(1);
    expect(formApi.getValues).toHaveBeenCalledTimes(1);

    resolveBatch({ added: 2, skipped: 0 });
    await first;
    await second;

    expect(vi.mocked(message.success).mock.calls[0]?.[0]).toContain(
      '新增 2 台',
    );
  });

  it('批量表单 schema：ApiSelect 多选、getDeviceOptions 直连、label/value 字段与 maxTagCount', async () => {
    await mountMembers();

    const schema = formOptions.current?.schema as any[];
    expect(schema).toHaveLength(1);
    const field = schema[0];
    expect(field?.component).toBe('ApiSelect');
    expect(field?.fieldName).toBe('deviceIds');
    expect(field?.componentProps?.api).toBe(mockApi.getDeviceOptions);
    expect(field?.componentProps?.labelField).toBe('deviceName');
    expect(field?.componentProps?.valueField).toBe('id');
    expect(field?.componentProps?.mode).toBe('multiple');
    expect(field?.componentProps?.showSearch).toBe(true);
    expect(field?.componentProps?.maxTagCount).toBe('responsive');
    expect(field?.componentProps?.allowClear).toBe(true);
  });

  it('无 iot:group:update 权限时不显示批量加入入口', async () => {
    accessState.allowed = false;

    await mountMembers();

    expect(document.body.textContent).not.toContain('批量加入');
  });
});
