import { createApp, defineComponent, h, nextTick } from 'vue';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import RuleForm from './modules/rule-form.vue';

/**
 * 告警规则表的两个「用户可感知」修复用例：
 *
 * 1. **P1-7**：一键模板从 `<Tag @click>`（键盘不可达）改成真正的 `<Button>`——纯键盘用户可以
 *    Tab 到模板并用 Enter/Space 触发；用例断言它是原生 button（而非 span）且点击真的切换模板。
 * 2. **P2-8**：历史试算切换设备后，**旧设备在途请求的响应必须被丢弃**（不能把旧设备序列
 *    当成新设备的试算结果）；新请求必须用新设备开工。
 *
 * 文案断言一律用真实 `$t`（不 mock `#/locales`），避免语言包缺失时被结构性漏掉。
 */

const { drawerCalls, mockApi } = vi.hoisted(() => ({
  drawerCalls: {
    data: null as any,
    options: null as any,
  },
  mockApi: {
    createAlertRule: vi.fn(),
    getAlertPresets: vi.fn(),
    getDeviceOptions: vi.fn(),
    getDeviceSeries: vi.fn(),
    getPublishedProductOptions: vi.fn(),
    getUserDetail: vi.fn(),
    getUserList: vi.fn(),
    listProperties: vi.fn(),
    listServices: vi.fn(),
    updateAlertRule: vi.fn(),
  },
}));

vi.mock('#/api/iot', () => ({
  createAlertRule: (...args: unknown[]) => mockApi.createAlertRule(...args),
  getAlertPresets: (...args: unknown[]) => mockApi.getAlertPresets(...args),
  getDeviceOptions: (...args: unknown[]) => mockApi.getDeviceOptions(...args),
  getDeviceSeries: (...args: unknown[]) => mockApi.getDeviceSeries(...args),
  getPublishedProductOptions: (...args: unknown[]) =>
    mockApi.getPublishedProductOptions(...args),
  listProperties: (...args: unknown[]) => mockApi.listProperties(...args),
  listServices: (...args: unknown[]) => mockApi.listServices(...args),
  updateAlertRule: (...args: unknown[]) => mockApi.updateAlertRule(...args),
}));

vi.mock('#/api/system/user', () => ({
  getUserDetail: (...args: unknown[]) => mockApi.getUserDetail(...args),
  getUserList: (...args: unknown[]) => mockApi.getUserList(...args),
}));

/** 抽屉容器桩：渲染默认插槽与 footer，并暴露 `onOpenChange` 供用例「打开」抽屉。 */
vi.mock('@vben/common-ui', () => ({
  useVbenDrawer: (options: Record<string, unknown>) => {
    drawerCalls.options = options;
    const Stub = defineComponent({
      name: 'DrawerStub',
      setup:
        (_props, { slots }) =>
        () =>
          h('div', { class: 'drawer-stub' }, [
            slots.default?.(),
            slots.footer?.(),
          ]),
    });
    return [
      Stub,
      {
        close: vi.fn(),
        getData: () => drawerCalls.data,
        open: vi.fn(),
        setData: vi.fn(),
        setState: vi.fn(),
      },
    ];
  },
}));

const TWO_PRESETS = [
  {
    code: 'POINT_ABOVE_UPPER',
    defaultNotifyChannels: 'INBOX',
    defaultOperator: 'GT',
    defaultScopeType: 'POINT',
    defaultSeverity: 'WARNING',
    defaultTriggerMode: 'CONSECUTIVE_COUNT',
    defaultTriggerThreshold: 3,
    i18nKey: 'page.iot.alert.preset.aboveUpper',
    needsPointCondition: true,
  },
  {
    code: 'POINT_BELOW_LOWER',
    defaultNotifyChannels: 'INBOX',
    defaultOperator: 'LT',
    defaultScopeType: 'POINT',
    defaultSeverity: 'WARNING',
    defaultTriggerMode: 'CONSECUTIVE_COUNT',
    defaultTriggerThreshold: 3,
    i18nKey: 'page.iot.alert.preset.belowLower',
    needsPointCondition: true,
  },
];

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  drawerCalls.data = null;
  drawerCalls.options = null;

  mockApi.getAlertPresets.mockResolvedValue(TWO_PRESETS);
  mockApi.getDeviceOptions.mockResolvedValue([
    { deviceCode: 'demo-1', deviceName: '演示设备', id: '9', productId: '1' },
    { deviceCode: 'demo-2', deviceName: '备用设备', id: '10', productId: '1' },
  ]);
  mockApi.getPublishedProductOptions.mockResolvedValue([
    { id: '1', productCode: 'demo-p', productName: '演示产品' },
  ]);
  mockApi.listServices.mockResolvedValue([{ id: '11', name: '默认服务' }]);
  mockApi.listProperties.mockResolvedValue([
    {
      dataType: 'double',
      identifier: 'temperature',
      propertyName: '温度',
      unit: '℃',
    },
  ]);
  mockApi.getUserList.mockResolvedValue({
    items: [],
    page: '1',
    pageSize: '10',
    total: '0',
  });
  mockApi.updateAlertRule.mockResolvedValue({});
  mockApi.createAlertRule.mockResolvedValue({});
});

let mounted: undefined | { app: { unmount: () => void } };

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function flush(times = 24) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
  await nextTick();
}

/** 挂载规则表单并「打开」抽屉（`data.rule` 存在 = 编辑态）。 */
async function mountForm(data: Record<string, unknown>) {
  drawerCalls.data = data;
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(RuleForm as never) });
  app.mount(container);
  mounted = { app };
  await flush();
  await drawerCalls.options.onOpenChange(true);
  await flush();
  return container;
}

