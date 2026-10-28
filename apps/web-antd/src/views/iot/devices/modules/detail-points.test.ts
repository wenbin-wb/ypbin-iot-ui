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

import DetailPoints from './detail-points.vue';

/**
 * 「属性与点位」组件级挂载用例（批次 5 拆分前的行为安全网）。
 *
 * 为什么先补这一层：拆分前 `detail-points.vue` **零组件级用例**（只有 `point-mapping-state.ts`
 * 的纯函数用例），任何模板/状态搬迁都是裸拆。这里钉住四类用户可见行为：
 * 1. 表格渲染（属性↔点位连接表 + 原始表 + 孤儿映射表 + 表格自身横向滚动）；
 * 2. 新增/编辑弹窗打开与**提交 payload**（含寄存器形态联动的「界面所见 = payload 所发」）；
 * 3. 删除必须二次确认（Popconfirm 未确认前不发请求）；
 * 4. 点位/物模型两个数据源失败时展示原样后端 message 的错误态，而不是空白。
 *
 * mock 口径：只替换本组件真正调用的 6 个 API，其余导出保留真实实现（画布/展示函数仍走真代码）；
 * i18n 用真实语言包（键缺失/文案编译错误要能被挂载用例抓到）。
 */

const { accessState, apiMock } = vi.hoisted(() => ({
  accessState: { accessCodes: ['*:*:*'], accessToken: 'test-token' },
  apiMock: {
    createDevicePoint: vi.fn(),
    deleteDevicePoint: vi.fn(),
    getDevicePoints: vi.fn(),
    listProperties: vi.fn(),
    listServices: vi.fn(),
    updateDevicePoint: vi.fn(),
  },
}));

vi.mock('#/api/iot', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    createDevicePoint: (...args: unknown[]) =>
      apiMock.createDevicePoint(...args),
    deleteDevicePoint: (...args: unknown[]) =>
      apiMock.deleteDevicePoint(...args),
    getDevicePoints: (...args: unknown[]) => apiMock.getDevicePoints(...args),
    listProperties: (...args: unknown[]) => apiMock.listProperties(...args),
    listServices: (...args: unknown[]) => apiMock.listServices(...args),
    updateDevicePoint: (...args: unknown[]) =>
      apiMock.updateDevicePoint(...args),
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

const DEVICE_ID = '9001';
const PRODUCT_ID = '9100001';

/** 物模型：温度已映射、湿度未映射；另有属性被删过的历史点位（孤儿）。 */
function setupHappyPath() {
  apiMock.listServices.mockResolvedValue([
    { id: 's1', name: '默认服务', serviceId: 'svc-1' },
  ]);
  apiMock.listProperties.mockResolvedValue([
    {
      accessMode: 'R',
      dataType: 'DOUBLE',
      id: 'p1',
      identifier: 'temperature',
      required: true,
      unit: '℃',
    },
    {
      accessMode: 'RW',
      dataType: 'DOUBLE',
      id: 'p2',
      identifier: 'humidity',
      unit: '%',
    },
  ]);
  apiMock.getDevicePoints.mockResolvedValue([
    {
      addressType: 'holding',
      deviceId: DEVICE_ID,
      enabled: true,
      id: 'pt1',
      pollIntervalMs: 5000,
      propertyId: 'p1',
      rawAddress: '40001',
      refType: 'property',
      registerFormat: 'int',
      rw: 'R',
      scaleFactor: '0.1',
      signed: false,
      wordCount: 1,
    },
    {
      addressType: 'holding',
      deviceId: DEVICE_ID,
      enabled: false,
      id: 'pt9',
      propertyId: 'gone-property',
      rawAddress: '40099',
      refType: 'property',
      registerFormat: 'int',
      rw: 'R',
      wordCount: 1,
    },
  ]);
  apiMock.createDevicePoint.mockResolvedValue({});
  apiMock.updateDevicePoint.mockResolvedValue({});
  apiMock.deleteDevicePoint.mockResolvedValue({});
}

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  accessState.accessCodes = ['*:*:*'];
  setupHappyPath();
});

