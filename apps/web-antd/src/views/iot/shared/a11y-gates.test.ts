/**
 * **a11y 静态门禁**（2026-10-20 审查 P1-7 / P1-8 / P1-10 的回归防线）。
 *
 * ## 为什么要有这个门禁
 *
 * 2026-10-20 UI/UX 审查实测（均为源码级事实，渲染测试抓不到）：
 * - **P1-10**：全站 `h1 = 0`，11 个页面里 10 个没有任何标题元素 ⇒ 读屏用户无法用标题导航；
 * - **P1-7**：5 处可交互元素键盘完全不可达（`<span @click>`、`<Tag @click>`、无 `href` 的 `<a>`）；
 * - **P1-8**：图标按钮 7 处缺 `aria-label`（其中 5 处完全无可访问名），全仓 `aria-label` 仅 3 处。
 *
 * 这三类问题共同点是「功能正常但只对鼠标用户可用」，业务测试与 typecheck 都不会红。
 * 本门禁用**正则级静态断言**把它们变成可执行规则；如遇误报，登记到对应 allowlist
 * （逐条写理由），**不要放宽规则本身**。
 *
 * ## 已知边界（启发式，非完整 a11y 检查）
 *
 * - 规则②只覆盖 `<div|span>` 上的 `@click`；`<Tag @click>` / 无 `href` 的 `<a @click>`
 *   仍需评审人工把关（正则区分成本高、误报多）；
 * - 规则③只识别「`<Button>` 块内仅 `<template #icon>` 且无可见文本/aria-label」这一种形态；
 *   `:icon` prop 形态不在覆盖范围。
 */
import type { Dirent } from 'node:fs';

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { blankHtmlComments } from '#/utils/source-scan';

/** 门禁测试自身位置：`apps/web-antd/src/views/iot/shared/`。 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** `apps/web-antd/src/views`。 */
const VIEWS_ROOT = resolve(HERE, '../..');
/** `apps/web-antd/src`（用于输出 `views/...` 相对路径）。 */
const SRC_ROOT = resolve(VIEWS_ROOT, '..');

/** ① 页面根：`views/iot/**\/index.vue`。 */
const IOT_ROOT = join(VIEWS_ROOT, 'iot');
/** ②③ 全站范围：IoT + 仪表盘/工作台（与审查 P1-7/P1-8 同口径）。 */
const SCAN_ROOTS = [join(VIEWS_ROOT, 'dashboard'), IOT_ROOT] as const;

/** 行内可点击容器缺 role/tabindex 的白名单：`views/...:行号`（逐条登记理由）。初始为空。 */
const CLICKABLE_ALLOWLIST: ReadonlyArray<{
  /** `views/...` 相对路径。 */
  file: string;
  /** 命中行号（便于评审定位；行号漂移时需同步更新）。 */
  line: number;
  reason: string;
}> = [];

/** 页面根 h1 白名单：`views/...` 相对路径（逐条登记理由）。初始为空。 */
const H1_ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [];

/** 图标按钮无访问名白名单：`views/...:行号`（逐条登记理由）。初始为空。 */
const ICON_BUTTON_ALLOWLIST: ReadonlyArray<{
  file: string;
  line: number;
  reason: string;
}> = [];

/**
 * 把注释替换成等长空白（保留换行以维持行号）。
 * 注释里讨论 `<span @click>` 不算违规（`tags.vue:180` 就有一条这样的说明）。
 */
function stripComments(source: string): string {
  const blank = (match: string) => match.replaceAll(/[^\n]/g, ' ');
  return blankHtmlComments(source)
    .replaceAll(/\/\*[\s\S]*?\*\//g, blank)
    .replaceAll(/^\s*\/\/.*$/gm, blank);
}

function walkVueFiles(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkVueFiles(full, out);
    } else if (entry.name.endsWith('.vue')) {
      out.push(full);
    }
  }
  return out;
}

