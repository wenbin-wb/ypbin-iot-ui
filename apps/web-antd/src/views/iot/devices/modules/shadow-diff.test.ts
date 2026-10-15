import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createApp, h, nextTick } from 'vue';

import { i18n } from '@vben/locales';

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

import ShadowDiff from './shadow-diff.vue';
import ShadowEdit from './shadow-edit.vue';

/**
 * 影子「差异对比 + 一键应用」的**运行时**组件级用例（真实 vue-i18n + 真实 antdv）。
 *
 * 三条硬纪律（与 detail-debug.test.ts 同因）：
 * 1. **绝不 mock \`#/locales\`**：文案里出现未转义的字面 \`{\` \`}\` 会让 vue-i18n 在渲染期抛
 *    SyntaxError ⇒ 整块空白，而 typecheck / 构建 / 键存在性门禁全绿。本用例按真实链编译新键。
 * 2. **断言真实文案**：不允许「空白即通过」——空态/失败态/成功态都断言到具体中文。
 * 3. **权限桩必须响应式**（与生产同构）：computed 的失效通知只对响应式读取生效，
 *    普通对象当桩会让「权限码变化 ⇒ 写入口消失/出现」这条路径**结构性地抓不到**。
 *
 * 新键来自 \`temp/i18n-requests-frontend-shadow-diff.json\`（仓规：不直接改 page.json，由 Lead 合并）。
 * 用例显式加载该请求文件并合并进 i18n 实例：既保证本用例在合并前后都跑真实新文案，
 * 也把「请求文件里的键/值」本身纳入断言（缺键会以原始 key 渲染而被下面的断言抓住）。
 */
const { accessStore, mockPut } = vi.hoisted(() => ({
  accessStore: { current: null as null | { accessCodes: string[] } },
  mockPut: vi.fn(),
}));

vi.mock('#/api/request', () => ({
  requestClient: {
    delete: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: (...args: unknown[]) => mockPut(...args),
  },
}));

vi.mock('@vben/stores', async () => {
  const { reactive } = await import('vue');
  const store = reactive({ accessCodes: [] as string[] });
  accessStore.current = store;
  return {
    useAccessStore: () => store,
    useUserStore: () => reactive({ userRoles: [] as string[] }),
  };
});

vi.mock('@vben/preferences', () => ({
  preferences: { app: { accessMode: 'frontend', locale: 'zh-CN' } },
  updatePreferences: () => {},
}));

/** 待合并的新键（仓规产物；zh/en 键集合由该文件自身保证一致）。 */
type I18nRequest = Record<string, string>;

/** 设置权限码：写**响应式代理**（与生产同一条路径），不能改原始对象。 */
function setCodes(codes: string[]) {
  if (!accessStore.current) {
    throw new Error('accessStore 桩未初始化：@vben/stores 还没被 import');
  }
  accessStore.current.accessCodes = codes;
}

/**
 * 读取本任务的 i18n 请求文件（仓规：新键先落 \`temp/i18n-requests-*.json\`，由 Lead 合并进 page.json）。
 *
 * 用 \`node:fs\` 而不是 \`import\`：该文件在**前端仓之外**（跨仓目录），
 * 走 Vite 模块图会受 root 限制；而 vitest 直接跑在 Node 里，读文件是确定性的。
 * 两个候选路径都试：从 \`ypbin-iot-ui\` 或从聚合根 \`ypbin\` 启动都能命中。
 */
function readI18nRequest(): null | Record<string, I18nRequest> {
  const candidates = [
    resolve(process.cwd(), '../temp/i18n-requests-frontend-shadow-diff.json'),
    resolve(process.cwd(), 'temp/i18n-requests-frontend-shadow-diff.json'),
  ];
  const found = candidates.find((item) => existsSync(item));
  // 合并进 page.json 后请求文件可能被清理 ⇒ 不是错误，静默跳过（此时新键已在真实语言包里）
  return found
    ? (JSON.parse(readFileSync(found, 'utf8')) as Record<string, I18nRequest>)
    : null;
}

/** 把「page.iot.x.y」扁平键展开成 vue-i18n 需要的嵌套对象。 */
function nestKeys(flat: I18nRequest): Record<string, unknown> {
  const root: Record<string, any> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node[part] = node[part] ?? {};
      node = node[part];
    }
    node[parts.at(-1) ?? ''] = value;
  }
  return root;
}

/** 真实 i18n 实例：只初始化一次（\`$t\` 就是 \`i18n.global.t\`）。 */
beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });

  // 真实语言包（含既有 shadow 键）+ 请求文件里的新键，两语都合并
  for (const lang of ['zh-CN', 'en-US'] as const) {
    const pageMod = (await import(`#/locales/langs/${lang}/page.json`)) as {
      default?: Record<string, unknown>;
    };
    i18n.global.mergeLocaleMessage(lang, {
      page: pageMod.default ?? pageMod,
    } as never);
    // 请求文件的键是**完整键**（含前导 page.），nestKeys 展开后直接合并，不能再套一层 page。
    // 合并后（文件可能已被清理）回头再套一层：真实语言包已含新键，用例仍然自洽。
    const request = readI18nRequest();
    if (request) {
      i18n.global.mergeLocaleMessage(
        lang,
        nestKeys(request[lang] ?? {}) as never,
      );
    }
  }
});

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  mockPut.mockReset();
  mockPut.mockResolvedValue(null);
  setCodes(['iot:shadow:update']);
});

