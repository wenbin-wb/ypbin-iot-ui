import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  resolveDirective,
  withDirectives,
} from 'vue';

import { registerAccessDirective } from '@vben/access';
import { i18n } from '@vben/locales';

import DetailDebug from './detail-debug.vue';
import PanelErrorBoundary from './panel-error-boundary.vue';

/**
 * 「在线调试」页签（`detail-debug.vue`）的**运行时**组件级用例。
 *
 * 为什么必须要有这一层：typecheck / 构建 / i18n 键存在性门禁都只做静态检查，**跑不到渲染运行时**。
 * 2026-09-27 的线上事故就是从这个盲区漏出去的——`page.iot.debug.paramsPlaceholder` 等三条文案里写了
 * 字面 `{` `}`（例如 `{"arg": 1}`），vue-i18n 的消息编译器把它当成非法占位符 ⇒ **`$t(...)` 在渲染期抛
 * `SyntaxError`** ⇒ 整个页签渲染不出来（**整块空白**），而三道门禁全绿。
 *
 * 所以本用例的两条硬纪律：
 *
 * 1. **绝不 mock `#/locales`**：必须用真实 vue-i18n 实例（`setupI18n` + 真实语言包），
 *    消息编译错误才会在这里暴露。用桩 `$t` 的用例**结构性地抓不到这类 bug**（上一版就是这么漏的）。
 * 2. **断言真实中文文案**：空态就是「暂无指令记录」、失败态就是后端 message 原文——
 *    「空白」在断言里等价于失败，不允许再出现。
 *
 * 本仓未引入 `@vue/test-utils`，故用 `createApp(...).mount()` 直接挂真实 DOM（happy-dom）。
 * 只替换网络层与权限码来源，其余（antdv 组件、`v-access` 指令、`use-access` 判定、i18n）全部走真实实现。
 */

const { accessStore, deviceRow, drawerCalls, mockGet, mockPost } = vi.hoisted(
  () => ({
    /**
     * 权限码桩的**响应式**代理（由下面的 `@vben/stores` 工厂填充）。
     *
     * 为什么必须响应式：生产里 `accessCodes` 存在 pinia（响应式），而
     * `computed(() => hasAccessByCodes([...]))` 的失效通知**只对响应式读取生效**。
     * 用普通对象 `{ accessCodes: codes }` 当桩，computed 读到的属性永远不会被追踪 ⇒
     * 「权限码迟到/运行期变化」这类缺陷**结构性地抓不到**（教训二十七：桩装错了，
     * 断言就成了恒真的装饰）。这里让桩与生产同构。
     */
    accessStore: { current: null as null | { accessCodes: string[] } },
    deviceRow: {
      deviceCode: 'demo-dev-curve',
      deviceName: '演示-设备-历史曲线',
      id: '9300012',
      onlineStatus: 'online',
      productId: '9100001',
      productVersion: 'v1.0',
    },
    drawerCalls: [] as any[],
    mockGet: vi.fn(),
    mockPost: vi.fn(),
  }),
);

