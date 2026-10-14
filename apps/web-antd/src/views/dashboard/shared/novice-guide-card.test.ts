import { createApp, h, nextTick } from 'vue';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import NoviceGuideCard from './novice-guide-card.vue';

/**
 * 「新手快速上手」卡片用例。
 *
 * 关注三件事：
 * 1. 三步都在，且都带「为什么」说明与直达按钮（文案走真实 i18n，顺带编译 page.dashboard.novice.*）；
 * 2. 三个跳转按钮分别落到 /iot/products、/iot/devices、/iot/onboarding（与后端菜单路径一致）；
 * 3. 帮助入口只发 `openHelp` 事件，由宿主页面打开共享的术语词典抽屉（卡片不自己造抽屉）。
 */
const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@vben/preferences', () => ({
  preferences: { app: { accessMode: 'frontend', locale: 'zh-CN' } },
  updatePreferences: () => {},
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

let app: ReturnType<typeof createApp> | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = '';
  pushMock.mockReset();
});

function mountCard(onOpenHelp: () => void = () => {}) {
  const container = document.createElement('div');
  document.body.append(container);
  app = createApp({
    render: () => h(NoviceGuideCard, { onOpenHelp }),
  });
  app.mount(container);
  return container;
}

function clickButtonByText(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(text),
  );
  expect(button, `未找到按钮：${text}`).toBeTruthy();
  button?.click();
}

describe('新手快速上手卡片', () => {
  it('三步文案与说明齐全，不出现 i18n 键名', async () => {
    const container = mountCard();
    await nextTick();
    const html = container.innerHTML;
    for (const text of [
      '新手快速上手',
      '建产品并定义物模型',
      '发布物模型',
      '添加设备并配置点位映射',
      '去建产品',
      '去发布',
      '去添加设备',
      '告警规则',
      '维护窗口',
      '术语看不懂？打开帮助',
      '需要手把手？打开接入向导',
    ]) {
      expect(html, `缺少文案：${text}`).toContain(text);
    }
    expect(html).not.toContain('page.dashboard.novice.');
  });

  it('三个跳转按钮分别去产品页 / 设备页 / 接入向导', async () => {
    const container = mountCard();
    await nextTick();

    clickButtonByText(container, '去建产品');
    expect(pushMock).toHaveBeenLastCalledWith('/iot/products');

    clickButtonByText(container, '去添加设备');
    expect(pushMock).toHaveBeenLastCalledWith('/iot/devices');

    clickButtonByText(container, '需要手把手？打开接入向导');
    expect(pushMock).toHaveBeenLastCalledWith('/iot/onboarding');
  });

  it('帮助入口只发 openHelp 事件，由宿主打开共享抽屉', async () => {
    const onOpenHelp = vi.fn();
    const container = mountCard(onOpenHelp);
    await nextTick();
    clickButtonByText(container, '术语看不懂？打开帮助');
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
  });
});