/**
 * 清理传送到 body 的浮层。
 *
 * 为什么**不能**直接 \`document.body.innerHTML = ''\`：antd 的 \`message\` 复用同一个挂在 body 的
 * 容器，整体清空会把它摘成游离节点 ⇒ 之后所有 message 都渲染进游离 DOM、断言全看不到
 * （实测造成用例之间互相污染、按单文件/按用例跑结果不一致）。这里只销毁消息与弹窗根节点。
 */
afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  message.destroy();
  for (const node of document.querySelectorAll('.ant-modal-root')) {
    node.remove();
  }
});

async function flush(times = 8) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

/** 挂载差异组件（真实 antdv + 真实 i18n）。 */
async function mountDiff(props: Record<string, unknown> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({
    render: () =>
      h(ShadowDiff as never, {
        deviceId: '9300012',
        ...props,
      }),
  });
  app.mount(container);
  await flush();
  mounted = { app };
  return container;
}

/**
 * 找 antd 弹窗的确认按钮。
 *
 * 不能按 \`textContent === '应用'\` 直接找：antd 会在**两个中文字之间插空格**（\`应 用\`），
 * 所以这里去掉全部空白再比。
 */
function findModalOkButton(label: string): HTMLButtonElement | undefined {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      '.ant-modal-footer button, .ant-modal-confirm-btns button',
    ),
  ].find((item) => item.textContent?.replaceAll(/\s+/g, '') === label);
}

/** 挂载纯写入口（一键应用按钮在阴影编辑组件内，这里直接测它的接线）。 */
async function mountEdit(props: Record<string, unknown> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({
    render: () =>
      h(ShadowEdit as never, {
        deviceId: '9300012',
        ...props,
      }),
  });
  app.mount(container);
  await flush();
  mounted = { app };
  return container;
}

const REPORTED = { num: '25.0', onlyReported: 'x', same: 'ok' };
const DESIRED = { num: 26, onlyDesired: 'y', same: 'ok' };

describe('shadow-diff.vue：四态 / 空态 / 权限（真实 i18n）', () => {
  it('四态逐行渲染 + 图例 + 双列文本（不做「空白即通过」）', async () => {
    const container = await mountDiff({ desired: DESIRED, reported: REPORTED });

    // 每个状态各一行，且用 data-diff-status 标出（供无障碍/回归定位）
    // 四个键各命中一态：num(25.0 vs 26)=值不一致、same=一致、onlyDesired=仅期望、onlyReported=仅上报
    const expectedCounts: Record<string, number> = {
      'extra-report': 1,
      match: 1,
      'missing-report': 1,
      'value-differs': 1,
    };
    for (const [status, count] of Object.entries(expectedCounts)) {
      expect(
        container.querySelectorAll(`[data-diff-status="${status}"]`).length,
        `状态 ${status} 的行数`,
      ).toBe(count);
    }

    const html = container.innerHTML;
    // 真实中文文案（i18n 键若缺或编译不过，这里会看到原始 key / 整块空白）
    expect(html).toContain('差异对比（reported vs desired）');
    expect(html).toContain('一致');
    expect(html).toContain('值不一致');
    expect(html).toContain('仅期望（该键尚未上报）');
    expect(html).toContain('仅上报（期望中无此键）');
    expect(html).not.toContain('page.iot.shadow.');

    // 两侧原始文本都在（reported 字符串 vs desired 数值，不得被格式化吞掉）
    expect(html).toContain('25.0');
    expect(html).toContain('onlyReported');
    expect(html).toContain('onlyDesired');
    // 缺键一侧用 '-' 占位而不是空单元格
    const extraRow = container.querySelector(
      '[data-diff-status="extra-report"]',
    );
    expect(extraRow?.textContent).toContain('-');
  });

  it('🔴 空态：两侧都空给明确文案（不是空白）', async () => {
    const container = await mountDiff({ desired: {}, reported: {} });
    const html = container.innerHTML;
    expect(html).toContain('reported 与 desired 都为空，暂无可对比的键');
    expect(container.querySelector('table')).toBeNull();
  });

  it('🔴 判等与后端同口径：25.0 vs 25、TRUE vs true 显示「一致」而不是「值不一致」', async () => {
    const container = await mountDiff({
      desired: { bool: true, num: 25 },
      reported: { bool: 'TRUE', num: '25.0' },
    });
    expect(
      container.querySelectorAll('[data-diff-status="match"]').length,
    ).toBe(2);
    expect(
      container.querySelectorAll('[data-diff-status="value-differs"]').length,
    ).toBe(0);
  });

  it('🔴 无 iot:shadow:update：不渲染任何写入口，但 diff 仍完整可见', async () => {
    setCodes([]);
    const container = await mountDiff({ desired: DESIRED, reported: REPORTED });
    await flush(2);

    // 只读差异仍在
    expect(container.querySelectorAll('[data-diff-status]').length).toBe(4);
    expect(container.innerHTML).toContain('差异对比（reported vs desired）');
    // 写入口（编辑 + 一键应用）都不渲染：一个 button 都不该有（HTML 注释里出现文案不算渲染）
    expect(
      container.querySelector('[data-testid="shadow-apply-button"]'),
    ).toBeNull();
    expect(container.querySelectorAll('button').length).toBe(0);
    expect(container.textContent).not.toContain('一键应用');
    expect(container.textContent).not.toContain('编辑期望值');
  });

  it('有权限且存在差异：一键应用按钮可见；无差异时禁用（不发无意义 PUT）', async () => {
    const withDiff = await mountDiff({ desired: DESIRED, reported: REPORTED });
    const button = withDiff.querySelector<HTMLButtonElement>(
      '[data-testid="shadow-apply-button"]',
    );
    expect(button).toBeTruthy();
    expect(button?.textContent).toContain('一键应用');
    expect(button?.disabled).toBe(false);
    mounted?.app.unmount();
    mounted = undefined;

    // 两侧同口径等价 ⇒ 没有可应用的差异 ⇒ 禁用
    const noDiff = await mountDiff({
      desired: { num: 25 },
      reported: { num: '25.0' },
    });
    const disabled = noDiff.querySelector<HTMLButtonElement>(
      '[data-testid="shadow-apply-button"]',
    );
    expect(disabled?.disabled).toBe(true);
  });
});

