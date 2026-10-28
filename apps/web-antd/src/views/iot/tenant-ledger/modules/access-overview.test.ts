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

import { PENDING_TEXT } from '../../shared/display';
import AccessOverview from './access-overview.vue';

/**
 * 接入侧只读概览（`tenant-ledger/modules/access-overview.vue`）的行为用例。
 *
 * 该文件在文件头写了两条硬要求，本用例逐条锁住：
 * 1. **字段诚实性**：`metrics.reported=false`（access 未上报）时指标区**不许渲染 0**，
 *    必须显示占位；`0` 只能是「已上报且为零」才有意义；
 * 2. Long 序列化：计数字段可能是 `number|string`，统一转文本、不丢精度；
 * 另外覆盖：租约存活性文案（无租约/续约中/已过期）、上报滞后阈值（45s）判定、
 * 加载失败要看得见、刷新按钮真的重新拉取。
 *
 * 说明：`tenant-ledger/index.vue`（页壳）已由同目录 `index.test.ts` 覆盖（默认页签 + 切换）；
 * `modules/ledger.vue` 由 `devices/list-states.test.ts` 覆盖三态；本文件补的是第三个缺口。
 */

const { mockApi } = vi.hoisted(() => ({
  mockApi: { getAccessOverview: vi.fn() },
}));

// 组件是从 `#/api/iot/accessOverview` 直接引这个函数的（不是从 `#/api/iot` 桶导出）
vi.mock('#/api/iot/accessOverview', () => ({
  getAccessOverview: (...args: unknown[]) => mockApi.getAccessOverview(...args),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

function bizFailure(code: number, message: string) {
  return Object.assign(new Error(message), {
    response: { data: { code, data: null, message } },
  });
}

/** 一份结构完整的概览；默认 reported=false（未上报），计数字段故意用 Long 字符串形态。 */
function overview(
  overrides: Record<string, any> = {},
  metrics: Record<string, any> = {},
) {
  return {
    metrics: {
      egressPendingCount: '0',
      nodeFencedCount: '0',
      reconcileDeferredCount: '777',
      reconcileDurationMaxMs: '1',
      renewFailureCount: '0',
      reported: false,
      reportLagMs: '1200',
      selfFencedCount: '0',
      specLoadDurationMaxMs: '2',
      tickDurationMaxMs: '3',
      ...metrics,
    },
    nodes: [],
    ...overrides,
  };
}

/**
 * Descriptions 的「标签 → 值」映射。
 *
 * ⚠️ antd v4 的 `bordered` Descriptions 渲染成**表格**：`th.ant-descriptions-item-label`
 * 与 `td.ant-descriptions-item-content` 成对（同排一行里有 `:column` 组），
 * 不是 div 版实现 —— 按行把 th/td 依次配对最稳。
 */
function metricMap(container: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of container.querySelectorAll('.ant-descriptions-row')) {
    const labels = [...row.querySelectorAll('th')].map(
      (th) => th.textContent?.trim() ?? '',
    );
    const values = [...row.querySelectorAll('td')].map(
      (td) => td.textContent?.trim() ?? '',
    );
    labels.forEach((label, i) => {
      if (label) {
        out[label] = values[i] ?? '';
      }
    });
  }
  return out;
}

/** 按钮文案比对：antd 会在两个汉字间插空格（「刷新」渲染成「刷 新」）⇒ 去空白再比。 */
function buttonText(el: Element): string {
  return (el.textContent ?? '').replaceAll(/\s/g, '');
}

/** 节点表：逐行取单元格文本。 */
function tableRows(container: HTMLElement): string[][] {
  return [...container.querySelectorAll('.ant-table-tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? ''),
  );
}

function tagClass(container: HTMLElement): string {
  return container.querySelector('.ant-tag')?.className ?? '';
}

let mounted: undefined | { app: { unmount: () => void } };

async function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(AccessOverview as never) });
  app.mount(container);
  mounted = { app };
  // 组件 onMounted 就 load()，等 promise 链落定
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return container;
}