let mounted: undefined | { app: { unmount: () => void } };

afterEach(async () => {
  mounted?.app.unmount();
  mounted = undefined;
  // antd Modal 的离场/入场动画由 rc-motion 用 setTimeout 驱动（默认 ~200ms）。
  // 若测试结束时动画仍在飞，回调会在 happy-dom 环境销毁后访问 `window`，
  // 抛 `ReferenceError: window is not defined` ⇒ Vitest 记为 unhandled error（用例全绿但 CI 红）。
  // 等动画定时器跑完再清理 DOM，把悬空回调消化在本文件内（与 openApiKeys/index.test.ts 同一修法）。
  await new Promise((resolve) => setTimeout(resolve, 300));
  document.body.innerHTML = '';
});

async function flush(times = 24) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
  await nextTick();
}

/** 挂载真实组件（单台设备 + 产品；`productId: undefined` 用于「未绑定产品」形态）。 */
async function mountPoints(
  options: {
    onOpenSeries?: (propertyId?: string) => void;
    productId?: string;
  } = {},
) {
  const onOpenSeries = options.onOpenSeries ?? vi.fn();
  const productId = 'productId' in options ? options.productId : PRODUCT_ID;
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({
    render: () =>
      h(DetailPoints as never, {
        deviceId: DEVICE_ID,
        onOpenSeries,
        productId,
      }),
  });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await flush();
  return { container, onOpenSeries };
}

function byTestId<T extends HTMLElement>(
  root: ParentNode,
  id: string,
): null | T {
  return root.querySelector<T>(`[data-testid="${id}"]`);
}

