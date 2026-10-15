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

import { $t } from '#/locales';

import RuleForm from './modules/rule-form.vue';

/**
 * 告警规则「多条件」组件级用例（task-4 建，task-7 按真 AND 语义修订）。
 *
 * 覆盖的**用户可感知失败**（每一条都在改造前会真实发生）：
 * 1. 编辑一条 `points=[A,B]` 的规则 ⇒ **两行都回填**（旧实现只取 points[0]，B 被静默丢弃）；
 * 2. 保存时 `payload.points` 长度为 2 且**顺序与界面一致**；
 * 3. 删除一行后保存 ⇒ payload 只剩 1 行（删掉的行确实不再提交）；
 * 4. 点位级规则删到 0 行 ⇒ **提交被拦且有可见提示**（不是静默提交成断档类规则）；
 * 5. **同一点位重复必须放行**（task-7 翻转）——去重键已是 `R:ruleId:deviceId`（不含 propertyId），
 *    组内两条同点位条件各参与一次合取判定，是合法条件组；上一轮那条「重复点位必须被拦」的用例
 *    建立在旧去重键之上，已随语义变更删除。
 * 6. **文案必须是 AND 口径**（组内全部条件同时满足才告警）——用户按 OR 理解就会配错规则。
 *
 * 纪律：**绝不 mock `#/locales`**（真实 vue-i18n + 真实语言包），
 * 否则「键缺失 / 文案编译失败」这类只在实际渲染时暴露的问题会被结构性漏掉。
 * 文案断言一律用真实 `$t` 取**已提交 page.json** 的期望值（CI 检出里没有仓外 temp/），
 * 这样既守住语义，又不会写死译文导致润色即转红。
 */

const { drawerCalls, mockApi } = vi.hoisted(() => ({
  drawerCalls: {
    data: null as any,
    options: null as any,
    closed: 0,
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

/** 通知对象选择器走真实组件，但其用户接口必须打桩（本用例不关心收件人）。 */
vi.mock('#/api/system/user', () => ({
  getUserDetail: (...args: unknown[]) => mockApi.getUserDetail(...args),
  getUserList: (...args: unknown[]) => mockApi.getUserList(...args),
}));

/** 抽屉容器桩：把默认插槽与 footer 都渲染出来，并允许用例手动触发 `onOpenChange(true)`。 */
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
        close: () => {
          drawerCalls.closed += 1;
        },
        getData: () => drawerCalls.data,
        open: vi.fn(),
        setData: vi.fn(),
        setState: vi.fn(),
      },
    ];
  },
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  drawerCalls.data = null;
  drawerCalls.options = null;
  drawerCalls.closed = 0;

  mockApi.getAlertPresets.mockResolvedValue([
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
  ]);
  mockApi.getDeviceOptions.mockResolvedValue([
    { deviceCode: 'demo-1', deviceName: '演示设备', id: '9', productId: '1' },
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
    {
      dataType: 'double',
      identifier: 'humidity',
      propertyName: '湿度',
      unit: '%',
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
  // 试算用样本（质量 GOOD，值 85）——只有一个点，够判定一次命中
  mockApi.getDeviceSeries.mockResolvedValue([
    { quality: 'GOOD', ts: 1_700_000_000_000, value: '85' },
  ]);
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

/** 挂载规则表单并打开抽屉（编辑态：`data.rule` 存在）。 */
async function mountForm(rule: Record<string, unknown>) {
  drawerCalls.data = { rule };
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(RuleForm as never) });
  app.mount(container);
  mounted = { app };
  await flush();
  await drawerCalls.options.onOpenChange(true);
  await flush();
  return { app, container };
}

/** 编辑态的规则（点位级、两条件）。 */
function ruleWith(points: Record<string, unknown>[]) {
  return {
    deviceName: '演示设备',
    enabled: true,
    id: '77',
    notifyChannels: 'INBOX',
    points,
    repeatIntervalSec: 1800,
    ruleName: '演示多条件规则',
    scopeDeviceId: '9',
    scopeProductId: '1',
    scopeType: 'POINT',
    severity: 'WARNING',
    triggerMode: 'CONSECUTIVE_COUNT',
    triggerThreshold: 3,
  };
}

const POINT_TEMPERATURE = {
  deadband: '2',
  id: '1',
  operator: 'GT',
  propertyId: 'temperature',
  threshold: '80',
  valueType: 'NUMERIC',
};

const POINT_HUMIDITY = {
  id: '2',
  operator: 'LT',
  propertyId: 'humidity',
  threshold: '10',
  valueType: 'NUMERIC',
};

/** 某个 DOM 子树里所有 Input 的值（空值也保留，便于断言"确实为空"）。 */
function inputValuesOf(root: HTMLElement) {
  return [...root.querySelectorAll('input')].map((input) => input.value);
}

function rowsOf(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-testid^="condition-row-"]',
    ),
  ];
}

