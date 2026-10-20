import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * IoT / 工作台「小屏（390px）适配」静态回归用例。
 *
 * 为什么用静态断言：本轮改动是**响应式 class 层**的（flex-wrap / grid-cols-1 / max-w / overflow），
 * 在 happy-dom 里没有真实布局引擎，组件挂载也测不出「是否溢出」；而这些 class 一旦被后续重构
 * 顺手删掉，真实小屏才会回归。这里逐页把「窄屏不溢出」所依赖的 class 钉在源码上。
 *
 * 断言只覆盖稳定语义：
 * - 工具栏容器必须 flex-wrap（按钮可换行，不横向溢出）；
 * - 抽屉/弹层宽度必须是 w-full + max-w（390px 下不超出视口）；
 * - 卡片/指标网格窄屏必须 grid-cols-1（单列）；
 * - 表格必须保留横向滚动容器（min-w 表格不挤压）。
 */

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('小屏适配：工具栏可换行', () => {
  const toolbarPages: Array<[string, string]> = [
    ['设备台账', '../devices/index.vue'],
    ['产品列表', '../products/index.vue'],
    ['设备分组', '../groups/index.vue'],
    ['维护窗口', '../maintenance/index.vue'],
    ['租户台账', '../tenant-ledger/modules/ledger.vue'],
  ];

  for (const [name, path] of toolbarPages) {
    it(`${name}：工具栏容器 flex-wrap，按钮不横向溢出`, () => {
      expect(source(path)).toContain('flex flex-wrap items-center gap-2');
    });
  }

  it('设备台账：旧版靠 mr-2 排一行的写法已移除（按钮最多，最易溢出）', () => {
    expect(source('../devices/index.vue')).not.toContain('class="mr-2"');
  });

  it('告警中心：两个工具栏 Space 都开启 wrap；展开行窄屏单列', () => {
    // 拆分批次 5-D：两个工具栏与展开行已抽成 alerts/modules/ 下的子组件，
    // 断言改为「在告警页 + 3 个产物文件里」求并集——不变量（恰好两个 wrap 工具栏、
    // 展开行窄屏单列）保持原样，只是事实源随模板一起搬了家。
    const code = [
      source('../alerts/index.vue'),
      source('../alerts/modules/instance-toolbar.vue'),
      source('../alerts/modules/rule-toolbar.vue'),
    ].join('\n');
    expect(code.match(/<Space wrap>/g)).toHaveLength(2);
    expect(source('../alerts/modules/instance-expand.vue')).toContain(
      'grid-cols-1 gap-4 p-2 text-sm sm:grid-cols-2 md:grid-cols-3',
    );
  });
});

describe('小屏适配：抽屉 / 弹层不超出视口', () => {
  it('设备台账的三个抽屉：w-full + max-w，390px 下不撑破', () => {
    const code = source('../devices/index.vue');
    expect(code).toContain('w-full max-w-[900px]');
    expect(code).toContain('w-full max-w-[1000px]');
  });

  it('产品/维护向导抽屉同样是 w-full + max-w', () => {
    expect(source('../products/index.vue')).toContain('w-full max-w-[900px]');
    expect(source('../maintenance/index.vue')).toContain(
      'w-full max-w-[900px]',
    );
  });

  it('分组成员：抽屉/批量弹层 w-full + max-w，表头工具可换行，表格可横向滚动', () => {
    const code = source('../groups/modules/members.vue');
    expect(code).toContain('w-full max-w-[900px]');
    expect(code).toContain('w-full max-w-[600px]');
    expect(code).toContain('flex flex-wrap items-center gap-2');
    expect(code).toContain(':scroll="{ x: \'max-content\' }"');
  });

  it('openapi key：头部可换行、Modal 宽度 min(520px, 92vw)、QPS/配额窄屏上下排', () => {
    const code = source('../openApiKeys/index.vue');
    expect(code).toContain('flex flex-wrap items-center gap-3');
    expect(code.match(/width="min\(520px, 92vw\)"/g)).toHaveLength(2);
    expect(code).toContain('flex flex-col gap-3 sm:flex-row');
  });

  it('设备详情抽屉：92vw、基本信息单列断点、卡片网格 min-w-0、表格横向滚动', () => {
    const code = source('../devices/modules/detail.vue');
    // 批次 5 概览拆卡后，响应式 class 分散到卡片文件；断言改为「宿主 + 卡片」求并集，
    // 语义保持不变量：基本信息断点仍在、三组两列网格仍是 3 组、表格仍有横向滚动容器。
    const basicCard = source('../devices/modules/overview-basic-card.vue');
    const latestCard = source('../devices/modules/overview-latest-card.vue');
    const shadowCard = source('../devices/modules/overview-shadow-card.vue');
    expect(code).toContain('w-[92vw]');
    expect(basicCard).toContain('sm: 1, md: 2, xl: 3');
    // 3 组并排网格：detail（标签+凭据）、最新值卡（最新值+可用率）、影子卡（reported+desired）
    expect(
      [code, latestCard, shadowCard]
        .join('\n')
        .match(/grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2/g),
    ).toHaveLength(3);
    expect(code).toContain('overflow-x-auto');
  });
});

describe('小屏适配：卡片 / 筛选 / 向导网格单列', () => {
  it('平台自告警：筛选头部可换行，下拉 max-w-full', () => {
    const code = source('../platformAlert/index.vue');
    expect(code).toContain('flex flex-wrap items-center gap-3');
    expect(code).toContain('w-40 max-w-full');
  });

  it('接入向导：步骤卡片网格窄屏单列、≥sm 才两列', () => {
    const code = source('../onboarding/modules/guide.vue');
    expect(
      code.match(/grid-cols-1 gap-3 sm:grid-cols-2/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('工作台：指标卡窄屏单列、页头关键计数可换行', () => {
    const code = source('../../dashboard/workspace/index.vue');
    expect(code).toContain(
      'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4',
    );
    expect(code).toContain(
      'flex flex-wrap items-center justify-end gap-x-6 gap-y-2',
    );
  });
});