function toRelative(file: string): string {
  return relative(SRC_ROOT, file).split('\\').join('/');
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** 读取并去注释后的全部 .vue（一次读盘，多规则复用）。 */
const files = SCAN_ROOTS.flatMap((root) => walkVueFiles(root))
  .toSorted()
  .map((file) => ({
    file,
    relativeFile: toRelative(file),
    source: stripComments(readFileSync(file, 'utf8')),
  }));

describe('a11y 门禁（2026-10-20 审查 P1-7 / P1-8 / P1-10）', () => {
  it('扫描器覆盖到真实页面源码（防「扫描 0 文件 ⇒ 假绿」）', () => {
    expect(
      files.length,
      '扫描到的 .vue 文件数异常少，门禁可能空跑',
    ).toBeGreaterThanOrEqual(50);
  });

  it('每个 views/iot 页面根（index.vue）必须恰好 1 个 <h1>', () => {
    const indexPages = files.filter(
      (item) =>
        item.file.startsWith(IOT_ROOT) && item.file.endsWith('/index.vue'),
    );
    // 2026-10-20 基线：9 个 IoT 页面根。
    expect(
      indexPages.length,
      '未扫到 IoT 页面根 index.vue',
    ).toBeGreaterThanOrEqual(9);

    const violations = indexPages
      .filter(
        (item) =>
          !H1_ALLOWLIST.some((entry) => entry.file === item.relativeFile),
      )
      .map((item) => {
        const count = [...item.source.matchAll(/<h1\b/g)].length;
        return { ...item, count };
      })
      .filter((item) => item.count !== 1)
      .map(
        (item) =>
          `  ${item.relativeFile}: 期望恰好 1 个 <h1>，实际 ${item.count}（P1-10：0 个 h1 ⇒ 读屏无法按标题导航）`,
      );

    expect(
      violations.join('\n'),
      '页面根必须有且仅有 1 个 <h1>；如页面确实不适合用 h1，登记 H1_ALLOWLIST 并写理由',
    ).toBe('');
  });

  it('禁止 <div|span @click> 不带 role/tabindex（键盘不可达）', () => {
    const violations: string[] = [];
    // 标签可能跨行：`[^>]*` 会连同换行一起匹配属性区。
    const tagRe = /<(div|span)\b([^>]*)>/g;
    for (const item of files) {
      for (const match of item.source.matchAll(tagRe)) {
        const index = match.index;
        if (index === undefined) {
          continue;
        }
        const attrs = match[2] ?? '';
        if (!attrs.includes('@click')) {
          continue;
        }
        if (attrs.includes('role=') || attrs.includes('tabindex=')) {
          continue;
        }
        const line = lineOf(item.source, index);
        const allowlisted = CLICKABLE_ALLOWLIST.some(
          (entry) => entry.file === item.relativeFile && entry.line === line,
        );
        if (allowlisted) {
          continue;
        }
        violations.push(
          `  ${item.relativeFile}:${line}  <${match[1]}> 绑定了 @click 但无 role=/tabindex=（P1-7：键盘不可达）`,
        );
      }
    }
    expect(
      violations.join('\n'),
      '改用 <button>/<Button>；确需用 div/span 时加 role="button" + tabindex="0" + 键盘事件',
    ).toBe('');
  });

  it('禁止「仅 <template #icon> 且无可见文本/aria-label」的图标按钮（无访问名）', () => {
    const violations: string[] = [];
    // `<Button ...>...</Button>`（非自闭合）；属性区允许跨行。
    const buttonRe = /<Button\b([^>]*)>([\s\S]*?)<\/Button>/g;
    for (const item of files) {
      for (const match of item.source.matchAll(buttonRe)) {
        const index = match.index;
        if (index === undefined) {
          continue;
        }
        const attrs = match[1] ?? '';
        const inner = match[2] ?? '';
        if (!inner.includes('<template #icon')) {
          continue;
        }
        const withoutIcon = inner.replaceAll(
          /<template\s+#icon>[\s\S]*?<\/template>/g,
          '',
        );
        const visibleText = withoutIcon.replaceAll(/<[^>]+>/g, ' ').trim();
        if (visibleText !== '') {
          continue;
        }
        if (attrs.includes('aria-label') || attrs.includes('title=')) {
          continue;
        }
        const line = lineOf(item.source, index);
        const allowlisted = ICON_BUTTON_ALLOWLIST.some(
          (entry) => entry.file === item.relativeFile && entry.line === line,
        );
        if (allowlisted) {
          continue;
        }
        violations.push(
          `  ${item.relativeFile}:${line}  图标按钮无可见文本且无 aria-label（P1-8：读屏读不出按钮用途）`,
        );
      }
    }
    expect(
      violations.join('\n'),
      '图标按钮必须带 aria-label（或可见文本）；动态文案可用 :aria-label',
    ).toBe('');
  });
});