describe('一键应用：以上报为准（desired ← reported，整体替换）', () => {
  it('点击后先弹二次确认（含将被整体替换的键数与后果说明），确认前不发 PUT', async () => {
    const container = await mountEdit({
      initialDesired: DESIRED,
      reported: REPORTED,
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="shadow-apply-button"]',
    );
    expect(button?.disabled).toBe(false);

    button?.click();
    await flush();

    // antd Modal 传送到 body
    const modal = document.querySelector('.ant-modal');
    expect(modal, '未渲染二次确认弹窗').toBeTruthy();
    const modalText = modal?.textContent ?? '';
    expect(modalText).toContain('按上报值覆盖期望值？');
    // 确认文案必须说清两件事：整体替换 + 键数（3 个 reported 键）
    expect(modalText).toContain('整体替换');
    expect(modalText).toContain('3');
    // 只有二次确认，没有偷偷发请求
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('🔴 确认后 PUT 到影子端点且 payload = { desired: reported }（剔除多余键）', async () => {
    const container = await mountEdit({
      initialDesired: DESIRED,
      reported: REPORTED,
    });
    container
      .querySelector<HTMLButtonElement>('[data-testid="shadow-apply-button"]')
      ?.click();
    await flush();

    const okButton = findModalOkButton('应用');
    expect(okButton, '二次确认弹窗缺少「应用」按钮').toBeTruthy();
    okButton?.click();
    await flush(12);

    expect(mockPut).toHaveBeenCalledTimes(1);
    const [url, body] = mockPut.mock.calls[0] ?? [];
    expect(url).toBe('/iot/devices/9300012/shadow');
    expect(body).toEqual({
      desired: { num: '25.0', onlyReported: 'x', same: 'ok' },
    });
    // 多余键（desired 里的 onlyDesired）必须被剔除
    expect(
      (body as { desired: Record<string, unknown> }).desired,
    ).not.toHaveProperty('onlyDesired');
    // 成功反馈（message 也传送到 body）
    expect(document.body.textContent).toContain('已按上报值更新期望值');
  });

  it('无差异时点击只提示、不发请求（防误清空）', async () => {
    const container = await mountEdit({
      initialDesired: { num: 25 },
      reported: { num: '25.0' },
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="shadow-apply-button"]',
    );
    expect(button?.disabled).toBe(true);
    button?.click();
    await flush(4);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('reported 为空 ⇒ 结果清空 desired（有损操作必须经确认文案提示）', async () => {
    const container = await mountEdit({
      initialDesired: { temp: 26 },
      reported: {},
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="shadow-apply-button"]',
    );
    expect(button?.disabled).toBe(false);
    button?.click();
    await flush();
    const modalText = document.querySelector('.ant-modal')?.textContent ?? '';
    expect(modalText).toContain('整体替换');
    expect(modalText).toContain('0');

    findModalOkButton('应用')?.click();
    await flush(12);
    expect(mockPut).toHaveBeenCalledWith('/iot/devices/9300012/shadow', {
      desired: {},
    });
  });

  it('🔴 PUT 失败：展示后端错误、不误报成功', async () => {
    mockPut.mockRejectedValueOnce(new Error('影子写入被拒绝'));
    const container = await mountEdit({
      initialDesired: { temp: 20 },
      reported: { temp: 21 },
    });
    container
      .querySelector<HTMLButtonElement>('[data-testid="shadow-apply-button"]')
      ?.click();
    await flush();
    findModalOkButton('应用')?.click();
    await flush(12);

    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('影子写入被拒绝');
    expect(document.body.textContent).not.toContain('已按上报值更新期望值');
  });
});
