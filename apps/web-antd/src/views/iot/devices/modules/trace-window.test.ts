import { createApp, h, nextTick } from 'vue';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import TraceTab from './trace.vue';
import traceSource from './trace.vue?raw';

/**
 * 「消息跟踪」时间窗格式回归用例（审查 P0-3）。
 *
 * ## 为什么必须在这一层守
 *
 * 后端 `DeviceTraceQuery.from/to` 是 `LocalDateTime` 且**没有** `@DateTimeFormat`；
 * 同仓 availability/maintenance 端点都显式写了 `pattern="yyyy-MM-dd HH:mm:ss"`，唯独 trace 漏了。
 * 前端原先用 `Date#toISOString()`（尾随 `Z`）⇒ Spring 默认 `ISO_LOCAL_DATE_TIME` 解析失败 ⇒
 * **每次查询稳定 400**，整条能力不可用。
 *
 * 这个缺陷此前一直漏过门禁，原因是：`trace-state.test.ts` 全量 mock 了 api 层，
 * 「页面传了什么串」从来没被断言过（`api/iot/api-contract.test.ts` 只能锁 api 层的透传契约，
 * 锁不住调用方格式）。所以这里**挂真实组件**、断言 `getDeviceTrace` 实际收到的参数。
 *
 * ## 断言口径
 *
 * 1. `from`/`to` 必须形如 `yyyy-MM-dd HH:mm:ss`，且**不得**带 `Z`/`T`；
 * 2. 窗口长度必须等于所选档位（默认 1 小时）——只锁格式不锁语义的话，
 *    把窗口算错（比如漏乘 60）同样会让用户看到「最近 1 分钟」；
 * 3. 刷新按钮走同一条格式化路径；
 * 4. 源码级 tripwire：不得再出现 `toISOString()`（防止回退）。
 */

const { mockGetTrace } = vi.hoisted(() => ({
  mockGetTrace: vi.fn(),
}));

vi.mock('#/api/iot', () => ({
  getDeviceTrace: (...args: unknown[]) => mockGetTrace(...args),
}));

/** 后端 `LocalDateTime`（无 `@DateTimeFormat`）唯一可接受的格式。 */
const TRACE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 默认窗口档位（trace.vue 的 `windowHours` 初值 = 1 小时）。 */
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

let mounted: undefined | { app: { unmount: () => void } };

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

beforeEach(() => {
  mockGetTrace.mockReset();
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

async function mountTrace() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({
    render: () => h(TraceTab as never, { deviceId: '9300012' }),
  });
  app.mount(container);
  mounted = { app };
  await flush();
  return container;
}

function refreshButton(container: HTMLElement) {
  // antd 会在两个中文字之间插入空格（渲染成「刷 新」）⇒ 用正则去掉空白再匹配
  return [...container.querySelectorAll('button')].find((button) =>
    /刷新/.test((button.textContent ?? '').replaceAll(/\s+/g, '')),
  ) as HTMLButtonElement | undefined;
}

describe('消息跟踪时间窗（P0-3 回归）', () => {
  it('🔴 首次加载：from/to 必须是 yyyy-MM-dd HH:mm:ss（不是带 Z 的 ISO 串）', async () => {
    mockGetTrace.mockResolvedValue({ items: [] });
    await mountTrace();

    expect(mockGetTrace).toHaveBeenCalledTimes(1);
    const [deviceId, query] = mockGetTrace.mock.calls[0] as [
      string,
      { from: string; to: string },
    ];
    expect(deviceId, 'deviceId 必须原样进入路径参数').toBe('9300012');
    expect(
      query.from,
      'from 必须是 yyyy-MM-dd HH:mm:ss —— 带 Z 的 ISO 串会让后端 LocalDateTime 解析失败（400）',
    ).toMatch(TRACE_TIME_RE);
    expect(query.to).toMatch(TRACE_TIME_RE);
    // 明确锁死旧写法：toISOString() 的产物含 T/Z，后端不接受
    for (const value of [query.from, query.to]) {
      expect(value).not.toContain('T');
      expect(value).not.toContain('Z');
    }
  });

  it('窗口长度必须等于档位（默认最近 1 小时），而不是被格式化成同一时刻', async () => {
    mockGetTrace.mockResolvedValue({ items: [] });
    await mountTrace();

    const [, query] = mockGetTrace.mock.calls[0] as [
      string,
      { from: string; to: string },
    ];
    // 两个串都是「本机时区无时区标记」的本地时间，用同口径构造 Date 再比差值
    const fromMs = new Date(query.from.replace(' ', 'T')).getTime();
    const toMs = new Date(query.to.replace(' ', 'T')).getTime();
    expect(Number.isFinite(fromMs)).toBe(true);
    expect(Number.isFinite(toMs)).toBe(true);
    expect(toMs - fromMs).toBe(DEFAULT_WINDOW_MS);
  });

  it('刷新按钮走同一条格式化路径（不会有一处忘了改）', async () => {
    mockGetTrace.mockResolvedValue({ items: [] });
    const container = await mountTrace();
    expect(mockGetTrace).toHaveBeenCalledTimes(1);

    refreshButton(container)?.click();
    await flush();

    expect(mockGetTrace).toHaveBeenCalledTimes(2);
    const [, query] = mockGetTrace.mock.calls[1] as [
      string,
      { from: string; to: string },
    ];
    expect(query.from).toMatch(TRACE_TIME_RE);
    expect(query.to).toMatch(TRACE_TIME_RE);
  });

  it('源码 tripwire：不得回退到 toISOString() 调用（它是本次 400 的根因）', () => {
    // 只锁「调用」：注释里提到 `Date#toISOString()` 说明原因不算回退
    expect(traceSource).not.toMatch(/\.toISOString\(\)/);
  });
});