function normalize(text: string) {
  return text.replaceAll(/\s/g, '');
}

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => normalize(button.textContent ?? '').includes(normalize(text)),
  );
}

/** 编辑态的规则：点位级、单条件（温度 > 80）。 */
function ruleWithTemperature() {
  return {
    enabled: true,
    id: '77',
    notifyChannels: 'INBOX',
    points: [
      {
        deadband: '2',
        id: '1',
        operator: 'GT',
        propertyId: 'temperature',
        threshold: '80',
        valueType: 'NUMERIC',
      },
    ],
    repeatIntervalSec: 1800,
    ruleName: '演示单条件规则',
    scopeDeviceId: '9',
    scopeProductId: '1',
    scopeType: 'POINT',
    severity: 'WARNING',
    triggerMode: 'CONSECUTIVE_COUNT',
    triggerThreshold: 3,
  };
}

/** 在真实 antd Select 上选中一个选项（点开下拉 → 点选项，与真实用户路径一致）。 */
async function pickDevice(container: HTMLElement, label: string) {
  const select = container.querySelector<HTMLElement>(
    '[data-testid="backtest-device"]',
  );
  expect(select, '未找到试算设备下拉').toBeTruthy();
  (select?.querySelector('.ant-select-selector') as HTMLElement)?.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true }),
  );
  await flush();
  const option = [...document.querySelectorAll('.ant-select-item-option')].find(
    (element) => element.textContent?.includes(label),
  ) as HTMLElement | undefined;
  expect(option, `下拉里没有选项 ${label}`).toBeTruthy();
  option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flush();
}

/** 挂起的试算请求（逐条记录入参，由用例决定何时 resolve）。 */
interface PendingSeriesRequest {
  deviceId: string;
  propertyId: string;
  resolve: (value: unknown) => void;
}

function deferSeries(): PendingSeriesRequest[] {
  const pending: PendingSeriesRequest[] = [];
  mockApi.getDeviceSeries.mockImplementation(
    (deviceId: string, params: { propertyId: string }) =>
      new Promise((resolve) => {
        pending.push({
          deviceId,
          propertyId: params.propertyId,
          resolve,
        });
      }),
  );
  return pending;
}

describe('rule-form：一键模板必须键盘可达（P1-7）', () => {
  it('★ 预设模板是原生 button（可聚焦/Enter/Space 可用），点击真的切换模板', async () => {
    const container = await mountForm({});

    const first = container.querySelector<HTMLButtonElement>(
      '[data-testid="preset-POINT_ABOVE_UPPER"]',
    );
    const second = container.querySelector<HTMLButtonElement>(
      '[data-testid="preset-POINT_BELOW_LOWER"]',
    );
    expect(first, '未渲染预设模板').toBeTruthy();
    expect(second, '未渲染第二个预设模板').toBeTruthy();

    // 🎯 键盘可达的硬判据：是原生 <button>（Tab 可聚焦、Enter/Space 触发 click），
    // 而不是旧实现的 <span class="ant-tag" @click>（不可聚焦、无键盘激活）。
    expect(first?.tagName).toBe('BUTTON');
    expect(second?.tagName).toBe('BUTTON');
    expect(first?.disabled).toBe(false);

    // 默认应用第一个模板 ⇒ 选中态用 primary 表达
    expect(first?.className).toContain('ant-btn-primary');

    second?.click();
    await flush();
    // 点击后选中态切换（说明回调真的执行，而不是只有样式）
    expect(
      container.querySelector('[data-testid="preset-POINT_BELOW_LOWER"]')
        ?.className,
    ).toContain('ant-btn-primary');
    expect(
      container.querySelector('[data-testid="preset-POINT_ABOVE_UPPER"]')
        ?.className,
    ).not.toContain('ant-btn-primary');
  });
});

describe('rule-form：试算切换设备后旧响应必须丢弃（P2-8，不能串台）', () => {
  it('★ 旧设备在途响应不得覆盖新设备结果；新请求用新设备 id 开工', async () => {
    const pending = deferSeries();
    const container = await mountForm({ rule: ruleWithTemperature() });

    // 1) 首次试算：请求发往设备 9（编辑态规则的 scopeDeviceId）
    buttonByText(container, '试算')?.click();
    await flush();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.deviceId).toBe('9');
    expect(pending[0]?.propertyId).toBe('temperature');

    // 2) 请求还没回来就切换试算设备到「备用设备」(id=10)
    await pickDevice(container, '备用设备');

    // 3) 旧请求此时才返回（85 > 80，若被当成新设备结果就会显示「命中」）
    pending[0]?.resolve([
      { quality: 'GOOD', ts: 1_700_000_000_000, value: '85' },
    ]);
    await flush();

    // 🔴 旧响应必须被丢弃：不能出现试算结果
    expect(
      container.querySelector('[data-testid="backtest-result"]'),
      '旧设备的在途响应被画成了新设备的试算结果（串台）',
    ).toBeNull();

    // 4) 在新设备上重新试算 ⇒ 请求必须带新设备 id
    buttonByText(container, '试算')?.click();
    await flush();
    expect(pending).toHaveLength(2);
    expect(pending[1]?.deviceId).toBe('10');

    // 新请求返回（10 < 80，不命中）⇒ 这次才允许渲染结果
    pending[1]?.resolve([
      { quality: 'GOOD', ts: 1_700_000_000_000, value: '10' },
    ]);
    await flush();
    expect(
      container.querySelector('[data-testid="backtest-result"]'),
    ).toBeTruthy();
  });
});
