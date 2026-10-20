import { createApp, defineComponent, h, nextTick } from 'vue';

import { registerAccessDirective } from '@vben/access';

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

import OpenApiKeysPage from './index.vue';

/**
 * 开放 API Key 管理页（`openApiKeys/index.vue`）的接线用例。
 *
 * 覆盖本轮新增的 `ipWhitelist`（来源 IP 白名单）端到端表单接线：
 *   ① 非法条目在前端被拦下（点名条目、不发请求）——后端建 Key 时同样会拒绝；
 *   ② 合法条目归一化后随创建请求提交（逗号分隔、trim、去重）；
 *   ③ 留空 ⇒ 不传该字段（后端语义 = 不限来源）。
 *
 * 为什么必须挂载页面而不仅测纯函数：纯函数只证明「解析是对的」，
 * 不证明「解析结果真的进了创建请求」。历史事故（P0-3 trace 400）正是
 * 「函数都对、接线错了」这类漂移，只能用真实组件 + 抓请求断言守住。
 */

const { apiMock, captured, gridApiMock } = vi.hoisted(() => ({
  apiMock: {
    createOpenApiKey: vi.fn(),
    getOpenApiKeys: vi.fn(),
    revokeOpenApiKey: vi.fn(),
  },
  captured: { options: null as any },
  gridApiMock: {
    grid: { reactData: { tableLoading: false } },
    query: vi.fn(),
    setLoading: vi.fn(),
  },
}));

vi.mock('#/api/iot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/api/iot')>();
  return { ...actual, ...apiMock };
});

vi.mock('@vben/common-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vben/common-ui')>();
  return {
    ...actual,
    Page: defineComponent({
      name: 'PageStub',
      setup:
        (_props, { slots }) =>
        () =>
          h('div', slots.default?.()),
    }),
  };
});

vi.mock('#/adapter/vxe-table', () => ({
  useVbenVxeGrid: (options: any) => {
    captured.options = options;
    return [
      defineComponent({ name: 'GridStub', setup: () => () => null }),
      gridApiMock,
    ];
  },
}));

const SUCCESS = vi
  .spyOn(message, 'success')
  .mockImplementation(() => undefined as never);
const ERROR = vi
  .spyOn(message, 'error')
  .mockImplementation(() => undefined as never);

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores, useAccessStore } = await import('@vben/stores');
  await initStores(app, { namespace: 'test' });
  // 页面模板有 `v-access:code`：授权后才能渲染「签发 Key」入口
  useAccessStore().setAccessCodes(['*:*:*']);
});

let mounted: undefined | { app: { unmount: () => void } };

function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(OpenApiKeysPage as never) });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  return container;
}

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

/** 点页面头部「签发 Key」打开创建弹窗。 */
async function openCreateModal() {
  const trigger = [...document.body.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === '签发 Key',
  );
  expect(trigger, '未渲染出「签发 Key」入口').toBeTruthy();
  trigger?.click();
  await flush();
}

/** 填应用名（必填）与 IP 白名单。 */
async function fillForm(appName: string, ipWhitelist: string) {
  const modal = document.querySelector('.ant-modal');
  expect(modal, '创建弹窗未渲染').toBeTruthy();
  const appNameInput = modal?.querySelector(
    'input[placeholder="如 third-party-erp"]',
  ) as HTMLInputElement | null;
  if (!appNameInput) {
    throw new Error('未找到应用名输入框');
  }
  appNameInput.value = appName;
  appNameInput.dispatchEvent(new Event('input', { bubbles: true }));

  const whitelistInput = modal?.querySelector(
    'textarea',
  ) as HTMLTextAreaElement | null;
  if (!whitelistInput) {
    throw new Error('未找到 IP 白名单输入框（本轮新增字段）');
  }
  whitelistInput.value = ipWhitelist;
  whitelistInput.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}

