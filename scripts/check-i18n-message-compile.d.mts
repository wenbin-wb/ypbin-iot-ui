/**
 * `check-i18n-message-compile.mjs` 的类型声明。
 *
 * 为什么需要它：测试（TypeScript）要复用门禁脚本里的 `collectLeafKeys`——**遍历口径只允许一处实现**，
 * 否则「测试认为的叶子」与「CI 门禁认为的叶子」迟早漂移，出现「测试绿、CI 绿、线上红」。
 * 而脚本本身是 .mjs（Node 直接执行，不经 TS 编译），故用与 `x.mjs` 配对的 `x.d.mts` 提供类型。
 */

/** 仓库根目录（由脚本自身 `import.meta.url` 推导）。 */
export declare const ROOT: string;

/** 被扫描的语言包目录（相对仓库根）。 */
export declare const LOCALE_DIRS: string[];

/** 被扫描的语言。 */
export declare const LANGS: string[];

/** 用真实 vue-i18n 建一个实例（`messages` 为「命名空间 → 该语言包内容」）。 */
export declare function createI18nFor(
  lang: string,
  messages: Record<string, unknown>,
): {
  locale: { value: string };
  t: (key: string) => string;
  mergeLocaleMessage: (lang: string, message: unknown) => void;
};

/**
 * 递归收集**字符串叶子**键（中间节点是命名空间对象，vue-i18n 对对象不编译）。
 * @param node 语言包对象（或任意子节点）
 * @param prefix 前缀（首次调用可省略）
 */
export declare function collectLeafKeys(
  node: unknown,
  prefix?: string,
): string[];

/** 读入某语言的全部语言包，按命名空间（= 文件名）合并。 */
export declare function loadLangMessages(
  lang: string,
  localeDirs?: string[],
): {
  files: string[];
  messages: Record<string, Record<string, unknown>>;
  usedDirs: string[];
};

/** 编译某语言的全部（或某前缀下的）叶子文案。 */
export declare function compileLang(
  lang: string,
  options?: { namespace?: string },
): {
  compiled: number;
  failures: { key: string; reason: string }[];
  scannedFiles: string[];
  usedDirs: string[];
};

/** 全库扫描（默认 zh-CN + en-US）。 */
export declare function scanAll(options?: {
  languages?: string[];
  namespace?: string;
}): {
  failures: { lang: string; key: string; reason: string }[];
  compiled: number;
  scannedFiles: number;
};
