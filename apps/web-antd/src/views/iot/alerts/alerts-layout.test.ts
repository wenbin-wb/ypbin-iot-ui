import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALERTS_LAYOUT,
  detectRunawayGrowth,
  resolveGridBodyHeight,
  RUNAWAY_HEIGHT,
} from './alerts-layout';

/**
 * 告警页表格高度的「无自增长」契约用例（2026-10 生产实测：行数恒为 2 表体却无限增高）。
 *
 * 用例分两类：
 * 1. **纯函数性质**：`resolveGridBodyHeight` 的输出只由外部输入决定（不存在
 *    「高度 ← 上一次自身高度/内容高度」的自引用输入）；1-Lipschitz（不放大）；
 *    有界（恒 ≤ 输入的确定高度）—— 这三条合起来就是「不存在自增长路径」。
 *    `detectRunawayGrowth` 只对「连续 N 次超标 + 严格递增」判失控（自反馈环签名），
 *    正常抖动（持平/回落）不误判。
 * 2. **SFC 契约**（本机可跑、能咬人的回归）：直接读 `index.vue` 源码，断言
 *    确定高度链的每一个标记都在（Tabs `h-full`、表格壳 `flex-1 min-h-0`、
 *    `ALERTS_LAYOUT.requiredDeepRules` 的 scoped CSS、两个 grid 仍是 `height:'auto'`
 *    与设备台账一致、不写死 px、不存在 style.height 回填）。
 *    任何一步被后来的人删掉，这一组用例立即转红 —— 这正是「布局 bug 只能浏览器
 *    复现」之外我们能做到的最强守门（jsdom 测不了真实布局，见测试文件头注释）。
 */

describe('resolveGridBodyHeight（表体高度 = 外部确定高度 − 固定排除项）', () => {
  const base = {
    viewportHeightPx: 800,
    excludePx: 160,
    headerPx: 40,
    footerPx: 0,
  };

  it('★ 输出只由入参决定：同一输入两次调用结果一致（无内部状态/无上一轮高度）', () => {
    const first = resolveGridBodyHeight(base);
    const second = resolveGridBodyHeight(base);
    expect(first).toBe(second);
    expect(first).toBe(800 - 160 - 40);
  });

  it('★ 无自引用：参数里没有「行数」「上一次自身高度/内容高度」这类会随内容变化的值 ⇒ 输出与自身无关', () => {
    // 改变的是外部输入，输出严格按「视口 − 固定项」走；若实现引入了行数/自身高度，
    // 下面的恒等式必然被破坏
    expect(resolveGridBodyHeight({ ...base, viewportHeightPx: 900 })).toBe(
      900 - 160 - 40,
    );
    expect(resolveGridBodyHeight({ ...base, excludePx: 200 })).toBe(
      800 - 200 - 40,
    );
    expect(resolveGridBodyHeight({ ...base, headerPx: 60 })).toBe(
      800 - 160 - 60,
    );
  });

  it('★ 1-Lipschitz（不放大）：视口输入变 Δ，输出至多变 |Δ| ⇒ 不存在高度正反馈放大', () => {
    for (const delta of [-500, -13, 0, 17, 400]) {
      const a = resolveGridBodyHeight({ ...base, viewportHeightPx: 800 });
      const b = resolveGridBodyHeight({
        ...base,
        viewportHeightPx: 800 + delta,
      });
      expect(Math.abs(b - a)).toBeLessThanOrEqual(Math.abs(delta));
    }
  });

  it('有界：输出恒 ≤ 视口输入，且 ≥ 0（再大的时间都不允许溢出/负高）', () => {
    for (const viewportHeightPx of [0, 1, 100, 9999]) {
      const out = resolveGridBodyHeight({ ...base, viewportHeightPx });
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(Math.max(0, viewportHeightPx));
    }
  });
});

describe('detectRunawayGrowth（连续 N 次超标 + 严格递增才判失控）', () => {
  const opts = {
    thresholdPx: 1000,
    requiredConsecutive: RUNAWAY_HEIGHT.requiredConsecutive,
  };

  it('★ 自反馈环签名：连续 6 个采样点全部超标且严格递增 ⇒ 失控（触发回退固定值）', () => {
    const samples = [1000, 1010, 1040, 1090, 1160, 1250, 1360];
    expect(detectRunawayGrowth(samples, { ...opts, thresholdPx: 1000 })).toBe(
      true,
    );
  });

  it('采样不足 ⇒ 不判（前 5 个点还没有连续 N 个）', () => {
    expect(detectRunawayGrowth([1000, 1010, 1040, 1090, 1160], opts)).toBe(
      false,
    );
  });

  it('正常确定高度链：波动或持平（不得递增）⇒ 绝不误判', () => {
    expect(detectRunawayGrowth([800, 802, 801, 800, 801, 802, 800], opts)).toBe(
      false,
    );
    expect(
      detectRunawayGrowth([1001, 1000, 1001, 1000, 1001, 1000], opts),
    ).toBe(false);
  });

  it('即使递增但没超过门槛 ⇒ 不判（防止把「真多行的大表格」误杀）', () => {
    expect(
      detectRunawayGrowth([100, 200, 300, 400, 500, 600, 700], {
        ...opts,
        thresholdPx: 1000,
      }),
    ).toBe(false);
  });
});

