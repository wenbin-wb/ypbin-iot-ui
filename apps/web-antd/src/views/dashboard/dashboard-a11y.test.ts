import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { stripHtmlComments } from '#/utils/source-scan';

/**
 * 仪表盘（`views/dashboard`）的**静态可访问性/视觉纪律回归**。
 *
 * 为什么用源码断言而不是挂载断言：这里守的是「结构不能退回去」——
 * 渐变裁切字、缺 h1、缺 role="img"、又冒出 Tailwind 调色板类、动效没兜底，
 * 这些在 happy-dom 里没有布局/颜色引擎，挂载断言测不出来；
 * 而它们一旦被后续重构顺手加回来，真实浏览器里就是「核心指标看不清 + 读屏无信息」。
 * 与 `views/iot/shared/mobile-layout.test.ts` 同一思路（静态钉住语义 class/属性）。
 */

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

/** 去掉 HTML 注释后再断言结构与类名：注释里会提到标签名，不能算进计数。 */
function markup(relativePath: string): string {
  return stripHtmlComments(source(relativePath));
}

/** 递归收集 dashboard 下的所有 .vue / .css / .ts（跳过测试与快照）。 */
function collect(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? dir, entry.name))
    .filter((file) => !file.endsWith('.test.ts'))
    .filter((file) => /\.(vue|css|ts)$/.test(file));
}

// 用 cwd 拼绝对路径：happy-dom 环境下 `new URL('.', import.meta.url).pathname`
// 可能拿不到 file:// 前缀，拼出来的目录不存在（踩过一次）。
const dashboardDir = resolve(
  process.cwd(),
  'apps/web-antd/src/views/dashboard',
);

describe('页面标题层级：每页第一个标题元素必须是 h1', () => {
  it('分析页：只有 1 个 h1，且不再用 h2 当页面主标题', () => {
    const code = markup('./analytics/index.vue');
    expect(code.match(/<h1\b/g) ?? []).toHaveLength(1);
    expect(code.match(/<\/h1>/g) ?? []).toHaveLength(1);
    // 页面主标题（analyticsTitle）必须挂在 h1 上，不能退回 h2
    expect(code).toMatch(/<h1[\s\S]{0,400}page\.dashboard\.analyticsTitle/);
    expect(code).not.toMatch(/<h2\b/);
  });

  it('工作台：有无障碍 h1（视觉标题挂在基座插槽里，故用 sr-only）', () => {
    const code = markup('./workspace/index.vue');
    expect(code.match(/<h1\b/g) ?? []).toHaveLength(1);
    expect(code).toContain('sr-only');
  });
});

describe('指标卡数值：不允许退回「渐变裁切字」', () => {
  it('两个页面都不再使用 -webkit-text-fill-color: transparent', () => {
    // 这是对比度 2.01:1 / 2.86:1 的根因，且在高对比度模式下会让数字整块消失
    for (const page of ['./analytics/index.vue', './workspace/index.vue']) {
      expect(source(page), `${page} 又出现渐变裁切字`).not.toContain(
        'WebkitTextFillColor',
      );
    }
  });

  it('两个页面都通过 metricTextColor 取数值色（走 ≥4.5:1 的常量）', () => {
    for (const page of ['./analytics/index.vue', './workspace/index.vue']) {
      const code = source(page);
      expect(code).toContain('metricTextColor');
      expect(code).toContain('iot-metric-card');
    }
  });

  it('指标卡样式集中在 metric-visuals.css，并带 prefers-reduced-motion 兜底', () => {
    const css = source('./shared/metric-visuals.css');
    expect(css).toContain('.iot-metric-card');
    expect(css).toContain('@keyframes iot-metric-in');
    expect(css).toContain('prefers-reduced-motion');
    // 两个页面不再各自维护一份动画关键帧（避免一页关了动效、另一页没关）
    for (const page of ['./analytics/index.vue', './workspace/index.vue']) {
      expect(source(page)).not.toContain('@keyframes');
    }
  });
});

describe('数据失败/演示态必须常驻可见（不允许只在 hover tooltip 里）', () => {
  it('composable 产出唯一一条 notice（标题/语气随失败或演示切换）', () => {
    const composable = source('./shared/use-iot-overview.ts');
    expect(composable).toContain('page.dashboard.overviewLoadFailed');
    expect(composable).toContain('page.dashboard.overviewLoadFailedHint');
    expect(composable).toContain('page.dashboard.demoModeTitle');
    // 生产失败不回落演示数据 + demoReason 记录失败原因
    expect(composable).toMatch(/import\.meta\.env\.PROD/);
    expect(composable).toContain('demoReason');
  });

  for (const page of ['./analytics/index.vue', './workspace/index.vue']) {
    it(`${page}：渲染常驻 notice（含重试），不再各自拼失败文案`, () => {
      const code = source(page);
      expect(code).toContain('ListErrorAlert');
      expect(code).toMatch(/v-if="notice"/);
      expect(code).toContain('page.dashboard.retry');
      // 消费 notice（而不是只接 overview/usingDemo，把失败态丢掉）
      expect(code).toMatch(/\bnotice\b/);
    });
  }
});

describe('图表可访问性：canvas 容器必须有 role="img" + aria-label', () => {
  const chartComponents = [
    './analytics/analytics-alert-trend.vue',
    './analytics/analytics-device-growth.vue',
    './analytics/analytics-trends.vue',
    './analytics/analytics-visits-data.vue',
    './analytics/analytics-visits-sales.vue',
    './analytics/analytics-visits-source.vue',
    './analytics/analytics-visits.vue',
    './analytics/board/board-widget-card.vue',
  ];

  for (const component of chartComponents) {
    it(`${component}：EchartsUI 带 role 与 aria-label`, () => {
      const code = source(component);
      expect(code).toContain('<EchartsUI');
      expect(code).toContain('role="img"');
      expect(code).toContain('aria-label');
    });
  }

  it('看板拖拽把手可聚焦（tabindex + role + 键盘处理）', () => {
    const code = source('./analytics/board/board-widget-card.vue');
    expect(code).toContain('tabindex="0"');
    expect(code).toContain('role="button"');
    expect(code).toContain('@keydown');
    expect(code).toContain('ArrowUp');
  });

  it('看板禁用态给出原因说明（不再是无提示的灰按钮）', () => {
    const card = source('./analytics/board/board-widget-card.vue');
    expect(card).toContain('page.iot.board.disabledFirst');
    expect(card).toContain('page.iot.board.disabledLast');
    // 「保存到平台」禁用原因由工具栏承载（批次6 拆分后从 board-drawer.vue 移出）
    const toolbar = source('./analytics/board/board-toolbar.vue');
    expect(toolbar).toContain('page.iot.board.empty');
    expect(toolbar).toContain('<Tooltip');
  });
});

describe('设计令牌纪律：dashboard 内不得出现 Tailwind 调色板类', () => {
  it('全目录 0 处 Tailwind 调色板类（gray/blue/red…，暗色模式下会失效）', () => {
    const paletteClass =
      /\b(?:bg|text|border|ring|divide|from|to|via)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
    const offenders: string[] = [];
    for (const file of collect(dashboardDir)) {
      const code = readFileSync(file, 'utf8');
      const matched = paletteClass.exec(code);
      if (matched) {
        offenders.push(`${relative(dashboardDir, file)} → ${matched[0]}`);
      }
    }
    expect(offenders, `发现硬编码调色板类：\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });
});