beforeEach(() => {
  mockApi.getAccessOverview.mockReset();
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('access-overview：上报状态与字段诚实性', () => {
  it('★ reported=false ⇒ 指标区显示占位而**不是 0**，状态为「access 尚未上报指标」且不是「正常」', async () => {
    mockApi.getAccessOverview.mockResolvedValue(overview());

    const container = await mountPage();
    const metrics = metricMap(container);

    // 「距上次上报」不受门控（它就是判断依据本身）
    expect(metrics['距上次上报']).toBe('1200');
    // 其余指标必须被门控成「尚未上报」占位（PENDING_TEXT），
    // 绝不能把它未上报的 0 当成真实值渲染出来
    expect(metrics['对账被推迟']).toBe(PENDING_TEXT);
    expect(metrics['节点失效停采']).toBe(PENDING_TEXT);
    expect(container.innerHTML).not.toContain('777');
    expect(container.innerHTML).toContain('access 尚未上报指标');
    expect(container.innerHTML).not.toContain('正常');
    expect(tagClass(container)).toContain('ant-tag-default');
  });

  it('★ reported=true 且滞后 ≥45s（Long 字符串）⇒ 状态「中断」+ 红色标签，指标按真实值渲染', async () => {
    mockApi.getAccessOverview.mockResolvedValue(
      overview({}, { reported: true, reportLagMs: '60000' }),
    );

    const container = await mountPage();
    const metrics = metricMap(container);

    expect(metrics['距上次上报']).toBe('60000');
    expect(metrics['对账被推迟']).toBe('777'); // 已上报 ⇒ 真实值放行
    expect(container.innerHTML).toContain('中断');
    expect(tagClass(container)).toContain('ant-tag-error');
  });

  it('reported=true 且滞后 <45s ⇒ 状态「正常」+ 绿色标签', async () => {
    mockApi.getAccessOverview.mockResolvedValue(
      overview({}, { reported: true, reportLagMs: '1200' }),
    );

    const container = await mountPage();
    expect(container.innerHTML).toContain('正常');
    expect(tagClass(container)).toContain('ant-tag-success');
  });
});

describe('access-overview：节点表映射', () => {
  it('maxTenants=null ⇒「不限」；Long 字符串计数原样转文本；null 计数 ⇒ 占位（不显示 0）', async () => {
    mockApi.getAccessOverview.mockResolvedValue(
      overview({
        nodes: [
          {
            accessNode: 'access-1',
            holdingCount: '17',
            lastRegisteredAt: null,
            leaseAlive: true,
            leaseExpireMin: null,
            leaseRemainingSec: 30,
            maxTenants: null,
          },
        ],
      }),
    );

    const container = await mountPage();
    const rows = tableRows(container);
    expect(rows).toHaveLength(1);
    // 列序：节点 / 最大租户数 / 持有 / 最早租约到期 / 最近注册 / 租约 / 剩余
    expect(rows[0]?.[0]).toBe('access-1');
    expect(rows[0]?.[1]).toBe('不限');
    expect(rows[0]?.[2]).toBe('17');
    expect(rows[0]?.[3]).toBe('暂无数据');
    expect(rows[0]?.[4]).toBe('暂无数据');
    expect(rows[0]?.[5]).toBe('续约中');
    expect(rows[0]?.[6]).toBe('30');
  });

  it('租约存活性三态：null ⇒ 无租约、true ⇒ 续约中、false ⇒ 已过期（含负剩余秒如实显示）', async () => {
    mockApi.getAccessOverview.mockResolvedValue(
      overview({
        nodes: [
          {
            accessNode: 'a-null',
            leaseAlive: null,
            leaseRemainingSec: null,
            maxTenants: 3,
          },
          {
            accessNode: 'a-true',
            leaseAlive: true,
            leaseRemainingSec: 12,
            maxTenants: 3,
          },
          {
            accessNode: 'a-false',
            leaseAlive: false,
            leaseRemainingSec: -5,
            maxTenants: 3,
          },
        ],
      }),
    );

    const container = await mountPage();
    const rows = tableRows(container);
    expect(rows.map((r) => [r[0], r[5], r[6]])).toEqual([
      ['a-null', '无租约', '暂无数据'],
      ['a-true', '续约中', '12'],
      ['a-false', '已过期', '-5'],
    ]);
  });
});

describe('access-overview：失败可见与刷新', () => {
  it('★ 加载失败 ⇒ 展示后端 message 原文（页面不留空白、也不假装是「无数据」）', async () => {
    const backendMessage = '查询被拒绝：无对应权限';
    mockApi.getAccessOverview.mockRejectedValue(
      bizFailure(40_303, backendMessage),
    );

    const container = await mountPage();
    expect(container.innerHTML).toContain(backendMessage);
  });

  it('★ 点「刷新」⇒ 重新拉取接口（不是本地重排）', async () => {
    mockApi.getAccessOverview.mockResolvedValue(overview());
    const container = await mountPage();
    expect(mockApi.getAccessOverview).toHaveBeenCalledTimes(1);

    const refresh = [...container.querySelectorAll('button')].find((b) =>
      buttonText(b).includes('刷新'),
    ) as HTMLButtonElement | undefined;
    expect(refresh, '未渲染出「刷新」按钮').toBeTruthy();

    refresh?.click();
    await nextTick();
    await Promise.resolve();
    await nextTick();
    expect(mockApi.getAccessOverview).toHaveBeenCalledTimes(2);
  });
});
