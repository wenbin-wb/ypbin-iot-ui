/**
 * i18n **文案编译**门禁（可复用库 + CLI）。
 *
 * 为什么需要它（与 `check-iot-i18n-keys.mjs` 的区别）：
 * 那条门禁只证明「键**存在**」，证明不了「值能不能被编译」。2026-09-27 的线上事故正是卡在这条缝里：
 * `page.iot.debug.valueHint` 等 3 条文案写了未转义的字面 `{` `}`（如 `{"a":1}`），vue-i18n 在
 * **渲染期**编译消息时抛 `SyntaxError: Message compilation error` ⇒ 整个子树渲染成 `<!---->`
 * （内容区全白）。当时 typecheck / 构建 / 键存在性校验**全绿**——键确实存在，只是编译不过。
 *
 * 本模块用**真实 vue-i18n**（与生产同一实现，无桩）逐条编译语言包里的每个字符串叶子键，
 * 谁编译不过就**点名谁**。含未转义 `{...}` 的文案一律失败——不止 JSON 示例，
 * 正则片段（`{\d+}`）、花括号模板串同样会失败。
 *
 * 用法：
 *   node scripts/check-i18n-message-compile.mjs                      # 全库（zh-CN + en-US）
 *   node scripts/check-i18n-message-compile.mjs --namespace page.iot # 只查某前缀（可复用）
 *   node scripts/check-i18n-message-compile.mjs --json               # 机器可读输出
 *
 * 自检（教训八：0 违规可能是「没跑到」）：必须真的扫到语言包文件、且编译条数达下限，
 * 否则以退出码 1 报「门禁空跑」，不允许「一个键都没编译却报绿」。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = new URL('..', import.meta.url).pathname;

/**
 * 语言包目录（**全库**）：各应用的文案 + 共享语言包。
 * 同一文件名即同一命名空间（`page.json` → `page.*`），应用包与共享包会按命名空间合并。
 */
export const LOCALE_DIRS = [
  'apps/web-antd/src/locales/langs',
  'apps/web-antdv-next/src/locales/langs',
  'apps/web-ele/src/locales/langs',
  'apps/web-naive/src/locales/langs',
  'apps/web-tdesign/src/locales/langs',
  'packages/locales/src/langs',
  'playground/src/locales/langs',
];

export const LANGS = ['zh-CN', 'en-US'];

/**
 * 全库编译条数下限（限定了 `--namespace` 时改用 1）。
 * 远低于真实规模（数千条）的保守值：只在「遍历退化 / 语言包没扫到」时触发，正常删减文案不会误报。
 */
const MIN_COMPILED = 500;

const require = createRequire(join(ROOT, 'packages/locales/package.json'));

/** 真实 vue-i18n（与生产同一实现，不做任何桩）。 */
export function createI18nFor(lang, messages) {
  const { createI18n } = require('vue-i18n');
  return createI18n({
    legacy: false,
    locale: lang,
    messages: { [lang]: messages },
  }).global;
}

/**
 * 递归收集**字符串叶子**键。
 *
 * 只迭代一层是空转：`page.iot` 下的中间节点是命名空间对象，vue-i18n 对对象**不编译**
 * （只打一条 Not found 警告），等于门禁没跑。
 */
export function collectLeafKeys(node, prefix = '') {
  if (typeof node === 'string') return prefix === '' ? [] : [prefix];
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [];
  const keys = [];
  for (const [key, value] of Object.entries(node)) {
    keys.push(
      ...collectLeafKeys(value, prefix === '' ? key : `${prefix}.${key}`),
    );
  }
  return keys;
}

/** 逐目录读入某语言的所有语言包，按命名空间（= 文件名）合并。 */
export function loadLangMessages(lang, localeDirs = LOCALE_DIRS) {
  const messages = {};
  const usedDirs = [];
  const files = [];
  for (const base of localeDirs) {
    const dir = join(ROOT, base, lang);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    usedDirs.push(base);
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const full = join(dir, file);
      if (!statSync(full).isFile()) continue;
      const namespace = file.replace(/\.json$/, '');
      files.push(relative(ROOT, full));
      messages[namespace] = {
        ...(messages[namespace] ?? {}),
        ...JSON.parse(readFileSync(full, 'utf8')),
      };
    }
  }
  return { files, messages, usedDirs };
}

/**
 * 编译某语言的全部（或某前缀下的）叶子文案。
 * @returns {{compiled: number, failures: Array<{key: string, reason: string}>, scannedFiles: string[], usedDirs: string[]}}
 */
export function compileLang(lang, { namespace } = {}) {
  const { files, messages, usedDirs } = loadLangMessages(lang);
  const global = createI18nFor(lang, messages);

  const keys = [];
  for (const [namespaceName, value] of Object.entries(messages)) {
    keys.push(...collectLeafKeys(value, namespaceName));
  }
  const scoped = namespace
    ? keys.filter(
        (key) => key === namespace || key.startsWith(`${namespace}.`),
      )
    : keys;

  const failures = [];
  for (const key of scoped) {
    try {
      global.t(key);
    } catch (error) {
      failures.push({
        key,
        reason: String(error?.message ?? error).split('\n')[0],
      });
    }
  }
  return { compiled: scoped.length, failures, scannedFiles: files, usedDirs };
}

/** 全库扫描（默认 zh-CN + en-US）。 */
export function scanAll({ languages = LANGS, namespace } = {}) {
  const failures = [];
  const scannedFiles = new Set();
  let compiled = 0;
  for (const lang of languages) {
    const result = compileLang(lang, { namespace });
    for (const file of result.scannedFiles) scannedFiles.add(file);
    compiled += result.compiled;
    for (const failure of result.failures) failures.push({ lang, ...failure });
  }
  return { failures, compiled, scannedFiles: scannedFiles.size };
}

function main(argv) {
  const json = argv.includes('--json');
  const namespaceIndex = argv.indexOf('--namespace');
  const namespace =
    namespaceIndex === -1 ? undefined : argv[namespaceIndex + 1];
  if (namespaceIndex !== -1 && !namespace) {
    console.error('[i18n-compile] --namespace 后必须跟一个前缀');
    process.exit(2);
  }

  const { failures, compiled, scannedFiles } = scanAll({ namespace });
  const scope = namespace ? `（限定前缀 ${namespace}）` : '（全库）';

  // 空跑自检优先：扫不到文件、或编译条数低得离谱 ⇒ 是门禁坏了，不是代码干净。
  // 必须**先**判它，否则会出现「先报 OK、再报空跑」这种自相矛盾的输出。
  const floor = namespace ? 1 : MIN_COMPILED;
  const vacuous = scannedFiles === 0 || compiled < floor;

  if (json) {
    console.log(
      JSON.stringify(
        { compiled, failures, scannedFiles, vacuous },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[i18n-compile] ${LANGS.join(' + ')}${scope}：扫到 ${scannedFiles} 个语言包文件，编译 ${compiled} 条文案`,
    );
    if (vacuous) {
      console.error(
        `[i18n-compile] 门禁空跑：scannedFiles=${scannedFiles} compiled=${compiled}（下限 ${floor}）` +
          '（教训八：0 违规可能是「没跑到」）',
      );
    } else if (failures.length > 0) {
      console.error(`[i18n-compile] ${failures.length} 条文案编译失败：`);
      for (const { lang, key, reason } of failures) {
        console.error(`  - [${lang}] ${key} → ${reason}`);
      }
    } else {
      console.log('[i18n-compile] OK：没有编译不过的文案');
    }
  }

  if (vacuous) process.exit(1);
  process.exit(failures.length > 0 ? 1 : 0);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2));
}
