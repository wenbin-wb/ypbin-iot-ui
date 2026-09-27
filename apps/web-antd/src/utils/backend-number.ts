/**
 * 后端「计数类」字段的安全转数（分页 `total` / `page` / `pageSize` / 时间戳毫秒等）。
 *
 * 背景（**不是防御性编程，是口径对齐**）：后端全局 Jackson 把 Long/BigInteger/BigDecimal
 * 序列化成**字符串**（`ypbin.json.write-big-number-as-string`，默认 `true`；
 * 见 `ypbin-starter-json` 的 `JacksonAutoConfiguration`）。而 `PageResult.total/page/pageSize`
 * 在后端是 `long` ⇒ 线上真实返回形如 `{"total":"17","page":"1","pageSize":"10"}`。
 *
 * 所以 API 层一律声明 `number | string`，消费处**必须**显式转数：
 * - 分页组件（antdv `Pagination.total` / vxe pager）的 prop 是 `number`，喂字符串是契约违例；
 * - `"0"` 是**真值**，任何 `if (total)` 形态的判断会被字符串悄悄带偏；
 * - `"17" + 1` 会变成 `"171"`（字符串拼接），而 `"17" - 1` 才是 `16`。
 *
 * 用 `as number` 断言是禁止的——那是把口径分歧藏起来，运行时照样拿到字符串。
 *
 * @param value 后端回传的计数（`number` / 数字字符串 / 空）
 * @returns 合法有限数则原样返回，否则 0（空、非数字串、NaN、Infinity 一律 0，且**不静默**——
 *          调用方若要区分「真的 0」与「取不到」，应自己先判空，本函数只保证不会有 NaN 泄漏到界面）
 */
export function toBackendNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  // 空串 / null / undefined / 非字符串非数字一律 0：`Number('')` 是 0、`Number(null)` 是 0，
  // 但 `Number(undefined)` 与 `Number('abc')` 是 NaN ⇒ 统一收敛，避免 NaN 渲染到界面
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