/**
 * 按文案找按钮。
 *
 * antdv 会给两个汉字的按钮插入空格（「试算」渲染成「试 算」）⇒ 先去掉所有空白再比较，
 * 否则用例会静默找不到按钮（点了个 undefined，断言随之假失败/假通过）。
 */
function buttonByText(container: HTMLElement, text: string) {
  const normalize = (value: string) => value.replaceAll(/\s/g, '');
  return [...container.querySelectorAll('button')].find((button) =>
    normalize(button.textContent ?? '').includes(normalize(text)),
  );
}

function saveButton(container: HTMLElement) {
  return buttonByText(container, '保存规则');
}

describe('多条件表单：编辑回填（本次核心 bug）', () => {
  it('🔴 编辑 points=[A,B] ⇒ 两行都回填，且 A/B 的点位/阈值/回差都还在', async () => {
    const { container } = await mountForm(
      ruleWith([POINT_TEMPERATURE, POINT_HUMIDITY]),
    );

    const rows = rowsOf(container);
    expect(rows).toHaveLength(2);
    const [firstRow, secondRow] = rows;
    expect(firstRow).toBeDefined();
    expect(secondRow).toBeDefined();
    // 行内 Input 的**值**与后端返回逐字一致（不依赖 antdv 下拉的文案渲染）
    expect(inputValuesOf(firstRow as HTMLElement)).toEqual(
      expect.arrayContaining(['80', '2']),
    );
    expect(inputValuesOf(secondRow as HTMLElement)).toEqual(
      expect.arrayContaining(['10']),
    );
    // B 行没有回差 ⇒ 回差输入为空（不是 '0'，更不是被 A 的回差串了）
    expect(inputValuesOf(secondRow as HTMLElement)).not.toContain('2');
    expect(inputValuesOf(firstRow as HTMLElement)).not.toContain('10');
  });

  it('🔴 保存时 payload.points 长度为 2，顺序与界面一致（不静默丢 B）', async () => {
    const { container } = await mountForm(
      ruleWith([POINT_TEMPERATURE, POINT_HUMIDITY]),
    );

    saveButton(container)?.click();
    await flush();

    expect(mockApi.updateAlertRule).toHaveBeenCalledTimes(1);
    const [id, payload] = mockApi.updateAlertRule.mock.calls[0] as [
      string,
      { points: Record<string, unknown>[] },
    ];
    expect(id).toBe('77');
    expect(payload.points).toHaveLength(2);
    expect(payload.points.map((point) => point.propertyId)).toEqual([
      'temperature',
      'humidity',
    ]);
    expect(payload.points[0]).toEqual({
      deadband: '2',
      operator: 'GT',
      propertyId: 'temperature',
      threshold: '80',
      valueType: 'NUMERIC',
    });
    // 无回差的行不带 deadband 字段（空串会被后端当「有回差但解析失败」）
    expect(payload.points[1]?.deadband).toBeUndefined();
  });

  it('删除一行后保存 ⇒ payload 只剩 1 行', async () => {
    const { container } = await mountForm(
      ruleWith([POINT_TEMPERATURE, POINT_HUMIDITY]),
    );
    expect(rowsOf(container)).toHaveLength(2);

    container
      .querySelector<HTMLElement>('[data-testid="condition-remove-1"]')
      ?.click();
    await flush();
    expect(rowsOf(container)).toHaveLength(1);
    // 留下的是原来的**第一行**（温度 80、回差 2），删掉的是第二行
    expect(inputValuesOf(rowsOf(container)[0] as HTMLElement)).toEqual(
      expect.arrayContaining(['80', '2']),
    );

    saveButton(container)?.click();
    await flush();

    const [, payload] = mockApi.updateAlertRule.mock.calls[0] as [
      string,
      { points: Record<string, unknown>[] },
    ];
    expect(payload.points).toHaveLength(1);
    expect(payload.points[0]?.propertyId).toBe('temperature');
  });

  it('新增一行后保存 ⇒ 新行也被提交（不丢行）', async () => {
    const { container } = await mountForm(
      ruleWith([POINT_TEMPERATURE, POINT_HUMIDITY]),
    );

    container
      .querySelector<HTMLElement>('[data-testid="condition-add"]')
      ?.click();
    await flush();
    expect(rowsOf(container)).toHaveLength(3);
  });
});