describe('sFC 布局契约（确定高度链标记都在；缺一即回归咬人）', () => {
  // 直接读被测页面源码 —— 布局 bug 无法在 jsdom 复现，就以源码标记为可咬的守门
  const sfc = readFileSync(resolveIndexVuePath(), 'utf8');

  /** vitest 转换后的 import.meta.url 可能不是 file 协议：fileURLToPath 失败时退回 cwd 相对路径。 */
  function resolveIndexVuePath(): string {
    try {
      return fileURLToPath(new URL('index.vue', import.meta.url));
    } catch {
      return join(
        process.cwd(),
        'apps/web-antd/src/views/iot/alerts/index.vue',
      );
    }
  }

  it('页面仍是 `Page auto-content-height` 的确定高度宿主', () => {
    expect(sfc).toContain('<Page auto-content-height>');
  });

  it('★ Tabs 根必须占满内容区（`h-full`）—— 否则 tabpane 回到「高度=内容」', () => {
    expect(sfc).toContain('<Tabs');
    expect(
      /(<Tabs[\s\S]*?class="h-full")/.test(sfc),
      'Tabs 需要 class="h-full"（把确定高度从 Page 内容区接进 antd Tabs）',
    ).toBe(true);
  });

  it('★ 两个表格壳都必须 `flex-1 min-h-0`（在定高的 tabpane 里吃剩余高度）', () => {
    for (const tag of ['InstanceGrid', 'RuleGrid']) {
      // tag 与 class 在同一对尖括号内（不跨行断言，避免被注释干扰）
      const open = new RegExp(`<${tag}[^>]*class="[^"]*flex-1[^"]*min-h-0`);
      expect(open.test(sfc), `${tag} 需要 class="flex-1 min-h-0"`).toBe(true);
    }
  });

  it('★ scoped CSS 必须包含 `ALERTS_LAYOUT.requiredDeepRules` 的全部规则（tabpane 定高为列 flex）', () => {
    // 归一化空白再比对：样式块里的换行/缩进不算差异，规则缺失才算
    const normalized = sfc.replaceAll(/\s+/g, ' ');
    for (const rule of ALERTS_LAYOUT.requiredDeepRules) {
      const normalizedRule = rule.replaceAll(/\s+/g, ' ');
      expect(
        normalized.includes(normalizedRule),
        `index.vue 的 <style> 里缺少深度规则：${rule}`,
      ).toBe(true);
    }
  });

  it("两个 grid 保持与设备台账一致的 `height: 'auto'`（不写死 px、不回填自身高度）", () => {
    const occurrences = sfc.match(/height: 'auto'/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    // 页面代码里不得出现把表格高度写死的 style.height/px 回填
    expect(/height:\s*\d+px/.test(sfc)).toBe(false);
  });

  it('页面代码没有任何显式 style.height 绑定（高度只走确定的父容器链）', () => {
    expect(/:style=.*height|style=\{[^}]*height/.test(sfc)).toBe(false);
  });

  it('aLERTS_LAYOUT 的常量声明与 SFC 实际内容必须逐字一致（改 SFC 不改契约 ⇒ 用例咬人）', () => {
    expect(sfc).toContain(ALERTS_LAYOUT.requiredTabClass);
    expect(sfc).toContain(ALERTS_LAYOUT.requiredGridClasses.join(' '));
  });
});

describe('rUNAWAY_HEIGHT（看门狗常量可配且自洽）', () => {
  it('requiredConsecutive ≥ 2（单点抖动不许触发回退）', () => {
    expect(RUNAWAY_HEIGHT.requiredConsecutive).toBeGreaterThanOrEqual(2);
  });

  it('excessPx 为正（阈值至少高过视口一点点，正常表格够不着）', () => {
    expect(RUNAWAY_HEIGHT.excessPx).toBeGreaterThan(0);
  });
});
