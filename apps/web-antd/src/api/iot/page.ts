/**
 * IoT 接口**分页响应信封**的唯一定义（2026-10-20 审查 01 §P2-5「PageResult 7 份重复」收口）。
 *
 * ## 为什么单独一个模块
 *
 * 收口前 `alert` / `command` / `device` / `platform-alert` / `event` / `product` /
 * `device-import` 7 个模块各写一份完全相同的 `PageResult<T>`，口径注释也各抄一遍。
 * 后端一改信封（加 `pages`、改字段名、类型变化）就要同步 7 处，漏一处就是该页面分页
 * 在类型层悄悄失真。收口后只在这里定义一次，7 个模块用兼容别名引用。
 *
 * ## 口径（**不是防御性编程，是后端真实返回**）
 *
 * 后端 Jackson 全局把 `Long`/`BigInteger`/`BigDecimal` 序列化成**字符串**
 * （`ypbin.json.write-big-number-as-string`，默认 `true`，见 starter-json 的
 * `JacksonAutoConfiguration`）；而分页信封 `PageResult.total/page/pageSize` 在服务端都是
 * `long` ⇒ 线上真实返回形如：
 *
 * ```json
 * { "items": [], "total": "17", "page": "1", "pageSize": "10", "pages": "2" }
 * ```
 *
 * 因此这里按**真实返回**把三个计数字段声明为 `number | string`，而不是 `number`：
 * - 分页组件（antdv `Pagination.total` / vxe pager）的 prop 是 `number`，喂字符串是契约违例；
 * - `"0"` 是**真值**，`if (total)` 形态的判断会被字符串悄悄带偏；
 * - `"17" + 1` 是字符串拼接、`"17" - 1` 才是 `16`。
 *
 * 消费方**必须**用 `#/utils/backend-number` 的 `toBackendNumber` 显式转数；
 * **禁止** `as number` 断言——那是把口径分歧藏起来，运行时照样拿到字符串。
 * `pages` 字段后端也会返回，但当前前端不使用，故不声明（需要时再加，仍然只改这里）。
 *
 * @see `#/utils/backend-number` 唯一转换点（`toBackendNumber`）
 */

/** 分页响应信封（后端 `PageResult`）：`total/page/pageSize` 是 `long` ⇒ `number | string`。 */
export interface IotPageResult<T> {
  /** 当前页数据（空结果为**空数组**，不是 `null`）。 */
  items: T[];
  /** 总条数（后端 `long` ⇒ 字符串形态；用 `toBackendNumber` 转数）。 */
  total: number | string;
  /** 当前页码（后端 `long` ⇒ 字符串形态；用 `toBackendNumber` 转数）。 */
  page: number | string;
  /** 每页条数（后端 `long` ⇒ 字符串形态；用 `toBackendNumber` 转数）。 */
  pageSize: number | string;
}

/**
 * 历史命名兼容别名（`PageResult<T>`）。
 *
 * 保留原因：`IotXxxApi.PageResult` 是各 api namespace 既有的对外类型名，外部可能
 * 已经引用（本次已 grep 确认当前无仓外引用，但 llm/脚本生成的代码可能仍在用）。
 * 新代码请优先写 `IotPageResult<T>`。
 */
export type PageResult<T> = IotPageResult<T>;
