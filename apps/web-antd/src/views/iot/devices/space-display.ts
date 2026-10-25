/**
 * 设备「所在空间」列的展示拆分。
 *
 * <p>后端返回的 `spaceText` 形如「总部园区/A栋/1F/101室 +2」——主空间路径 + 还有几个其它空间。
 * 列表里两部分要用不同颜色（主路径醒目、`+N` 次要）。</p>
 *
 * <p><b>为什么抽成纯函数</b>：这段解析此前写在模板里用 `split(' +')` 两次，
 * 而「空间名本身含 " +"」这种边界只会在真实数据里出现、不会红任何用例。
 * 抽出来后可以单测，也让模板只剩一处取值。</p>
 *
 * @param spaceText 后端返回的展示文本（可能为空）
 * @returns 主路径与「其它空间数」（无 `+N` 时 others 为 0）
 */
export function splitSpaceText(spaceText?: null | string): {
  others: number;
  primary: string;
} {
  const text = spaceText?.trim() ?? '';
  if (!text) {
    return { others: 0, primary: '' };
  }
  // 只切**最后一处** " +数字"：空间名里可能含 " +"（如「A+栋」），
  // 用 lastIndexOf 而不是 split(' +') 才不会把名字切坏。
  const match = / \+(\d+)$/.exec(text);
  if (!match) {
    return { others: 0, primary: text };
  }
  return {
    others: Number(match[1]),
    primary: text.slice(0, match.index),
  };
}
