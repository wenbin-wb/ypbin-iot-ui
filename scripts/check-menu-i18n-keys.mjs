#!/usr/bin/env node
/**
 * 菜单标题 i18n 键门禁：扫后端 `sys_menu.title` 里引用的 i18n 键，逐键在两份语言包里解析。
 *
 * ## 为什么需要它（新增门禁的理由，PR 描述同款口径）
 *
 * 后端 `sys_menu.title` 存的就是 **i18n 键本身**（如 `page.iot.credential.get`），
 * 前端 `breadcrumb.vue` / 菜单渲染对它做 `$t(title)` ——键缺失时**不报错、不兜底**，
 * 直接把原始键画在界面上（用户看到的是 `page.iot.credential.get` 这串字）。
 * 这种失效是**静默**的：编译过、测试过、页面也渲染了，只有人眼能发现。
 *
 * 实证：本门禁落地前实测 **11 个**键缺失（10 个 `page.ai.*` + `page.iot.alert.rule.list`），
 * 全部是 `type='button'` 的权限码载体标题——它们在权限分配界面上就是要显示的文案。
 *
 * ## 覆盖范围
 *
 * - **来源**：`ypbin-iot/deploy/sql/**` 下全部 `.sql` 里 `'page.*'` 形状的字符串字面量。
 *   取「整个 SQL 仓」而不是「只取 menu 插入语句」：`title` 列在不同迁移里的列序不同
 *   （有的带 `platform_only`、有的不带），按列位解析会在下一次加列时静默错位、漏扫；
 *   而**字符串字面量形态**是稳定的——`'page.…'` 在这套 SQL 里只用于菜单标题。
 * - **语言包**：`apps/web-antd/src/locales/langs/<lang>/<file>.json`，文件名即顶层命名空间
 *   （与 `packages/locales/src/i18n.ts` 的 `loadLocalesMapFromDir` 运行期行为一致，
 *   也与既有 `check-iot-i18n-keys.mjs` 同口径）。只扫应用自己的语言包：菜单标题全部在这里，
 *   共享包（`packages/locales/src/langs`）不含 `page.*`。
 * - **两种语言**：zh-CN 与 en-US 都必须有；只补一份等于另一种语言显示原始键。
 *
 * ## 误报风险（如实登记）
 *
 * 1. **注释里的键也被扫到**：SQL 注释中出现 `'page.xxx'`（例如「补上菜单 320023 标题键
 *    `page.iot.debug.get`」这类说明文字若写成带引号的形式）会被当成引用。当前 SQL 仓里
 *    注释用反引号不是单引号，实测 0 误报；若将来误报，正解是改注释写法而不是放宽本门禁
 *    ——放宽会让真正的漏键重新变回静默。
 * 2. **反向不检查**：语言包里存在、SQL 里不引用的键（如页面内 `$t` 用的键）不在本门禁范围，
 *    那由既有的 `check-iot-i18n-keys.mjs` 负责。两者互补，都不做的事才是缺口。
 * 3. **不校验键的取值质量**：只保证「能解析到字符串」。文案是否准确不在门禁能力内。
 *
 * 用法：node scripts/check-menu-i18n-keys.mjs   （缺键则退出码 1）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** 后端仓相对路径（两仓同级：`../ypbin-iot`）。允许用环境变量覆盖，便于在别处单跑。 */
const IOT_REPO = process.env.IOT_REPO_DIR ?? join(ROOT, '..', 'ypbin-iot');

const SQL_DIR = join(IOT_REPO, 'deploy/sql');
const LOCALE_DIR = join(ROOT, 'apps/web-antd/src/locales/langs');
const LANGS = ['zh-CN', 'en-US'];

function walk(dir, filter) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(entry)) out.push(full);
  }
  return out;
}

/** 收集 SQL 仓里出现的全部 `'page.*'` 字面量，并记录来源文件（便于报错时定位）。 */
function collectMenuTitleKeys() {
  let sqlFiles;
  try {
    sqlFiles = walk(SQL_DIR, (name) => name.endsWith('.sql'));
  } catch (error) {
    console.error(`[menu-i18n] 扫不到 SQL 目录 ${SQL_DIR}（${error.message}）`);
    console.error(
      '[menu-i18n] 两仓需同级检出，或用 IOT_REPO_DIR 指定 ypbin-iot 路径',
    );
    process.exit(1);
  }
  if (sqlFiles.length === 0) {
    // 教训八：0 违规可能是没跑到。空集合必须显式失败，不能静默「全绿」。
    console.error(`[menu-i18n] ${SQL_DIR} 下没用任何 .sql ⇒ 门禁空跑`);
    process.exit(1);
  }
  const origin = new Map();
  for (const file of sqlFiles) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/'(page\.[A-Za-z0-9_.]+)'/g)) {
      if (!origin.has(match[1])) origin.set(match[1], file);
    }
  }
  if (origin.size === 0) {
    console.error(
      '[menu-i18n] SQL 里一个 page.* 菜单标题键都没扫到 ⇒ 门禁空跑',
    );
    process.exit(1);
  }
  return origin;
}

function loadLang(lang) {
  const dir = join(LOCALE_DIR, lang);
  let files;
  try {
    files = readdirSync(dir);
  } catch (error) {
    console.error(`[menu-i18n] 读不到语言包目录 ${dir}（${error.message}）`);
    process.exit(1);
  }
  const messages = {};
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const ns = file.replace(/\.json$/, '');
    messages[ns] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  }
  return messages;
}

/** 按「命名空间 + 点分路径」解析；只有解析到**字符串**才算命中（对象/数组不是文案）。 */
function resolve(messages, key) {
  const parts = key.split('.');
  let node = messages;
  for (const part of parts) {
    if (
      node === null ||
      node === undefined ||
      typeof node !== 'object' ||
      !(part in node)
    ) {
      return false;
    }
    node = node[part];
  }
  return typeof node === 'string';
}

const origin = collectMenuTitleKeys();
console.log(
  `[menu-i18n] SQL 中引用的菜单标题键：${origin.size} 个（${SQL_DIR}）`,
);

let failed = false;
for (const lang of LANGS) {
  const messages = loadLang(lang);
  const missing = [...origin.entries()].filter(
    ([key]) => !resolve(messages, key),
  );
  if (missing.length > 0) {
    failed = true;
    console.error(`[menu-i18n] ${lang} 缺失 ${missing.length} 个菜单标题键：`);
    for (const [key, file] of missing) {
      console.error(`  - ${key}   （引用自 ${file}）`);
    }
  } else {
    console.log(
      `[menu-i18n] ${lang} OK（${origin.size} 个键全部解析到字符串）`,
    );
  }
}

if (failed) {
  console.error(
    '[menu-i18n] 菜单标题缺键 ⇒ 界面会直接渲染原始键（静默失效）。请在 ' +
      'apps/web-antd/src/locales/langs/{zh-CN,en-US}/page.json 补齐（两份都要）。',
  );
}
process.exit(failed ? 1 : 0);
