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

import Guide from './guide.vue';

/**
 * 接入向导（`onboarding/modules/guide.vue`）的失败原因与禁用态用例。
 *
 * 回归的问题（P2-10）：三处 `catch {` 没有绑定异常却引用组件的 `error` ref，
 * 导致后端真实失败原因全部丢失（`extractErrorMessage` 收到的是 ref 对象），
 * 日志里也只是 `{value: ''}`。这里用真实组件 + 桩接口锁住「后端 message 必须展示」。
 *
 * 同时锁住：第 2 步的两个按钮在「还没创建产品」时禁用，且外层有可聚焦的原因容器
 * （antd disabled 按钮不触发 mouseenter，原因 Tooltip 必须挂在 span 上）。
 */

const { apiMock, routerPush } = vi.hoisted(() => ({
  apiMock: {
    createProduct: vi.fn(),
    createProperty: vi.fn(),
    createService: vi.fn(),
    getDevicePage: vi.fn(),
    getProductPage: vi.fn(),
    publishProduct: vi.fn(),
  },
  routerPush: vi.fn(),
}));

vi.mock('#/api/iot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/api/iot')>();
  return { ...actual, ...apiMock };
});

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores, useAccessStore } = await import('@vben/stores');
  await initStores(app, { namespace: 'test' });
  // 模板里的 v-access 指令：不授权会把「用模板一键创建」按钮摘掉
  useAccessStore().setAccessCodes(['*:*:*']);
});

let mounted: undefined | { app: { unmount: () => void } };

async function flush(times = 8) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

async function mountGuide() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(Guide as never) });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await flush();
  return container;
}

function findButton(container: HTMLElement, text: string) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

/**
 * 断言式取非空值。
 *
 * 为什么不用 `!`：仓内 oxlint 禁止非空断言（typescript/no-non-null-assertion），
 * 且 `expect(...).toBeTruthy()` 不会收窄类型；这里 fail-fast 并保留可读错误信息。
 */
function must<T>(value: null | T | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

/** 后端「业务失败」信封（HTTP 200 + R.code != 200，全仓约定）。 */
function bizFailure(code: number, message: string) {
  return Object.assign(new Error(message), {
    response: { data: { code, data: null, message } },
  });
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  routerPush.mockReset();
  apiMock.getProductPage.mockResolvedValue({ items: [], total: '0' });
  apiMock.getDevicePage.mockResolvedValue({ items: [], total: '0' });
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('onboarding/modules/guide.vue 失败原因不丢失（P2-10）', () => {
  it('一键创建失败 ⇒ 原样展示后端 message（不是 ref 对象/空文案）', async () => {
    apiMock.createProduct.mockRejectedValue(
      bizFailure(50_001, '产品编码已存在：sensor-001'),
    );

    const container = await mountGuide();
    const create = must(
      findButton(container, '用模板一键创建'),
      '未渲染出「用模板一键创建」按钮',
    );
    create.click();
    await flush();

    expect(apiMock.createProduct).toHaveBeenCalledTimes(1);
    // 修复前这里展示的是 `按模板创建失败`（extractErrorMessage 收到 ref 对象 ⇒ fallback），
    // 后端真实原因「产品编码已存在」完全丢失
    expect(container.innerHTML).toContain('产品编码已存在：sensor-001');
  });

  it('发布失败 ⇒ 展示后端 message', async () => {
    apiMock.createProduct.mockResolvedValue('p-1');
    apiMock.createService.mockResolvedValue('s-1');
    apiMock.createProperty.mockResolvedValue('pm-1');
    apiMock.publishProduct.mockRejectedValue(
      bizFailure(50_002, '发布被拒绝：物模型未通过校验'),
    );

    const container = await mountGuide();
    must(
      findButton(container, '用模板一键创建'),
      '未渲染出「用模板一键创建」按钮',
    ).click();
    await flush();

    const publish = must(findButton(container, '发布'), '未渲染出「发布」按钮');
    publish.click();
    await flush();

    expect(apiMock.publishProduct).toHaveBeenCalledWith('p-1');
    expect(container.innerHTML).toContain('物模型未通过校验');
  });
});

describe('onboarding/modules/guide.vue 禁用态原因', () => {
  it('未创建产品时「查看/编辑物模型」与「发布」禁用，且外层 span 可聚焦以显示原因', async () => {
    const container = await mountGuide();

    for (const text of ['查看/编辑物模型', '发布']) {
      const button = must(
        findButton(container, text),
        `未渲染出「${text}」按钮`,
      );
      expect(button.disabled).toBe(true);
      // antd 的 disabled 按钮不触发 mouseenter ⇒ 原因提示挂在外层 span；
      // tabindex=0 保证键盘用户也能聚焦看到原因（而不是一排无法解释的灰按钮）。
      const span = must(
        button.closest('span'),
        `「${text}」外层缺少原因提示容器`,
      );
      expect(span.getAttribute('tabindex')).toBe('0');
    }
  });
});
