/**
 * 设备台账列表页动作的**纯逻辑**（禁用原因 / 批量播报口径 / 删除后页码回落）。
 *
 * 为什么单独一层：这三件事都属于「做错了界面给出的结论就是错的」但又与 vue/vxe 无关的部分：
 * - 禁用原因判错 ⇒ 用户看到一排灰按钮却不知道为什么；
 * - 播报口径用勾选数代替后端实际生效台数 ⇒ 破坏性操作后给出错误结论；
 * - 删空当前页后不回退页码 ⇒ 把「本页空了」说成「整个租户没有设备」。
 * 抽成纯函数后可穷举边界，页面只负责把结果接进 UI。
 */

// ---------------------------------------------------------------- 禁用原因

/** 批量按钮的禁用原因（空串 = 可用）。 */
export type BatchDisabledReason = '' | 'noSelection' | 'pending';

/**
 * 批量按钮为什么禁用。
 *
 * 优先报「请求在途」：此时用户刚点过按钮，最需要知道的是「已在提交，别重复点」；
 * 未勾选是静态状态，提示不会丢失。
 */
export function resolveBatchDisabledReason(
  selectedCount: number,
  pending: boolean,
): BatchDisabledReason {
  if (pending) {
    return 'pending';
  }
  return selectedCount > 0 ? '' : 'noSelection';
}

// ---------------------------------------------------------------- 批量播报口径

/** 一次批量写操作的实际结果档位（决定播报文案与级别）。 */
export type BatchOutcomeLevel = 'full' | 'none' | 'partial';

export interface BatchOutcome {
  /** 实际生效台数（后端 `R<Integer>`；后端未返回计数时回落到勾选数并标记 unknown）。 */
  affected: number;
  level: BatchOutcomeLevel;
  /** 勾选但未生效的台数（`level='partial'` 时 > 0）。 */
  notEffective: number;
  /** 是否真的拿到了后端计数（false = 老后端未返回计数，按勾选数展示，不能声称已核实）。 */
  verified: boolean;
}

/**
 * 把「勾选台数 + 后端实际生效台数」解释成播报口径。
 *
 * @param selectedCount 本次勾选的台数
 * @param affectedRaw 后端返回的实际生效台数（`R<Integer>`，可能缺失/为字符串/为 0）
 *
 * 口径（与后端 `IotDeviceController` 的 `R<Integer>` 语义一一对应）：
 * - `affected === 0` ⇒ **无变更**（勾中的设备已被他人删除，或已处于目标状态未命中 `UPDATE`）；
 * - `affected < selectedCount` ⇒ **部分未生效**（必须明确说出来，不能报「已处理 N 台」）；
 * - `affected >= selectedCount` ⇒ 全部生效。
 *
 * 后端**没有**返回计数时（`affectedRaw` 缺失/非有限数）按勾选数播报并置 `verified=false`：
 * 这是唯一不凭空造数字的退路（老后端兼容），页面文案不得声称已核实实际台数。
 */
export function resolveBatchOutcome(
  selectedCount: number,
  affectedRaw?: null | number | string,
): BatchOutcome {
  const selected = Math.max(Math.trunc(selectedCount), 0);
  const parsed =
    affectedRaw === null || affectedRaw === undefined || affectedRaw === ''
      ? Number.NaN
      : Number(affectedRaw);
  const verified = Number.isFinite(parsed);
  const affected = verified ? Math.max(Math.trunc(parsed), 0) : selected;
  if (affected === 0) {
    return { affected, level: 'none', notEffective: selected, verified };
  }
  if (affected < selected) {
    return {
      affected,
      level: 'partial',
      notEffective: selected - affected,
      verified,
    };
  }
  return { affected, level: 'full', notEffective: 0, verified };
}

// ---------------------------------------------------------------- 删除后页码

/** 分页状态（取 vxe `reactData.tablePage` 的当前值）。 */
export interface PagerSnapshot {
  /** 当前页码（1-based）。 */
  currentPage: number;
  /** 每页条数。 */
  pageSize: number;
  /** 删除前的总条数（后端 total）。 */
  totalBefore: number;
}

export interface DeletePagerInput extends PagerSnapshot {
  /** 删除前本页可见行数（`gridApi.grid.getData()`）。 */
  visibleCount: number;
  /** 本次**实际生效**的删除台数（后端返回行数；批量时可能小于勾选数）。 */
  deletedCount: number;
}

/**
 * 删除成功后应该查询哪一页。
 *
 * 🔴 为什么需要它：vxe `commitProxy` 只在 `initial`/`reload` 时重置页码（4.22.4
 * `grid.js:968`），页面用的 `query` **保留当前页** ⇒ 删光最后一页的最后一条后仍查 `page=N`，
 * 结果是一张空表，而 `#empty` 槽会把它说成「还没有设备」（用户以为数据被清空）。
 *
 * 规则：
 * - 删除后本页仍有行 ⇒ 留在当前页；
 * - 本页被删空且不是第一页 ⇒ 回退一页（不前进，避免把用户带到更靠后的页）；
 *   同时不得越过「删完后还剩数据的最后一页」（例如一次批量删掉整整一页时）。
 */
export function resolvePageAfterDelete(input: DeletePagerInput): number {
  const { currentPage, pageSize, totalBefore, visibleCount, deletedCount } =
    input;
  const page = Math.max(Math.trunc(currentPage), 1);
  if (page <= 1 || deletedCount <= 0) {
    return page;
  }
  const remainingOnPage = Math.max(
    Math.trunc(visibleCount) - Math.trunc(deletedCount),
    0,
  );
  if (remainingOnPage > 0) {
    return page;
  }
  const remainingTotal = Math.max(
    Math.trunc(totalBefore) - Math.trunc(deletedCount),
    0,
  );
  const size = Math.max(Math.trunc(pageSize), 1);
  const lastPage = Math.max(Math.ceil(remainingTotal / size), 1);
  return Math.max(1, Math.min(page - 1, lastPage));
}

/**
 * 一次查询**返回了空页但总数不为 0** 时应该改查哪一页（0 表示不必改）。
 *
 * 与 {@link resolvePageAfterDelete} 的分工：那个是「删除前预判」，这个是「查完兜底」——
 * 空页也可能由别的原因造成（同事删了数据、实时删除事件触发刷新、筛选条件变化），
 * 页面不能只在删除回调里防。查到空页且 `total > 0` 就说明数据在别的页，
 * 直接改查「还有数据的最后一页」，`#empty` 槽才不会把「本页空了」说成「一台设备都没有」。
 */
export function resolvePageAfterEmptyQuery(
  pageSize: number,
  total: number,
): number {
  const size = Math.max(Math.trunc(pageSize), 1);
  const count = Math.max(Math.trunc(total), 0);
  if (count === 0) {
    return 0;
  }
  return Math.max(Math.ceil(count / size), 1);
}