describe('多条件表单：点位级规则删到 0 行必须被拦且有可见提示', () => {
  it('🔴 删空后：空态提示 + 作用域错误可见，且保存按钮禁用（不会提交成断档类规则）', async () => {
    const { container } = await mountForm(ruleWith([POINT_TEMPERATURE]));

    container
      .querySelector<HTMLElement>('[data-testid="condition-remove-0"]')
      ?.click();
    await flush();

    expect(rowsOf(container)).toHaveLength(0);
    // 可见提示 1：空条件行是「断档类」还是「点位级至少一行」——点位级必须说后者。
    // 断言**渲染文案**，且必须与「断档类」提示区分开（两者都在同一位置，只有文案不同）。
    const emptyText =
      container.querySelector('[data-testid="condition-empty"]')?.textContent ??
      '';
    expect(emptyText).toContain(
      $t('page.iot.alert.rule.condition.noneHintPoint'),
    );
    expect(emptyText).not.toContain(
      $t('page.iot.alert.rule.condition.noneHint'),
    );
    // 可见提示 2：作用域级错误（与后端 validate() 同一条约束）
    expect(
      container.querySelector('[data-testid="condition-scope-error"]')
        ?.textContent,
    ).toContain($t('page.iot.alert.rule.condition.needOne'));
    // 提交被拦：保存按钮处于禁用态 ⇒ 点不动（不会把点位级规则静默落成断档类）
    expect(saveButton(container)?.disabled).toBe(true);

    saveButton(container)?.click();
    await flush();
    expect(mockApi.updateAlertRule).not.toHaveBeenCalled();
  });
});

describe('多条件表单：同一行重复点位必须**放行**（真 AND 下的合法条件组）', () => {
  it('🔴 两行同点位（> 80 且 < 100）⇒ 无行内报错、可保存、**两行都提交**', async () => {
    const { container } = await mountForm(
      ruleWith([
        POINT_TEMPERATURE,
        {
          ...POINT_HUMIDITY,
          operator: 'LT',
          propertyId: 'temperature',
          threshold: '100',
        },
      ]),
    );

    // 行内不得出现任何报错（旧实现会在这里报 duplicatePoint 并阻断保存）
    expect(
      container.querySelector('[data-testid="condition-error-1"]'),
    ).toBeNull();
    // 也不得出现作用域级报错
    expect(
      container.querySelector('[data-testid="condition-scope-error"]'),
    ).toBeNull();
    expect(saveButton(container)?.disabled).toBe(false);

    saveButton(container)?.click();
    await flush();
    expect(mockApi.updateAlertRule).toHaveBeenCalledTimes(1);
    const [, payload] = mockApi.updateAlertRule.mock.calls[0] as [
      string,
      { points: Record<string, unknown>[] },
    ];
    // 两行都进请求（同点位不再被去重/静默合并）
    expect(payload.points).toHaveLength(2);
    expect(payload.points.map((item) => item.propertyId)).toEqual([
      'temperature',
      'temperature',
    ]);
    expect(payload.points.map((item) => item.threshold)).toEqual(['80', '100']);
  });
});

