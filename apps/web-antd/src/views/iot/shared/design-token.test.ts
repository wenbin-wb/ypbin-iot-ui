/**
 * **design token 静态门禁**（2026-10-20 审查 P1-3 / P1-2 的回归防线）。
 *
 * ## 为什么要有这个门禁
 *
 * 2026-10-20 UI/UX 审查实测：
 * - **64 处** Tailwind 调色板色阶类绕过 design token（`text-gray-400` 15 处、
 *   `text-gray-500` 13 处、`text-red-500` 10 处…），明/暗两端对比度均不达 WCAG AA
 *   （`text-gray-400` 白底 2.54:1、`text-red-500` 3.76:1）；
 * - **61 处**硬编码 6 位 hex、**25 个**不同色值，分散在 12 个文件；
 * - 暗色模式下 `bg-blue-50` 高亮行 / `border-gray-200` 分隔线事实不可用（P1-2）。
 *
 * 这类问题**渲染层测不到**（没有视觉回归门禁），只能做源码级静态断言：把「用语义 token
 * （`text-muted-foreground` / `border-border` / `bg-primary`）而不是调色板色阶」变成可执行规则。
 * 今后新增页面只要写回 `text-gray-400` 或 `#0066f5`，本用例立刻转红，不必等到下一轮人工审查。
 *
 * ## 规则与白名单
 *
 * 1. 禁止 Tailwind 调色板色阶类（22 个色板 × 50~950 色阶；含 `hover:` / `dark:` / `md:`
 *    等变体前缀与 `/opacity` 后缀）；
 * 2. 禁止 6 位 hex 字面量（`#fff` 这类 3 位简写也建议改写为 token；本门禁只拦 6 位，
 *    对应审查给出的 61 处口径）。
 *
 * 白名单初始为空：品牌渐变/第三方图表色应下沉到 `shared/` 的 `.ts` 调色板模块或
 * CSS 变量（`.ts` 不在本门禁扫描范围）。确需在 `.vue` 内保留时，在 {@link HEX_ALLOWLIST}
 * 里**逐条**登记 文件 + 色值 + 理由；禁止用文件级豁免。
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

/** 扫描范围：IoT 页面 + 仪表盘/工作台（审查口径同款两目录）。 */
const SCAN_ROOTS = [
  join(VIEWS_ROOT, 'dashboard'),
  join(VIEWS_ROOT, 'iot'),
] as const;

/** 22 个 Tailwind 调色板 + 50~950 色阶；支持变体前缀（`dark:`/`hover:`/`md:`）与 `/50` 透明度后缀。 */
const PALETTE_CLASS_RE =
  /(?<![\w-])(?:(?:[a-z-]+):)*(?:text|bg|border|ring|fill|stroke|from|to|via)-(?:gray|slate|zinc|neutral|stone|red|rose|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink)-[0-9]{2,3}(?:\/[0-9]{1,3})?(?![\w-])/g;

/** 6 位 hex 色值（`#0066f5` 形态；3 位简写不在本门禁口径内）。 */
const HEX_RE = /#[0-9a-fA-F]{6}\b/g;

interface Violation {
  column: number;
  /** `views/...` 形式，便于在报告里直接定位。 */
  file: string;
  line: number;
  text: string;
}

/** hex 白名单：初始为空。每条必须写清「为什么这个色值不能 token 化」。 */
const HEX_ALLOWLIST: ReadonlyArray<{
  /** `views/...` 相对路径，必须精确匹配。 */
  file: string;
  /** 小写 6 位 hex（含 `#`）。 */
  hex: string;
  reason: string;
}> = [];

/**
 * 把注释替换成等长空白（保留换行以维持行号）。
 *
 * 目的：注释里讨论 `text-gray-400` / `#0066f5` 不算违规；但**字符串/模板里的真实用法必须被拦**。
 * 只处理「整行行注释」与块注释，避免误伤 URL（`http://`）等含 `//` 的字面量。
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

/** 已扫描的 `.vue` 文件（供「防扫描 0 文件假绿」的 sanity 用例用）。 */
const scannedFiles = SCAN_ROOTS.flatMap((root) =>
  walkVueFiles(root),
).toSorted();

function toRelative(file: string): string {
  return relative(SRC_ROOT, file).split('\\').join('/');
}

function lineColumnOf(
  source: string,
  index: number,
): { column: number; line: number } {
  const before = source.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return { column, line };
}

function collectPaletteViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of scannedFiles) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(PALETTE_CLASS_RE)) {
      const index = match.index;
      if (index === undefined) {
        continue;
      }
      violations.push({
        ...lineColumnOf(source, index),
        file: toRelative(file),
        text: match[0],
      });
    }
  }
  return violations;
}

function collectHexViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of scannedFiles) {
    const relativeFile = toRelative(file);
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(HEX_RE)) {
      const index = match.index;
      if (index === undefined) {
        continue;
      }
      const hex = match[0].toLowerCase();
      const allowlisted = HEX_ALLOWLIST.some(
        (item) => item.file === relativeFile && item.hex === hex,
      );
      if (allowlisted) {
        continue;
      }
      violations.push({
        ...lineColumnOf(source, index),
        file: relativeFile,
        text: match[0],
      });
    }
  }
  return violations;
}

function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) {
    return '';
  }
  return [
    `共 ${violations.length} 处：`,
    ...violations.map(
      (item) => `  ${item.file}:${item.line}:${item.column}  ${item.text}`,
    ),
  ].join('\n');
}

describe('design token 门禁（2026-10-20 审查 P1-2 / P1-3）', () => {
  it('扫描器覆盖到真实页面源码（防「扫描 0 文件 ⇒ 假绿」）', () => {
    // 2026-10-20 基线：views/iot 43 个 + views/dashboard 14 个 .vue。
    // 阈值只防「目录改名/扫描器坏掉」导致门禁空跑；正常增减页面不应频繁改这里。
    expect(
      scannedFiles.length,
      '扫描到的 .vue 文件数异常少，门禁可能空跑',
    ).toBeGreaterThanOrEqual(50);
    for (const root of SCAN_ROOTS) {
      expect(
        scannedFiles.some((file) => file.startsWith(root)),
        `扫描范围 ${toRelative(root)} 下一个 .vue 都没找到`,
      ).toBe(true);
    }
  });

  it('禁止 Tailwind 调色板色阶类（应改用语义 token：text-muted-foreground / border-border / bg-primary …）', () => {
    const violations = collectPaletteViolations();
    expect(
      formatViolations(violations),
      '调色板色阶类绕过 design token（暗色不可用 + 对比度不达 AA）。改用语义 token；确需保留请走评审并登记白名单',
    ).toBe('');
  });

  it('禁止硬编码 6 位 hex 色值（应下沉到 .ts 调色板模块或 CSS 变量）', () => {
    const violations = collectHexViolations();
    expect(
      formatViolations(violations),
      '硬编码 hex 色值绕过主题 token（P1-3：61 处/25 色值）。如确为第三方色，登记到 HEX_ALLOWLIST 并写理由',
    ).toBe('');
  });
});
