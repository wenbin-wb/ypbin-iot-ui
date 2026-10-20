import { createApp, defineComponent, h } from 'vue';

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

import ThingModelForm from './thingmodel-form.vue';

/**
 * 物模型编辑器（`thingmodel-form.vue`）的**假成功**回归用例（P0-2）。
 *
 * 事故：四个 `submitXxx` 在 vben 表单 `validate()` 失败时静默 `return`，
 * 而 `onConfirm` 无条件 `message.success` + `modalApi.close()` ——
 * 用户填了非法 TSL（标识重复、必填为空等），界面报「操作成功」并关窗，
 * 服务端根本没收到请求。用户以为改完了，物模型仍是旧的。
 *
 * 这里把表单/弹窗外壳替换为**可控桩**，锁住三条契约：
 *   ① 校验失败 ⇒ 不调后端、不提示成功、不关窗（弹窗保持打开，输入还在）；
 *   ② 校验通过 ⇒ 调后端 + 提示成功 + 关窗 + 通知宿主刷新；
 *   ③ 后端失败 ⇒ 只抛出（由全局拦截器提示），不得提示成功/关窗。
 *
 * 用真实 vue-i18n（不 mock `#/locales`）：文案编译不过会让用例一起红。
 */

const { apiMock, formApis, modalApi, modalCalls } = vi.hoisted(() => {
  const modalApi: any = {
    close: vi.fn(),
    getData: vi.fn(),
    open: vi.fn(),
    setState: vi.fn(),
  };
  modalApi.setData = vi.fn(() => modalApi);
  return {
    apiMock: {
      createCommand: vi.fn(),
      createEvent: vi.fn(),
      createProperty: vi.fn(),
      createService: vi.fn(),
      updateCommand: vi.fn(),
      updateEvent: vi.fn(),
      updateProperty: vi.fn(),
      updateService: vi.fn(),
    },
    /** useVbenForm 调用顺序固定：0=服务 1=属性 2=命令 3=事件（与组件内声明顺序一致）。 */
    formApis: [] as any[],
    modalApi,
    modalCalls: [] as any[],
  };
});

vi.mock('#/api/iot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/api/iot')>();
  return { ...actual, ...apiMock };
});

vi.mock('#/adapter/form', () => ({
  useVbenForm: vi.fn(() => {
    const api = {
      getValues: vi.fn(async () => ({})),
      reset: vi.fn(),
      setValues: vi.fn(async () => {}),
      validate: vi.fn(async () => ({ valid: true })),
    };
    formApis.push(api);
    return [
      defineComponent({ name: 'FormStub', setup: () => () => null }),
      api,
    ];
  }),
}));

vi.mock('@vben/common-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vben/common-ui')>();
  const ModalStub = defineComponent({
    name: 'ModalStub',
    setup:
      (_props, { slots }) =>
      () =>
        h('div', { class: 'modal-stub' }, slots.default?.()),
  });
  return {
    ...actual,
    useVbenModal: (options: Record<string, unknown>) => {
      modalCalls.push(options);
      return [ModalStub, modalApi];
    },
  };
});

const SUCCESS = vi.spyOn(message, 'success').mockImplementation(
  // antd 的 message.success 返回关闭函数；用例只关心是否被调用，返回空实现即可
  () => undefined as never,
);

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

let mounted: undefined | { app: { unmount: () => void } };

function mountForm() {
  const container = document.createElement('div');
  document.body.append(container);
  const reload = vi.fn();
  const app = createApp({
    render: () => h(ThingModelForm as never, { onReload: reload }),
  });
  app.mount(container);
  mounted = { app };
  return { container, reload };
}