vi.mock('#/api/request', () => ({
  requestClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
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

/** 设置权限码：写**响应式代理**（与生产同一条路径），不能改原始对象。 */
function setCodes(codes: string[]) {
  if (!accessStore.current) {
    throw new Error('accessStore 桩未初始化：@vben/stores 还没被 import');
  }
  accessStore.current.accessCodes = codes;
}

vi.mock('@vben/preferences', () => ({
  preferences: { app: { accessMode: 'frontend', locale: 'zh-CN' } },
  updatePreferences: () => {},
}));

/** 抽屉容器与 `useVbenDrawer` 的桩：只为把真实 `detail.vue` 挂起来并触发打开流程。 */
vi.mock('@vben/common-ui', () => ({
  useVbenDrawer: (options: Record<string, unknown>) => {
    drawerCalls.push(options);
    const api = {
      getData: () => deviceRow,
      open: vi.fn(),
      setData: vi.fn(),
      setState: vi.fn(),
    };
    const Stub = defineComponent({
      name: 'DrawerStub',
      setup: (_props, { slots }) => () => h('div', { class: 'drawer-stub' }, slots.default?.()),
    });
    return [Stub, api];
  },
}));

/** 真实 i18n 实例：只初始化一次（`$t` 就是 `i18n.global.t`）。 */
beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

/** 后端「业务失败」信封（HTTP 200 + `R.code != 200`，全仓约定）。 */
function bizFailure(code: number, message: string) {
  return Object.assign(new Error(message), {
    response: { data: { code, data: null, message } },
  });
}

/**
 * 递归收集**字符串叶子**键：**复用门禁脚本的实现**（`scripts/check-i18n-message-compile.mjs`），
 * 不在测试里再抄一份。
 *
 * 为什么必须递归（而不是只迭代一层）：`page.iot` 下的中间节点是命名空间对象（如 `debug`），
 * vue-i18n 对对象只会打一条 `[intlify] Not found` 而**不编译** ⇒ 门禁看似跑了实则空转
 * （教训八：0 违规可能是「没跑到」）。真实叶子键 400+ 个。
 *
 * 「口径只有一处」的实际意义：测试与 CI 门禁若各写一份遍历，两者对「叶子」的理解迟早漂移，
 * 于是出现「测试绿、CI 绿、线上红」。
 */
const { collectLeafKeys } = await import(
  '../../../../../../../scripts/check-i18n-message-compile.mjs'
);

/** 后端分页响应（`PageResult`，`total/page/pageSize` 都是字符串——后端 Long 序列化口径）。 */
function page(items: unknown[], total = items.length) {
  return { items, page: '1', pageSize: '10', pages: '1', total: String(total) };
}

/** 真实生产返回（`GET /iot/devices/9300012/commands`，2026-09-27 实测原样；这里取 1 条 failed + 1 条 succeeded）。 */
const REAL_FAILED_ROW = {
  createTime: '2026-09-27 20:26:19',
  deviceId: '9300012',
  emqxMessageId: null,
  errorCode: 'NO_SUBSCRIBER',
  errorMsg: '设备未连接（无订阅者）',
  finishedAt: '2026-09-27 20:26:19',
  id: '2104185866736365571',
  identifier: 'switchState',
  kind: 'property_set',
  operatorUserId: '1',
  payload:
    '{"requestId":"cmd-2104185866736365570","properties":{"switchState":26.5}}',
  replyPayload: null,
  requestId: 'cmd-2104185866736365570',
  retryCount: 0,
  sentAt: null,
  source: 'console',
  statusCode: 'failed',
  timeoutMs: 6000,
  topic: 'ypbin/v1/1/9300012/down/property/set',
};

const REAL_SUCCEEDED_ROW = {
  createTime: '2026-09-27 20:25:44',
  deviceId: '9300012',
  emqxMessageId: '00065C760C73D0E41F6D0000242A0000',
  errorCode: null,
  errorMsg: null,
  finishedAt: '2026-09-27 20:25:44',
  id: '2104185719059116034',
  identifier: 'switchState',
  kind: 'property_set',
  operatorUserId: '1',
  payload:
    '{"requestId":"cmd-2104185719038144513","properties":{"switchState":26.5}}',
  replyPayload:
    '{"deviceId":9300012,"requestId":"cmd-2104185719038144513","code":0,"message":"ok","data":{"applied":26.5},"ts":1790511944141,"receivedAt":"2026-09-27T20:25:44.391521557"}',
  requestId: 'cmd-2104185719038144513',
  retryCount: 0,
  sentAt: '2026-09-27 20:25:44',
  source: 'console',
  statusCode: 'succeeded',
  timeoutMs: 6000,
  topic: 'ypbin/v1/1/9300012/down/property/set',
};

/** 网络桩：只接历史列表与本页用到的物模型接口，其余返回空。 */
function stubApi(history: () => Promise<unknown>) {
  mockGet.mockImplementation((url: string) => {
    if (url.includes('/commands') && url.includes('/devices/')) {
      return history();
    }
    return Promise.resolve([]);
  });
}

async function flush(times = 6) {
  for (let index = 0; index < times; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

/** 挂载被测组件（可选第三参用于包一层插槽内容，测错误边界时用）。 */
function mountWith(
  component: unknown,
  props: Record<string, unknown> = {},
  slot?: () => unknown,
) {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({
    render: () =>
      h(
        component as never,
        props,
        slot
          ? { default: () => slot() as never }
          : undefined,
      ),
  });
  registerAccessDirective(app);
  app.mount(container);
  return { app, container };
}

let mounted: undefined | { app: ReturnType<typeof mountWith>['app'] };

beforeEach(() => {
  setCodes(['*:*:*']);
  mockGet.mockReset();
  mockPost.mockReset();
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('在线调试页签：i18n 文案必须能编译（本次线上空白事故的回归门禁）', () => {
  it.each(['zh-CN', 'en-US'])(
    '%s：page.iot.* 每条文案都能被 vue-i18n 编译，且字面花括号按原样渲染',
    async (lang) => {
      const mod = (await import(`#/locales/langs/${lang}/page.json`)) as {
        default?: Record<string, unknown>;
      };
      const pageDict = (mod.default ?? mod) as { iot: Record<string, unknown> };
      // 与生产同源的合并方式（命名空间 = 文件名）
      i18n.global.mergeLocaleMessage(lang, { page: pageDict });
      const previous = i18n.global.locale.value;
      try {
        i18n.global.locale.value = lang as never;
        const t = i18n.global.t as (key: string) => string;

        const failures: string[] = [];
        const leafKeys = collectLeafKeys(pageDict.iot, 'page.iot');
        // 自检：叶子键数量必须像话，否则说明遍历又退化成空转（教训八）
        expect(leafKeys.length).toBeGreaterThan(400);
        for (const key of leafKeys) {
          try {
            t(key);
          } catch (error) {
            failures.push(`${key}: ${(error as Error).message.split('\n')[0]}`);
          }
        }
        expect(failures).toEqual([]);

        // 逃逸写法要产出**字面**花括号，而不是把 `{'{'}` 原样打给用户
        expect(t('page.iot.debug.paramsPlaceholder')).toBe('{"arg": 1}');
        expect(t('page.iot.debug.valueHint')).toContain('{"a":1}');
        expect(t('page.iot.debug.paramsInvalid')).toContain('{"arg": 1}');
        expect(t('page.iot.debug.paramsInvalid')).not.toContain("{'{'}");
      } finally {
        i18n.global.locale.value = previous;
      }
    },
  );
});

describe('detail-debug.vue 运行时（真实 i18n + 真实 antdv + 真实权限指令）', () => {
  it('挂载不抛错，且加载完成后渲染下发表单（setup/render 期不得异常）', async () => {
    stubApi(() => Promise.resolve(page([])));
    const handle = mountWith(DetailDebug, {
      deviceId: '9300012',
      productId: '9100001',
    });
    mounted = handle;
    await flush();

    const html = handle.container.innerHTML;
    expect(html).toContain('下发指令');
    expect(html).toContain('属性设置');
    // 默认分支就带着那条曾经炸掉整页的 valueHint
    expect(html).toContain('{"a":1}');
  });

  it('空列表 ⇒ 明确显示「暂无指令记录」空态（不得空白）', async () => {
    stubApi(() => Promise.resolve(page([])));
    const handle = mountWith(DetailDebug, {
      deviceId: '9300012',
      productId: '9100001',
    });
    mounted = handle;
    await flush();

    const html = handle.container.innerHTML;
    expect(html).toContain('下发与回执记录');
    expect(html).toContain('暂无指令记录');
    expect(html).not.toContain('指令记录查询失败');
  });

  it('未选设备 ⇒ 也必须是空态而不是空白（historyLoaded 不能被漏置）', async () => {
    stubApi(() => Promise.resolve(page([])));
    const handle = mountWith(DetailDebug, { deviceId: '', productId: '' });
    mounted = handle;
    await flush();

    const html = handle.container.innerHTML;
    expect(html).toContain('暂无指令记录');
  });

  it('查询失败（HTTP 200 + code!=200）⇒ 原样展示后端 message，绝不画成空态', async () => {
    const backendMessage = 'IoT 指令记录查询被拒绝：无 iot:debug:get 权限';
    stubApi(() => Promise.reject(bizFailure(40_303, backendMessage)));
    const handle = mountWith(DetailDebug, {
      deviceId: '9300012',
      productId: '9100001',
    });
    mounted = handle;
    await flush();

    const html = handle.container.innerHTML;
    expect(html).toContain(backendMessage);
    expect(html).toContain('40303');
    expect(html).not.toContain('暂无指令记录');
  });

  it('查询失败（HTTP 500，无业务信封）⇒ 仍然是失败态而不是空态', async () => {
    stubApi(() =>
      Promise.reject(new Error('Request failed with status code 500')),
    );
    const handle = mountWith(DetailDebug, {
      deviceId: '9300012',
      productId: '9100001',
    });
    mounted = handle;
    await flush();

    const html = handle.container.innerHTML;
    expect(html).toContain('Request failed with status code 500');
    expect(html).not.toContain('暂无指令记录');
  });

  it('真实生产数据（failed + succeeded）⇒ 正常出表并显示失败原因人话', async () => {
    stubApi(() =>
      Promise.resolve(page([REAL_FAILED_ROW, REAL_SUCCEEDED_ROW], 17)),
    );
    const handle = mountWith(DetailDebug, {
      deviceId: '9300012',
      productId: '9100001',
    });
    mounted = handle;
    await flush();

    const html = handle.container.innerHTML;
    expect(html).toContain('switchState');
    expect(html).toContain('失败');
    expect(html).toContain('成功');
    // 失败原因码给人话（`NO_SUBSCRIBER` → 「设备未连接(无订阅者)」）
    expect(html).toContain('设备未连接(无订阅者)');
    expect(html).not.toContain('暂无指令记录');
    // 失败态可重发（按钮文案就是「重发同一请求」）
    expect(html).toContain('重发同一请求');
  });

  it('超管通配码 `*:*:*` 放行：历史区块与下发按钮都不被 v-access 摘掉', async () => {
    setCodes(['*:*:*']);
    stubApi(() => Promise.resolve(page([])));
    const handle = mountWith(DetailDebug, {
      deviceId: '9300012',
      productId: '9100001',
    });
    mounted = handle;
    await flush();

    const html = handle.container.innerHTML;
    expect(html).toContain('下发与回执记录');
    expect(html).toContain('下发');
  });

  it('无 `iot:debug:get` 且无通配码 ⇒ 历史区块隐藏（门禁仍然有效，不是恒真断言）', async () => {
    setCodes(['iot:device:list']);
    stubApi(() => Promise.resolve(page([])));
    const handle = mountWith(DetailDebug, {
      deviceId: '9300012',
      productId: '9100001',
    });
    mounted = handle;
    await flush();

    const html = handle.container.innerHTML;
    expect(html).not.toContain('下发与回执记录');
    // 下发区仍在（它的门禁是 send，不是 get）
    expect(html).toContain('下发指令');
  });

  it('后端 `total` 是字符串 ⇒ 分页仍拿到 number（否则 antdv 报 prop 类型告警）', async () => {
    // 后端真实返回 `{"total":"17",...}`；这里断言「进分页组件前已经转成数字」这件事
    // **真的发生了**——仅靠渲染结果看不出来（`"17"` 会被隐式转），必须盯 prop 类型告警。
    const messages: string[] = [];
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation((...args: unknown[]) => {
        messages.push(args.map((a) => String(a)).join(' '));
      });
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        messages.push(args.map((a) => String(a)).join(' '));
      });
    try {
      stubApi(() => Promise.resolve(page([REAL_SUCCEEDED_ROW], 17)));
      const handle = mountWith(DetailDebug, {
        deviceId: '9300012',
        productId: '9100001',
      });
      mounted = handle;
      await flush();

      expect(handle.container.querySelector('.ant-pagination')).toBeTruthy();
      const propComplaints = messages.filter(
        (message) =>
          message.includes('Invalid prop') ||
          message.includes('type check failed'),
      );
      expect(propComplaints).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

/**
 * 权限码**迟到 / 运行期变化**时的行为对照。
 *
 * 上游 `packages/effects/access/src/directive.ts` 的 `v-access` 只注册了 `mounted`、
 * **没有 `updated`**，且无权限时执行 `el.remove()`（不可逆）——本仓不改上游，只如实登记，
 * 并在本项目自己的关键区块上改用 `computed + v-if` 防御。
 *
 * 这组用例同时钉住两件事：**上游缺陷确实存在**（否则我们的防御是多余的），
 * 且**我们的防御真的解决了它**（否则防御是装饰）。
 */
describe('权限码迟到/变化：v-access 不会重算（上游缺陷登记）vs computed + v-if 会重算（本项目防御）', () => {
  /** 忠实复刻 `v-access:code="['iot:debug:get']"` 的运行时形态（`h()` 里手动挂指令）。 */
  const LegacyAccessBlock = defineComponent({
    name: 'LegacyAccessBlock',
    setup() {
      const directive = resolveDirective('access');
      return () =>
        withDirectives(h('div', { class: 'legacy-block' }, 'LEGACY-BLOCK'), [
          [directive as never, ['iot:debug:get'], 'code'],
        ]);
    },
  });

  it('v-access：先无权限、后补权限 ⇒ 区块**永远回不来**（缺 `updated` + `el.remove()` 不可逆）', async () => {
    setCodes([]);
    const handle = mountWith(LegacyAccessBlock);
    mounted = handle;
    await flush(2);
    expect(handle.container.innerHTML).not.toContain('LEGACY-BLOCK');

    // 权限码迟到：例如异步拉到、或运行期变化
    setCodes(['iot:debug:get']);
    await flush(2);
    expect(handle.container.innerHTML).not.toContain('LEGACY-BLOCK');
  });

  it('v-access：先有权限、后撤权限 ⇒ 区块**仍然可见**（同样因为没有 `updated`）', async () => {
    setCodes(['iot:debug:get']);
    const handle = mountWith(LegacyAccessBlock);
    mounted = handle;
    await flush(2);
    expect(handle.container.innerHTML).toContain('LEGACY-BLOCK');

    setCodes([]);
    await flush(2);
    // 已渲染的元素不会被撤下：权限被收回后界面仍在放行入口（比「消失」更危险的方向）
    expect(handle.container.innerHTML).toContain('LEGACY-BLOCK');
  });

  it('本项目防御（computed + v-if）：权限码到位后历史区块**自动出现**', async () => {
    setCodes(['iot:device:list']);
    stubApi(() => Promise.resolve(page([])));
    const handle = mountWith(DetailDebug, {
      deviceId: '9300012',
      productId: '9100001',
    });
    mounted = handle;
    await flush();
    expect(handle.container.innerHTML).not.toContain('下发与回执记录');

    setCodes(['iot:device:list', 'iot:debug:get']);
    await flush(2);
    expect(handle.container.innerHTML).toContain('下发与回执记录');
  });

  it('本项目防御（computed + v-if）：权限被收回后历史区块**自动消失**', async () => {
    setCodes(['iot:device:list', 'iot:debug:get']);
    stubApi(() => Promise.resolve(page([])));
    const handle = mountWith(DetailDebug, {
      deviceId: '9300012',
      productId: '9100001',
    });
    mounted = handle;
    await flush();
    expect(handle.container.innerHTML).toContain('下发与回执记录');

    setCodes(['iot:device:list']);
    await flush(2);
    expect(handle.container.innerHTML).not.toContain('下发与回执记录');
  });
});

describe('页签渲染错误边界（panel-error-boundary.vue）', () => {
  const Exploding = defineComponent({
    name: 'ExplodingPanel',
    setup() {
      return () => {
        throw new Error('模拟渲染期异常：i18n SyntaxError 之类');
      };
    },
  });

  it('后代 render 抛错时用 Alert 原样展示错误，而不是留一片空白', async () => {
    const handle = mountWith(PanelErrorBoundary, {}, () => h(Exploding));
    mounted = handle;
    await flush(2);

    const html = handle.container.innerHTML;
    expect(html).toContain('在线调试页渲染失败');
    expect(html).toContain('模拟渲染期异常');
  });

  it('边界不得掐断全局上报通道：`app.config.errorHandler`（埋点）仍必须收到该异常', async () => {
    // 2026-09-27 这次空白事故就是靠 app.errorHandler → 埋点 sys_track_event 定位的；
    // 若在 onErrorCaptured 里 `return false`，Vue 的 handleError 会直接 return，
    // 全局 errorHandler 不再被调用 ⇒ 白屏变成「无声白屏」。
    const reported: unknown[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const app = createApp({
      render: () => h(PanelErrorBoundary, null, { default: () => h(Exploding) }),
    });
    app.config.errorHandler = (error) => {
      reported.push(error);
    };
    app.mount(container);
    mounted = { app };
    await flush(2);

    // 🔴 必须是**恰好一次**：`toBeGreaterThan(0)` 是弱断言——重复上报（例如边界与全局
    // errorHandler 各报一次，埋点会翻倍）同样满足，等于放走了「一次异常报两条」的缺陷。
    // 验收判据是「上报通道没被掐断，且不重复」。
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).message).toContain('模拟渲染期异常');
    // 同时仍然渲染了 Alert（两件事不能互相排斥）
    expect(container.innerHTML).toContain('在线调试页渲染失败');
  });

  it('无错误时只渲染插槽内容（不吞掉正常渲染）', async () => {
    const handle = mountWith(
      PanelErrorBoundary,
      {},
      () => h('div', { class: 'ok-panel' }, 'NORMAL'),
    );
    mounted = handle;
    await flush(2);

    expect(handle.container.innerHTML).toContain('NORMAL');
    expect(handle.container.innerHTML).not.toContain('在线调试页渲染失败');
  });
});

describe('detail.vue 接线（第 5 个页签）+ 真机形态的空白事故复现', () => {
  /** 概览页签用到的接口全部给空/最小实现，避免干扰调试页签。 */
  function stubAllApis() {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) {
        return Promise.resolve(page([]));
      }
      if (url.includes('/services')) {
        return Promise.resolve([]);
      }
      if (url.includes('/latest')) {
        return Promise.resolve([]);
      }
      if (url.includes('/availability')) {
        return Promise.resolve({
          availability: '0.9999',
          outageCount: 0,
          outageSeconds: 0,
          outages: [],
        });
      }
      if (url.includes('/shadow')) {
        return Promise.resolve({});
      }
      if (url.includes('/events')) {
        return Promise.resolve(page([]));
      }
      return Promise.resolve({});
    });
  }

  /** 打开真实 `detail.vue` 抽屉并切到「在线调试」页签，返回容器。 */
  async function openDebugTab() {
    stubAllApis();
    drawerCalls.length = 0;
    const container = document.createElement('div');
    document.body.append(container);
    const mod = await import('./detail.vue');
    const app = createApp({ render: () => h(mod.default as never) });
    registerAccessDirective(app);
    app.mount(container);
    await flush(2);

    const opened = drawerCalls.find(
      (options) => typeof options?.onOpenChange === 'function',
    );
    expect(opened, 'useVbenDrawer(onOpenChange) 未被调用').toBeTruthy();
    await opened.onOpenChange(true);
    await flush();

    const tabs = [
      ...container.querySelectorAll('.ant-tabs-tab'),
    ] as HTMLElement[];
    expect(tabs.map((tab) => tab.textContent?.trim())).toContain('在线调试');
    const debugTab = tabs.find((tab) => tab.textContent?.includes('在线调试'));
    debugTab?.click();
    await flush();

    mounted = { app };
    return container;
  }

  /** 还原真实语言包（防止把坏消息泄漏给其它用例）。 */
  async function restoreMessages() {
    const mod = (await import('#/locales/langs/zh-CN/page.json')) as {
      default?: Record<string, unknown>;
    };
    i18n.global.mergeLocaleMessage('zh-CN', {
      page: mod.default ?? mod,
    } as never);
    i18n.global.locale.value = 'zh-CN' as never;
  }

  afterEach(async () => {
    await restoreMessages();
  });

  it('页签存在且内容渲染（canViewDebug 门禁 + TabPane 接线正确）', async () => {
    const container = await openDebugTab();
    const pane = container.querySelector('.ant-tabs-tabpane-active');
    expect(pane, '没有 active 页签面板').toBeTruthy();
    const html = pane?.innerHTML ?? '';
    expect(html).toContain('下发指令');
    expect(html).toContain('暂无指令记录');
  });

  it('真机形态复现：把坏文案（字面 `{"a":1}`）塞回去 ⇒ 页面**不许空白**，边界必须给出 Alert', async () => {
    // 复现 2026-09-27 的线上根因：valueHint 在默认分支（property_set）**首屏就会渲染**
    i18n.global.mergeLocaleMessage('zh-CN', {
      page: { iot: { debug: { valueHint: '{"a":1}' } } },
    } as never);
    i18n.global.locale.value = 'zh-CN' as never;

    const container = await openDebugTab();
    const html = container.innerHTML;
    // 关键：不是空白，而是可读的失败态（含完整错误）
    expect(html).toContain('在线调试页渲染失败');
    expect(html).toContain('Message compilation error');
    expect(html).toContain('Invalid token in placeholder');
  });
});