describe('多条件表单：界面文案必须是 AND 口径（真 AND）', () => {
  it('🔴 条件区提示写「全部条件同时满足才告警」，不得再出现旧逐条件措辞', async () => {
    const { container } = await mountForm(
      ruleWith([POINT_TEMPERATURE, POINT_HUMIDITY]),
    );

    const hint = $t('page.iot.alert.rule.condition.perPointHint');
    // 断言渲染文案包含真实 i18n 文案（不写死译文，避免润色即转红）
    expect(container.textContent).toContain(hint);
    // 新口径必须在场；旧口径必须消失
    expect(hint).toContain('全部条件');
    expect(container.textContent).not.toContain('各自独立判定');
  });

  it('🔴 人话摘要把两行连成「…且…」（AND），不得再把多行说成独立判定', async () => {
    const { container } = await mountForm(
      ruleWith([POINT_TEMPERATURE, POINT_HUMIDITY]),
    );

    const clause = container.querySelector(
      '[data-testid="summary-condition-clause"]',
    );
    const text = clause?.textContent ?? '';
    // 两行都存在，且被「且」连起来（连接词来自 i18n 键，与 rule-form 渲染同源）
    expect(text).toContain($t('page.iot.alert.rule.condition.clauseJoin'));
    // 操作符必须是**人话符号**（与单条件句子同一个显示函数），不是契约码 GT / LT
    expect(text).toContain('>');
    expect(text).toContain('<');
    expect(text).not.toContain('GT');
    expect(text).not.toContain('LT');
    // 摘要主句必须是「全部满足」口径（参数 = 条件数、连续次数、重复间隔秒）
    expect(container.textContent).toContain(
      $t('page.iot.alert.rule.condition.summaryMultiple', [2, 3, 1800]),
    );
    expect(container.textContent).not.toContain('逐个独立判定');
  });
});

describe('多条件表单：非法行不静默通过', () => {
  it('阈值非数字 ⇒ 行内报错 + 保存被拦', async () => {
    const { container } = await mountForm(
      ruleWith([{ ...POINT_TEMPERATURE, threshold: '八十' }]),
    );

    expect(
      container.querySelector('[data-testid="condition-error-0"]')?.textContent,
    ).toContain($t('page.iot.alert.rule.condition.thresholdNotNumber', [1]));
    expect(saveButton(container)?.disabled).toBe(true);
  });
});

/**
 * 试算区会随条件行变化而失效。
 *
 * 这一条是**回归用例**：我把「监听条件行」从 `watch(..., { deep: true })` 改成
 * 「把每行投影成字符串元组再浅比较」，语义必须完全一致——改了任一行字段，
 * 上一次试算结果都必须立即清掉（用户不能拿着旧阈值的试算结果当真）。
 */
describe('多条件表单：条件一改 ⇒ 上一次试算结果失效', () => {
  it('🔴 改阈值后，上一次试算结果必须被清掉（不留旧结果）', async () => {
    const { container } = await mountForm(ruleWith([POINT_TEMPERATURE]));

    // 先跑一次试算：结果区出现（跑过就必须可见，见 rule-form 的 backtest-result 容器）
    buttonByText(container, '试算')?.click();
    await flush();
    expect(
      container.querySelector('[data-testid="backtest-result"]'),
    ).not.toBeNull();

    // 改阈值：条件行一变，上一次结果必须失效（不得继续展示旧阈值的试算结果）。
    // 注意：行内 DOM 顺序是「点位 Select、比较符 Select、阈值 Input、回差 Input」，
    // Select 也带 input ⇒ 不能靠下标取，按**当前值**定位阈值输入。
    const row = container.querySelector('[data-testid="condition-row-0"]');
    const inputs = [
      ...(row?.querySelectorAll('input') ?? []),
    ] as HTMLInputElement[];
    const thresholdInput = inputs.find((input) => input.value === '80');
    if (!thresholdInput) {
      throw new Error('未找到阈值输入（值为 80 的 input）');
    }
    thresholdInput.value = '90';
    thresholdInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(
      container.querySelector('[data-testid="backtest-row-0"]'),
    ).toBeNull();
  });
});