/** 让组件走一遍 open（`onOpenChange(true)`），返回编辑器选项（含 onConfirm）。 */
async function openEditor(data: Record<string, unknown>) {
  modalApi.getData.mockReturnValue(data);
  const options = modalCalls.find(
    (item) => typeof item?.onOpenChange === 'function',
  );
  expect(options, 'useVbenModal(onOpenChange) 未被调用').toBeTruthy();
  // `expect(...).toBeTruthy()` 不会收窄类型；显式判空让 TS 与 lint 都满意
  if (!options) {
    throw new Error('useVbenModal(onOpenChange) 未被调用');
  }
  await options.onOpenChange(true);
  return options;
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  // 每次挂载都会重新调用 4 次 useVbenForm（默认 validate 通过/getValues 空值）⇒
  // 先清空上一次挂载留下的桩，用例内再按需覆盖具体表单的行为。
  formApis.length = 0;
  modalApi.close.mockReset();
  modalApi.setState.mockReset();
  modalApi.getData.mockReset();
  modalCalls.length = 0;
  SUCCESS.mockClear();
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

const KINDS = [
  { create: 'createService', formIndex: 0, kind: 'service' },
  { create: 'createProperty', formIndex: 1, kind: 'property' },
  { create: 'createCommand', formIndex: 2, kind: 'command' },
  { create: 'createEvent', formIndex: 3, kind: 'event' },
] as const;

describe('thingmodel-form.vue 校验失败 ⇒ 不假成功（P0-2）', () => {
  for (const item of KINDS) {
    it(`${item.kind}：校验失败 ⇒ 不发请求、不提示成功、不关窗`, async () => {
      mountForm();
      formApis[item.formIndex].validate.mockResolvedValue({ valid: false });
      const options = await openEditor({
        kind: item.kind,
        productId: 'p-1',
        row: null,
        serviceId: 's-1',
      });

      await options.onConfirm();

      // ① 请求根本没有发出（校验没过就不该打扰后端）
      expect(apiMock[item.create]).not.toHaveBeenCalled();
      // ② 不得提示「操作成功」
      expect(SUCCESS).not.toHaveBeenCalled();
      // ③ 弹窗必须保持打开（用户输入还在，可以改完重试）
      expect(modalApi.close).not.toHaveBeenCalled();
      // 校验期间只应切换 confirmLoading，不应关窗
      expect(modalApi.setState).toHaveBeenCalledWith({ confirmLoading: true });
      expect(modalApi.setState).toHaveBeenCalledWith({
        confirmLoading: false,
      });
    });
  }

  it('校验失败后修正再提交：第二次通过才提示成功并关窗（弹窗未被第一次点击关掉）', async () => {
    const { reload } = mountForm();
    const options = await openEditor({
      kind: 'property',
      productId: 'p-1',
      row: null,
      serviceId: 's-1',
    });

    formApis[1].validate.mockResolvedValueOnce({ valid: false });
    await options.onConfirm();
    expect(modalApi.close).not.toHaveBeenCalled();
    expect(SUCCESS).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    formApis[1].validate.mockResolvedValueOnce({ valid: true });
    formApis[1].getValues.mockResolvedValue({
      accessMode: 'r',
      dataType: 'int',
      identifier: 'temperature',
      propertyName: '温度',
    });
    apiMock.createProperty.mockResolvedValue('pm-1');

    await options.onConfirm();

    expect(apiMock.createProperty).toHaveBeenCalledWith('p-1', 's-1', {
      accessMode: 'r',
      dataType: 'int',
      identifier: 'temperature',
      propertyName: '温度',
    });
    expect(SUCCESS).toHaveBeenCalledTimes(1);
    expect(modalApi.close).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('thingmodel-form.vue 成功 / 失败路径保持原语义', () => {
  it('校验通过（新增属性）⇒ 调后端、提示成功、关窗、通知宿主 reload', async () => {
    const { reload } = mountForm();
    const options = await openEditor({
      kind: 'property',
      productId: 'p-1',
      row: null,
      serviceId: 's-1',
    });
    formApis[1].getValues.mockResolvedValue({ identifier: 'temp' });
    apiMock.createProperty.mockResolvedValue('pm-1');

    await options.onConfirm();

    expect(apiMock.createProperty).toHaveBeenCalledWith('p-1', 's-1', {
      identifier: 'temp',
    });
    expect(SUCCESS).toHaveBeenCalledTimes(1);
    expect(modalApi.close).toHaveBeenCalledTimes(1);
    // emit('reload') 由宿主（产品详情）监听：宿主收到刷新通知，列表才会更新
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('校验通过（编辑命令）⇒ 走 update 而不是 create', async () => {
    mountForm();
    const options = await openEditor({
      kind: 'command',
      productId: 'p-1',
      row: { id: 'cmd-1' },
      serviceId: 's-1',
    });
    formApis[2].getValues.mockResolvedValue({ commandName: '重置' });
    apiMock.updateCommand.mockResolvedValue(null);

    await options.onConfirm();

    expect(apiMock.updateCommand).toHaveBeenCalledWith('p-1', 's-1', 'cmd-1', {
      commandName: '重置',
    });
    expect(apiMock.createCommand).not.toHaveBeenCalled();
    expect(SUCCESS).toHaveBeenCalledTimes(1);
    expect(modalApi.close).toHaveBeenCalledTimes(1);
  });

  it('后端失败 ⇒ 不提示成功、不关窗（失败提示交给全局拦截器）', async () => {
    const { reload } = mountForm();
    const options = await openEditor({
      kind: 'service',
      productId: 'p-1',
      row: null,
      serviceId: undefined,
    });
    apiMock.createService.mockRejectedValue(
      new Error('后端拒绝：服务标识重复'),
    );

    await options.onConfirm();

    expect(apiMock.createService).toHaveBeenCalledTimes(1);
    expect(SUCCESS).not.toHaveBeenCalled();
    expect(modalApi.close).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
