import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 引擎层分层守门（工单 #125 的防复发护栏）。
 *
 * ## 为什么需要这条测试
 *
 * `src/three/twin/**` 是**可以按需加载**的 three.js 引擎层：页面全部用
 * `await import('#/three/twin/...')` 动态引入，使 740KB 的 three 只在进入孪生页时才下载。
 *
 * 但这条按需性**极其脆弱**——只要引擎层里出现**一条**指向首屏可达代码的静态 import，
 * 打包器就会把整条 three 依赖链提回首屏。实测踩过的坑：
 *
 * - `anchor-layer.ts` 曾 `import ... from '../../views/iot/twin/twin-colors'`（反向依赖视图层）
 *   ⇒ 形成 `views → anchor-layer → three` 静态环；
 * - 结果：`dist/index.html` 直接 `modulepreload` 740KB three，**231 个 chunk** 静态 import 它。
 *
 * 构建产物校验能抓到，但要先跑完整构建（~14s，CI 里另开一步）；本测试用**源码静态分析**
 * 在毫秒级拦住同一类错误，两者互补。
 *
 * ## 约束（改引擎层前必读）
 *
 * 1. 引擎层**不得** import `views/**`（视图层）——依赖方向只能是 views → three；
 * 2. 引擎层**不得** import `#/api/**`、`#/locales`、`@vben/*`、`ant-design-vue` 等
 *    首屏可达模块（它们会把引擎层反向拖进首屏）；
 * 3. 引擎层内部互相 import、以及 `import type ... from 'three'`（纯类型，不产生运行时依赖）是允许的。
 *
 * 违反时请**改依赖方向**（把被依赖的常量/工具下沉到引擎层，如 `three/twin/colors.ts`），
 * 而不是往本测试里加例外。
 */

const ENGINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

/**
 * 引擎层不允许静态 import 的模块前缀（首屏可达）。
 *
 * 用前缀匹配而不是精确列表：这些命名空间下的**任何**模块都会把引擎层拖回首屏。
 */
const FORBIDDEN_PREFIXES = [
  // 视图层：反向依赖（本工单的根因）
  '#/views',
  '#/adapter',
  '#/layouts',
  // 数据/本地化/UI 框架：都在首屏链路里
  '#/api',
  '#/locales',
  '#/utils',
  '#/stores',
  '@vben/',
  'ant-design-vue',
  'vue',
  'vue-router',
] as const;

/** 相对路径里指向上层的「跳出引擎层」引用也要拦（`../../views/...` 这类写法）。 */
const FORBIDDEN_RELATIVE = /^\.\.\/(?:\.\.\/)*(?:views|api|locales|adapter|utils|stores)\//;

/** 读取引擎层全部非测试 TS 源码。 */
function engineSources(): Array<{ code: string; file: string }> {
  return readdirSync(ENGINE_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => {
      const file = join(ENGINE_DIR, name);
      return { code: readFileSync(file, 'utf8'), file: name };
    });
}

/** 去掉注释，避免文档里提到的路径被误判（例如 colors.ts 注释里解释了旧的错误写法）。 */
function stripComments(code: string): string {
  return code
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 提取一个文件里的**运行时** import 模块说明符。
 *
 * `import type` 与 `export type` 在编译后会被完全擦除，不构成运行时依赖
 * （引擎层普遍 `import type * as THREE_NS from 'three'`，这是允许的）。
 */
function runtimeImportSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  // 静态 import：`import ... from 'x'` / `import 'x'`
  const staticImport = /^\s*import\s+(?!type\s)(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  for (const match of stripComments(code).matchAll(staticImport)) {
    specifiers.push(match[1] ?? '');
  }
  return specifiers;
}

describe('引擎层分层守门（#125）', () => {
  const sources = engineSources();

  it('扫描到引擎层源码（防空跑）', () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
  });

  it('★ 引擎层不得静态 import 视图层或任何首屏可达模块', () => {
    const violations: string[] = [];
    for (const { code, file } of sources) {
      for (const specifier of runtimeImportSpecifiers(code)) {
        const hit =
          FORBIDDEN_PREFIXES.some((prefix) => specifier.startsWith(prefix)) ||
          FORBIDDEN_RELATIVE.test(specifier);
        if (hit) {
          violations.push(`  ${file} → '${specifier}'`);
        }
      }
    }
    expect(violations.join('\n')).toBe('');
  });

  it('引擎层内部互相同级 import 是允许的（确认规则不会误杀）', () => {
    const anchorLayer = sources.find((item) => item.file === 'anchor-layer.ts');
    expect(anchorLayer).toBeDefined();
    // 它 import './colors'（引擎层内部）应通过
    const specifiers = runtimeImportSpecifiers(anchorLayer?.code ?? '');
    expect(specifiers).toContain('./colors');
    expect(specifiers.some((one) => one.includes('views'))).toBe(false);
  });

  it('引擎层不得直接静态 import three 本体（必须由调用方 await import 注入）', () => {
    // 说明：引擎层用 `import type * as THREE_NS from 'three'` 取类型是允许的；
    // 但**运行时**静态 import three 会让 three 立刻成为静态依赖。
    const violations: string[] = [];
    for (const { code, file } of sources) {
      for (const specifier of runtimeImportSpecifiers(code)) {
        if (specifier === 'three' || specifier.startsWith('three/addons')) {
          violations.push(`  ${file} → '${specifier}'`);
        }
      }
    }
    expect(violations.join('\n')).toBe('');
  });
});
