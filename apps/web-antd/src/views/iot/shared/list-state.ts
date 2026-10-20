/**
 * 列表三态解析的**唯一实现**（2026-10-20 审查 P2「三态解析 6 份逐字重复」收口）。
 *
 * ## 为什么要有这个模块
 *
 * 本仓有多处列表把「加载中 / 失败 / 空 / 有数据」画成不同形态，而「失败 vs 空」的判定
 * 一度在 6 个 state 模块里各写一遍（tag / import / trace / point-mapping / 平台告警 /
 * OpenAPI Key），连注释都是同一段。重复判据的风险是**漂移**：某天只在一处把顺序改成
 * 「先判空再判错」，该页面就会在请求失败时显示「还没有数据」——本仓设备台账页踩过这个坑
 * （2026-10 审查 P2「失败态与空态混用」）。
 *
 * 收口后只保留两条判据，语义写死在这里并由 `list-state.test.ts` 守门：
 * 1. **`loading` 优先于失败**：加载中不展示错误（与收口前 6 份实现逐字一致的顺序，
 *    否则首屏「加载中 → 闪一下失败 → 成功」会造成假失败）；
 * 2. **失败优先于空**：只要有 `errorMessage`，即使 `itemCount === 0` 也返回 `error`，
 *    绝不让页面把「请求失败」画成「没有数据」。
 *
 * 本文件零依赖（不 import vue/antdv/api），因此用例可直接在任意环境跑，不受依赖链拖累。
 */

/** 列表三态（含加载中）：供 vxe 表格 / antd 表格 / 自绘列表统一使用。 */
export type ListState = 'empty' | 'error' | 'loading' | 'ready';

/** {@link resolveListState} 的入参（具名对象，避免 6 处不同位置参数顺序再次漂移）。 */
export interface ListStateInput {
  /** 加载失败原因（非空即失败；`null`/`undefined`/空串都视为无错误）。 */
  errorMessage?: null | string;
  /** 当前已拿到的条目数（`> 0` ⇒ `ready`，否则 `empty`）。 */
  itemCount: number;
  /** 是否正在加载（默认 `false`）。 */
  loading?: boolean;
}

/**
 * 判定列表该渲染哪种状态。
 *
 * 顺序是契约的一部分（见模块头注释）：**loading > error > empty/ready**。
 *
 * @param input 错误信息 / 条目数 / 加载态
 * @returns 列表状态（四值之一）
 */
export function resolveListState(input: ListStateInput): ListState {
  const { errorMessage, itemCount, loading = false } = input;
  if (loading) {
    return 'loading';
  }
  if (errorMessage) {
    // 失败**优先于空**：请求失败时页面绝不能声称「没有数据」
    return 'error';
  }
  return itemCount > 0 ? 'ready' : 'empty';
}

/**
 * `#empty` 槽位三态（无 loading 维度）。
 *
 * 告警中心把判据抽成纯函数是为了让「失败绝不画成空态」有可运行用例守门
 * （`alerts/list-state.ts` 头注释记录过：删掉模板里的 `v-if="!listError"` 后
 * 模板级断言抓不住，必须是可运行判据）。
 */
export type ListSlotState = 'content' | 'empty' | 'error';

/**
 * 判定 vxe `#empty` 槽该渲染什么。
 *
 * @param errorMessage 非空表示本次加载失败（原样展示后端 message）
 * @param rowCount     当前已取回的行数
 * @returns `error` 优先于 `empty`；有行则为 `content`
 */
export function resolveListSlotState(
  errorMessage?: null | string,
  rowCount = 0,
): ListSlotState {
  if (errorMessage) {
    return 'error';
  }
  return rowCount > 0 ? 'content' : 'empty';
}
