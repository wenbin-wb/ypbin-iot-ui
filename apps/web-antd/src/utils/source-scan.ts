/**
 * 静态源码扫描测试用的工具（**只服务于 `*.test.ts` 的源码断言**，不进运行时）。
 *
 * 为什么不用正则去 HTML 注释：`String#replace` 去掉多字符标记（`<!--`）时，
 * 可能把相邻内容重新拼成新的标记，CodeQL 的 `js/incomplete-multi-character-sanitization`
 * 会据此判为「不完整净化」（2026-10-20 PR #118 在测试文件里被扫出 1 条 high）。
 * 这里改为线性扫描 + 按索引切片：只丢弃 `<!-- ... -->` 之间的内容，不做字符串替换，
 * 既不产生新标记，也不依赖正则回溯。
 */

/** 去掉 HTML 注释（未闭合的尾部注释整段丢弃，与浏览器行为一致）。 */
export function stripHtmlComments(source: string): string {
  let result = '';
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('<!--', index);
    if (start === -1) {
      result += source.slice(index);
      break;
    }
    result += source.slice(index, start);
    const end = source.indexOf('-->', start + 4);
    if (end === -1) {
      break;
    }
    index = end + 3;
  }
  return result;
}

/**
 * 把 HTML 注释替换成**等长空白**（保留换行，行号/列号仍可核对）。
 *
 * 与 {@link stripHtmlComments} 的区别：静态断言需要报告准确行号，所以不能删除字符。
 * 同样用索引切片 + 逐字符填充，不做多字符 `replace`（避免 CodeQL 的
 * `js/incomplete-multi-character-sanitization` 误报）。
 */
export function blankHtmlComments(source: string): string {
  const blank = (text: string) => text.replaceAll(/[^\n]/g, ' ');
  let result = '';
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('<!--', index);
    if (start === -1) {
      result += source.slice(index);
      break;
    }
    result += source.slice(index, start);
    const end = source.indexOf('-->', start + 4);
    if (end === -1) {
      // 未闭合：其余整段按注释处理（保留换行）
      result += blank(source.slice(start));
      break;
    }
    result += blank(source.slice(start, end + 3));
    index = end + 3;
  }
  return result;
}
