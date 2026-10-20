import { createApp, defineComponent, h, nextTick } from 'vue';

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

import Credential from './credential.vue';

/**
 * 设备凭据区块「重置签发」二次确认 + 防连点用例（审查 P1-7）。
 *
 * ## 为什么必须有
 *
 * 后端语义（`DeviceCredentialController`）：「签发或轮换设备凭据……**旧口令随即失效**」。
 * 一次误点 → 现场设备立即认证失败掉线，且运维往往不知道是刚才点了重签。
 * 后端 `@Idempotent` 只能挡 5s 内的重复请求，挡不住「界面显示口令 A、库里生效口令 B」的窗口。
 *
 * 断言口径（按用户真实操作路径，不直接调内部函数）：
 * 1. 重签按钮必须由 `Popconfirm` 包裹，**点击按钮本身不得发请求**；
 * 2. Popconfirm 文案必须讲清「旧口令立即失效」；
 * 3. 确认后只发**一次**请求；请求在途时再触发确认被短路（防连点）；
 * 4. 首次签发（`state === 'none'`，无旧口令可失效）不套确认，直接签发。
 */

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    getDeviceConnection: vi.fn(),
    getDeviceCredential: vi.fn(),
    issueDeviceCredential: vi.fn(),
    revokeDeviceCredential: vi.fn(),
  },
}));

/**
 * 聚合器用**部分 mock**（importOriginal）：只替换本组件用到的四个端点，
 * 其余导出保持真实——否则「别人的代码缺导出」会把本用例打红（那是替身缺陷，不是被测缺陷）。
 */
vi.mock('#/api/iot', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDeviceConnection: (...args: unknown[]) =>
      mockApi.getDeviceConnection(...args),
    getDeviceCredential: (...args: unknown[]) =>
      mockApi.getDeviceCredential(...args),
    issueDeviceCredential: (...args: unknown[]) =>
      mockApi.issueDeviceCredential(...args),
    revokeDeviceCredential: (...args: unknown[]) =>
      mockApi.revokeDeviceCredential(...args),
  };
});

vi.mock('@vben/stores', async () => {
  const { reactive } = await import('vue');
  return {
    useAccessStore: () => reactive({ accessCodes: ['*:*:*'] }),
    useUserStore: () => reactive({ userRoles: [] }),
  };
});

vi.mock('@vben/preferences', () => ({
  preferences: { app: { accessMode: 'frontend', locale: 'zh-CN' } },
  updatePreferences: () => {},
}));

/** 桩 copy-text：本用例不关心剪贴板，只避免挂载真实组件的副作用。 */
vi.mock('../../shared/copy-text.vue', () => ({
  default: defineComponent({
    name: 'CopyTextStub',
    setup: () => () => null,
  }),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  for (const fn of Object.values(mockApi)) {
    fn.mockReset();
  }
  mockApi.getDeviceConnection.mockResolvedValue({});
  mounted = undefined;
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

async function mountCredential() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({
    render: () => h(Credential as never, { deviceId: '9300012' }),
  });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await flush();
  return container;
}

/** 沿 Vue 内部组件链找指定名字的祖先组件（Popconfirm 浮层懒挂载，查 DOM 不可靠）。 */
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

function reissueButton(container: HTMLElement) {
  return container.querySelector(
    '[data-testid="credential-reissue"]',
  ) as HTMLButtonElement | null;
}

describe('设备凭据：重置签发二次确认（P1-7）', () => {
  it('🔴 已签发态：重签由 Popconfirm 包裹，点按钮本身不发请求', async () => {
    mockApi.getDeviceCredential.mockResolvedValue({
      credentialVersion: 2,
      issued: true,
      valid: true,
      username: 'dev-9300012',
    });
    mockApi.issueDeviceCredential.mockResolvedValue({
      password: 'secret',
      username: 'dev-9300012',
    });
    const container = await mountCredential();

    const button = reissueButton(container);
    expect(button, '已签发态必须渲染「重置签发」按钮').toBeTruthy();
    const popconfirm = findAncestorComponent(button as Element, 'Popconfirm');
    expect(
      popconfirm,
      '重置签发必须由 Popconfirm 包裹（旧口令随即失效）',
    ).toBeTruthy();
    // 文案必须讲清后果（i18n 未合并时回落 key，同样可识别）
    expect(String(componentProp(popconfirm, 'title') ?? '')).toMatch(
      /旧口令|reissueConfirm/,
    );

    // 点按钮本身：只打开确认层，绝不发请求
    button?.click();
    await flush();
    expect(mockApi.issueDeviceCredential).not.toHaveBeenCalled();
  });

  it('确认后只发一次请求；在途时再次确认被短路（防连点）', async () => {
    mockApi.getDeviceCredential.mockResolvedValue({
      credentialVersion: 1,
      issued: true,
      valid: true,
      username: 'dev-9300012',
    });
    let resolveIssue: (value: unknown) => void = () => {};
    mockApi.issueDeviceCredential.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIssue = resolve;
        }),
    );
    const container = await mountCredential();

    const popconfirm = findAncestorComponent(
      reissueButton(container) as Element,
      'Popconfirm',
    );
    // 连续触发两次确认（等价用户快速双击「确定」）
    triggerConfirm(popconfirm);
    triggerConfirm(popconfirm);
    await flush();
    expect(mockApi.issueDeviceCredential).toHaveBeenCalledTimes(1);

    resolveIssue({ password: 'p', username: 'u' });
    await flush();
    expect(mockApi.issueDeviceCredential).toHaveBeenCalledTimes(1);
  });

  it('首次签发（state=none）不套确认：没有旧口令可失效，多一次点击只是打扰', async () => {
    mockApi.getDeviceCredential.mockResolvedValue({ issued: false });
    const container = await mountCredential();

    const buttons = [...container.querySelectorAll('button')];
    const issueButton = buttons.find((button) =>
      (button.textContent ?? '').includes('签发'),
    );
    expect(issueButton, '首次签发按钮必须渲染').toBeTruthy();
    expect(
      findAncestorComponent(issueButton as Element, 'Popconfirm'),
      '首次签发不应弹二次确认',
    ).toBeNull();
  });
});