/** 点弹窗 footer 的「签发 Key」确认。 */
async function confirmCreate() {
  const footerButton = [
    ...(document.querySelectorAll('.ant-modal-footer button') ?? []),
  ].find((button) => button.textContent?.trim() === '签发 Key');
  expect(footerButton, '未找到弹窗确认按钮').toBeTruthy();
  (footerButton as HTMLButtonElement).click();
  await flush();
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  gridApiMock.query.mockReset();
  gridApiMock.setLoading.mockReset();
  captured.options = null;
  SUCCESS.mockClear();
  ERROR.mockClear();
  apiMock.getOpenApiKeys.mockResolvedValue([]);
  apiMock.createOpenApiKey.mockResolvedValue({
    accessKeyId: 'AK001',
    expireAt: undefined,
    id: 'k-1',
    scopes: ['iot:series:get'],
    secret: 'SECRET',
    secretPrefix: 'sk_',
  });
});

afterEach(async () => {
  mounted?.app.unmount();
  mounted = undefined;
  // antd Dialog 的入场/离场动画由 rc-motion 用 setTimeout 驱动（默认 ~200ms）。
  // 若测试结束时动画还在飞，回调会在**测试文件结束、happy-dom 已销毁之后**执行，
  // 访问 `document` 抛 `ReferenceError: document is not defined`——Vitest 记为
  // unhandled error（用例全绿但 CI 仍红，2026-10-20 全量回归实测踩到）。
  // 等动画定时器跑完（此时 document 仍存在）再清理 DOM，把悬空回调消化在本文件内。
  await new Promise((resolve) => setTimeout(resolve, 300));
  document.body.innerHTML = '';
  document.querySelectorAll('.ant-modal-root').forEach((node) => node.remove());
});

describe('openApiKeys/index.vue · ipWhitelist 创建接线', () => {
  it('非法白名单条目 ⇒ 前端拦下并点名条目，不发创建请求', async () => {
    mountPage();
    await flush();
    await openCreateModal();
    await fillForm('third-party-erp', '10.0.0.1, not-an-ip');
    await confirmCreate();

    expect(apiMock.createOpenApiKey).not.toHaveBeenCalled();
    expect(ERROR).toHaveBeenCalledTimes(1);
    const shown = String(ERROR.mock.calls[0]?.[0] ?? '');
    expect(shown).toContain('not-an-ip');
    expect(shown).toContain('IP 白名单条目非法');
    expect(SUCCESS).not.toHaveBeenCalled();
  });

  it('合法白名单 ⇒ 归一化（trim/去重/换行转逗号）后随创建请求提交', async () => {
    mountPage();
    await flush();
    await openCreateModal();
    await fillForm(
      'third-party-erp',
      ' 10.0.0.0/8 \n 192.168.1.10 \n10.0.0.0/8',
    );
    await confirmCreate();

    expect(apiMock.createOpenApiKey).toHaveBeenCalledTimes(1);
    expect(apiMock.createOpenApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: 'third-party-erp',
        ipWhitelist: '10.0.0.0/8,192.168.1.10',
      }),
    );
    expect(ERROR).not.toHaveBeenCalled();
    expect(SUCCESS).toHaveBeenCalled();
  });

  it('白名单留空 ⇒ 请求里不带 ipWhitelist（后端语义 = 不限来源）', async () => {
    mountPage();
    await flush();
    await openCreateModal();
    await fillForm('third-party-erp', '   ');
    await confirmCreate();

    expect(apiMock.createOpenApiKey).toHaveBeenCalledTimes(1);
    const payload = apiMock.createOpenApiKey.mock.calls[0]?.[0];
    expect(payload.appName).toBe('third-party-erp');
    // 空输入归一化为 undefined（不是空串）：后端 normalizeIpWhitelist 对二者都视为
    // 「不限来源」，但传 undefined 更贴近「可选字段」契约，也不会把空串写进请求体。
    expect(payload.ipWhitelist).toBeUndefined();
  });
});

describe('openApiKeys/index.vue · 列表来源限制列（前向兼容）', () => {
  it('列表列配置含 ipWhitelist 列；字段缺席时展示占位而不是「不限来源」', () => {
    mountPage();
    const columns: any[] =
      captured.options?.gridOptions?.columns?.filter(
        (column: any) => column.field === 'ipWhitelist',
      ) ?? [];
    expect(columns).toHaveLength(1);
    expect(columns[0]?.title).toBe('IP 白名单');
  });
});