/** 给 antd Input 写入值并触发 v-model 更新（真实输入事件路径）。 */
function setInputValue(root: ParentNode, id: string, value: string) {
  const input = byTestId<HTMLInputElement>(root, id);
  expect(input, `未找到输入框 ${id}`).toBeTruthy();
  if (input) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** 点开 antd Select 并选中包含指定文案的选项（下拉浮层挂 body）。 */
async function pickSelectOption(
  root: ParentNode,
  id: string,
  optionText: string,
) {
  const select = byTestId<HTMLElement>(root, id);
  expect(select, `未找到下拉 ${id}`).toBeTruthy();
  select
    ?.querySelector('.ant-select-selector')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await flush();
  const option = [
    ...document.querySelectorAll<HTMLElement>('.ant-select-item-option'),
  ]
    .filter(
      (element) =>
        !element.classList.contains('ant-select-item-option-disabled'),
    )
    .find((element) => element.textContent?.includes(optionText));
  expect(option, `下拉 ${id} 中没有选项「${optionText}」`).toBeTruthy();
  option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flush();
}

/** 点 Modal 的「确定」按钮（未禁用）。 */
async function confirmModal() {
  const okButton = document.querySelector<HTMLButtonElement>(
    '.ant-modal-footer .ant-btn-primary',
  );
  expect(okButton, '未找到 Modal 确定按钮').toBeTruthy();
  expect(okButton?.disabled, '表单未通过校验，确定按钮仍是禁用态').toBe(false);
  okButton?.click();
  await flush();
}

/** 点 Popconfirm 的「确定」按钮（未确认前不得发请求）。 */
async function confirmPopconfirm() {
  const popup = [
    ...document.querySelectorAll<HTMLElement>('.ant-popover'),
  ].find((element) => !element.classList.contains('ant-popover-hidden'));
  expect(popup, '没有出现删除二次确认浮层').toBeTruthy();
  popup?.querySelector<HTMLButtonElement>('.ant-btn-primary')?.click();
  await flush();
}

describe('属性与点位：表格渲染（拆分安全网）', () => {
  it('★ 连接表/原始表/孤儿表三表齐全，未映射属性标橙，表格自身可横向滚动', async () => {
    const { container, onOpenSeries } = await mountPoints();

    const joinTable = byTestId<HTMLTableElement>(container, 'point-join-table');
    const rawTable = byTestId<HTMLTableElement>(container, 'point-raw-table');
    const orphanTable = byTestId<HTMLTableElement>(
      container,
      'point-orphan-table',
    );
    expect(joinTable, '缺少属性↔点位连接表').toBeTruthy();
    expect(rawTable, '缺少原始映射表').toBeTruthy();
    expect(orphanTable, '缺少孤儿映射表').toBeTruthy();

    // 12 列表格必须由自身横向滚动承载（窄屏不压扁、不整页横滚）
    expect(joinTable?.className).toContain('min-w-[900px]');
    expect(joinTable?.closest('.overflow-x-auto')).toBeTruthy();
    expect(rawTable?.className).toContain('min-w-[720px]');
    expect(rawTable?.closest('.overflow-x-auto')).toBeTruthy();

    // 连接表 2 行：p1 已映射（显示地址 40001/on），p2 未映射（标橙）
    const joinRows = [...(joinTable?.querySelectorAll('tbody tr') ?? [])];
    expect(joinRows).toHaveLength(2);
    expect(joinRows[0]?.textContent).toContain('40001');
    expect(joinRows[0]?.textContent).toContain('temperature');
    expect(joinRows[1]?.textContent).toContain($t('page.iot.point.unmapped'));

    // 原始表 2 行（pt1 + 孤儿 pt9），孤儿区单列提示
    expect(rawTable?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(orphanTable?.textContent).toContain('gone-property');

    // 行内「历史曲线」入口必须把**属性标识**（不是主键）抛给宿主
    byTestId<HTMLButtonElement>(container, 'point-series-p1')?.click();
    expect(onOpenSeries).toHaveBeenCalledWith('temperature');
  });
});

describe('属性与点位：新增/编辑弹窗与提交 payload（拆分安全网）', () => {
  it('★ 从「未映射」行新增 ⇒ 弹窗预填属性 + 提交 createDevicePoint(deviceId, payload)', async () => {
    const { container } = await mountPoints();

    byTestId<HTMLButtonElement>(container, 'point-add-for-p2')?.click();
    await flush();
    expect(document.querySelector('.ant-modal')).toBeTruthy();

    // 预填属性主键（来自该行），协议内地址由用户填写
    setInputValue(document.body, 'form-raw-address', '40002');
    await flush();
    await confirmModal();

    expect(apiMock.createDevicePoint).toHaveBeenCalledTimes(1);
    const [deviceId, payload] = apiMock.createDevicePoint.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(deviceId).toBe(DEVICE_ID);
    expect(payload).toEqual(
      expect.objectContaining({
        addressType: 'holding',
        deviceId: DEVICE_ID,
        propertyId: 'p2',
        rawAddress: '40002',
        refType: 'property',
        rw: 'R',
      }),
    );
    // 提交成功后宿主重新拉列表（弹窗关闭由 antd v-model 负责）
    expect(apiMock.getDevicePoints).toHaveBeenCalledTimes(2);
  });

  it('★ 编辑已映射点位 ⇒ 预填值改后提交 updateDevicePoint(deviceId, id, payload)', async () => {
    const { container } = await mountPoints();

    byTestId<HTMLButtonElement>(container, 'point-edit-p1')?.click();
    await flush();
    expect(document.querySelector('.ant-modal')).toBeTruthy();

    setInputValue(document.body, 'form-scale-factor', '0.5');
    await flush();
    await confirmModal();

    expect(apiMock.updateDevicePoint).toHaveBeenCalledTimes(1);
    const [deviceId, id, payload] = apiMock.updateDevicePoint.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(deviceId).toBe(DEVICE_ID);
    expect(id).toBe('pt1');
    expect(payload).toEqual(
      expect.objectContaining({
        propertyId: 'p1',
        rawAddress: '40001',
        scaleFactor: '0.5',
      }),
    );
  });

  it('★ 寄存器形态联动：切 float ⇒ 宽度锁定 2、数值符号隐藏，payload 按 float 口径下发', async () => {
    const { container } = await mountPoints();

    byTestId<HTMLButtonElement>(container, 'point-add-for-p2')?.click();
    await flush();
    setInputValue(document.body, 'form-raw-address', '40002');
    await pickSelectOption(
      document.body,
      'form-register-format',
      '浮点（IEEE754',
    );

    // float 固定 2 个寄存器：宽度下拉置灰 + 对应提示出现；数值符号（仅 int）不再展示
    const wordCount = byTestId<HTMLElement>(document.body, 'form-word-count');
    expect(wordCount?.className).toContain('ant-select-disabled');
    expect(document.body.innerHTML).toContain(
      $t('page.iot.point.floatFixedTwoWords'),
    );
    // 数值符号（仅 int）整组不渲染：用锚点断言，避免被模板注释里的「数值符号」字样误伤
    expect(byTestId(document.body, 'form-signed-group')).toBeNull();

    await confirmModal();
    expect(apiMock.createDevicePoint).toHaveBeenCalledTimes(1);
    const [, payload] = apiMock.createDevicePoint.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(payload).toEqual(
      expect.objectContaining({
        propertyId: 'p2',
        registerFormat: 'float',
        wordCount: 2,
      }),
    );
    // float 后端要求 signed=false 且不下发
    expect('signed' in payload).toBe(false);
  });
});

describe('属性与点位：删除必须二次确认', () => {
  it('★ 点删除只弹确认，不直接发请求；确认后才 deleteDevicePoint(deviceId, id)', async () => {
    const { container } = await mountPoints();

    byTestId<HTMLButtonElement>(container, 'point-delete-joined-p1')?.click();
    await flush();
    expect(apiMock.deleteDevicePoint).not.toHaveBeenCalled();

    await confirmPopconfirm();
    expect(apiMock.deleteDevicePoint).toHaveBeenCalledTimes(1);
    expect(apiMock.deleteDevicePoint).toHaveBeenCalledWith(DEVICE_ID, 'pt1');
    // 删除成功后重新拉列表
    expect(apiMock.getDevicePoints).toHaveBeenCalledTimes(2);
  });
});

describe('属性与点位：数据源失败必须显示错误态', () => {
  it('★ 点位接口与物模型接口同时失败 ⇒ 两条原样错误可见，页面不空白', async () => {
    apiMock.getDevicePoints.mockRejectedValue(
      new Error('点位接口 500：映射表不可用'),
    );
    apiMock.listServices.mockRejectedValue(
      new Error('物模型接口 500：服务查询失败'),
    );

    const { container } = await mountPoints();
    const html = container.innerHTML;
    expect(html).toContain('点位接口 500：映射表不可用');
    expect(html).toContain('物模型接口 500：服务查询失败');
    // 页面骨架仍在（标题/原始映射区），不是整块空白
    expect(html).toContain($t('page.iot.point.rawList'));
    expect(html).toContain($t('page.iot.point.empty'));
  });

  it('★ 未绑定产品 ⇒ 只有「未配置产品」提示 + 原始映射表，不渲染属性连接表', async () => {
    const { container } = await mountPoints({ productId: undefined });

    expect(container.innerHTML).toContain($t('page.iot.device.noProductHint'));
    expect(byTestId(container, 'point-join-table')).toBeNull();
    // 设备级原始映射与孤儿映射与是否绑产品无关，必须仍然可见
    expect(byTestId(container, 'point-raw-table')).toBeTruthy();
    expect(container.innerHTML).toContain($t('page.iot.point.rawList'));
    // 没有产品时无从加载物模型 ⇒ 不为空模型发请求
    expect(apiMock.listServices).not.toHaveBeenCalled();
  });
});
