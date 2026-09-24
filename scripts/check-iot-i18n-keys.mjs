#!/usr/bin/env node
/**
 * IoT 页面 i18n 键存在性门禁（本仓 CI 目前没有 lint，也没有任何 i18n 校验——
 * 实测过一次「键少了 page. 前缀」导致 95 处文案渲染成原始 key 的事故，故补这条门禁）。
 *
 * 做法：扫 apps/web-antd/src/{views,api}/iot 下的 $t('...') 调用，
 * 按**运行期命名空间**（locales/langs/<lang>/<file>.json 的 fileName 即顶层命名空间，
 * 见 packages/locales/src/i18n.ts）在 zh-CN 与 en-US 两份语言包里逐键解析。
 *
 * 用法：node scripts/check-iot-i18n-keys.mjs   （缺键则退出码 1）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN_DIRS = ['apps/web-antd/src/views/iot', 'apps/web-antd/src/api/iot'];
const LANGS = ['zh-CN', 'en-US'];
/**
 * 语言包目录（**必须都收**）：应用自己的文案 + 共享语言包（`common.*`/`ui.*` 来自后者）。
 * 只收前者会把共享命名空间误报成缺键（实测 30 个假阳性 ⇒ 这种门禁比没有更糟）。
 */
const LOCALE_DIRS = [
  'apps/web-antd/src/locales/langs',
  'packages/locales/src/langs',
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|vue)$/.test(entry)) out.push(full);
  }
  return out;
}

/** 递归收集文件里 $t('x.y') / $t("x.y") 的键（含带参数形式 $t('k', [...])）。 */
function usedKeys(file) {
  const code = readFileSync(file, 'utf8');
  const keys = new Set();
  const matcher = /\$t\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = matcher.exec(code)) !== null) keys.add(match[1]);
  return keys;
}

function loadLang(lang) {
  const messages = {};
  const usedDirs = [];
  for (const base of LOCALE_DIRS) {
    const dir = join(ROOT, base, lang);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    usedDirs.push(base);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const ns = file.replace(/\.json$/, '');
      messages[ns] = { ...(messages[ns] ?? {}), ...JSON.parse(readFileSync(join(dir, file), 'utf8')) };
    }
  }
  if (usedDirs.length === 0) {
    console.error(`[i18n] ${lang} 一个语言包目录都没扫到 ⇒ 门禁空跑`);
    process.exit(1);
  }
  console.log(`[i18n] ${lang} 语言包目录：${usedDirs.join(', ')}`);
  return messages;
}

function resolve(messages, key) {
  const parts = key.split('.');
  let node = messages;
  for (const part of parts) {
    if (node === undefined || node === null || typeof node !== 'object' || !(part in node)) return false;
    node = node[part];
  }
  return typeof node === 'string';
}

const files = SCAN_DIRS.flatMap((dir) => {
  try {
    return walk(join(ROOT, dir));
  } catch {
    return [];
  }
});
if (files.length === 0) {
  console.error('[i18n] 一个 IoT 源文件都没扫到 ⇒ 门禁空跑（教训八：0 违规可能是没跑到）');
  process.exit(1);
}

let failed = false;
for (const lang of LANGS) {
  const messages = loadLang(lang);
  const missing = [];
  for (const file of files) {
    for (const key of usedKeys(file)) {
      if (!resolve(messages, key)) missing.push(`${relative(ROOT, file)} → ${key}`);
    }
  }
  if (missing.length > 0) {
    failed = true;
    console.error(`[i18n] ${lang} 缺失 ${missing.length} 个键：`);
    for (const item of missing) console.error(`  - ${item}`);
  } else {
    console.log(`[i18n] ${lang} OK（${files.length} 个文件）`);
  }
}
process.exit(failed ? 1 : 0);
