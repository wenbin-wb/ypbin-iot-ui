/**
 * vxe「静默丢弃」守卫（上一轮已批、本轮落地：query 客户端超时 + trailing 重发 + 可见加载态）。
 *
 * 🔴 丢的是哪一次：vxe `commitProxy` 在途守卫（`grid.js:957` 一带）——
 * `if (!isInited && reactData.tableLoading) return nextTick()`：查询在途时再来的
 * `query`/`reload` **直接 return，`ajax.query` 根本不会被调用**。
 * 表现：用户点刷新/翻页时正赶上慢请求，点击『什么都没发生』——没报错、没加载态、数据保留旧的。
 *
 * 本模块把三件事收口（全部可单测，不依赖真实布局）：
 * 1. **query 客户端超时**（`withQueryTimeout`）：`ajax.query` 不无限挂起，超时抛
 *    `QueryTimeoutError` ⇒ 页面沿既有失败链展示可见错误并结束 loading；
 * 2. **trailing 重发**（`createRefreshGuard`）：凡被丢弃的查询意图（页面代码/工具栏
 *    刷新/翻页/表单提交，统一由 `markIntent()` 登记），在当前周期结束后用**最新状态**
 *    自动补发一次 ⇒ 「点了刷新却什么都没发生」不再存在；
 * 3. **可见加载态**（`onTrailing`）：补发前的空窗期把外部 loading 拉起来，
 *    用户能看见动作被接住了，而不是以为按钮坏了。
 *
 * 边界（刻意不做，避免静默重试循环）：
 * - 查询**失败/超时**不自动重发（那是错误展示的职责；失败时 `consumeIntent` 已消费意图）；
 * - `createSerialRunner`（摘要）不重复 —— 摘要不走 vxe，那条竞态已由它单独守。
 *
 * 实现说明：本守卫只依赖「意图标记 + 周期结束」两个信号，都是页面自有代码能给出的
 * （`ajax.query` 开始/结束），不依赖对 vxe 内部做的任何假设以外的行为。
 * 「周期结束」由页面在 `ajax.query` 的 finally 里调用 `notifyCycleEnd()` 提供
 * （成功与失败都算；被丢弃的查询根本不会走到 ajax.query，这正是要守的洞）。
 */

export const QUERY_TIMEOUT_MS = 15_000;

export const TRAILING_IDLE_RETRY_MS = 80;
export const TRAILING_IDLE_MAX_RETRIES = 5;

/** 客户端超时的标记错误：`ajax.query` 据此改写成用户可见的人话（见 index.vue）。 */
export class QueryTimeoutError extends Error {
  constructor() {
    super('query timeout');
    this.name = 'QueryTimeoutError';
  }
}

/**
 * 给查询加客户端超时：超时抛 `QueryTimeoutError`，先到者胜。
 *
 * 注意：底层 promise 仍在跑（结果被丢弃），但它的成功/失败分支都已挂 handler，
 * 不会产生未处理拒绝；这就是「客户端超时」的本意 —— 用户永远等不到无限挂起。
 */
export function withQueryTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = QUERY_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new QueryTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface RefreshGuardOptions {
  /** 当前是否「在途」（vxe tableLoading）—— 在途时的再次查询会被丢弃 */
  isBusy(): boolean;
  /** 无条件发一次查询（= 直接 commitProxy；守卫保证调用时已不忙，不会被丢弃） */
  issue(): void;
  /** trailing 补发期间的外部可见 loading（true=拉起，false=交给 vxe 自己的 loading / 结束） */
  onTrailing?(active: boolean): void;
}

export interface RefreshGuard {
  /** 任何查询意图（工具栏刷新/翻页/表单提交事件、页面代码）到此登记 */
  markIntent(): void;
  /** `ajax.query` 真正开始时调用 —— 证明该意图已被执行（反之即被丢弃） */
  consumeIntent(): void;
  /** 页面代码主动刷新入口：不忙立即发，忙则只登记（周期结束后补发） */
  request(): void;
  /** `ajax.query` 结束时调用（成功与失败都算） */
  notifyCycleEnd(): void;
  dispose(): void;
}

/**
 * 创建一格的「静默丢弃」守卫。
 *
 * 状态机（单布尔意图 + 周期结束信号）：
 * - `markIntent`/`request` 置意图；`ajax.query` 执行说明意图被消费（`consumeIntent`）；
 * - 周期结束若意图仍在 ⇒ 那次查询被 vxe 丢弃了 ⇒ 等 vxe 把 `tableLoading` 复位
 *   （轮询 `isBusy`，最多 `TRAILING_IDLE_MAX_RETRIES` 次）后用最新状态补发一次，
 *   补发前把外部 loading 拉起（`onTrailing(true)`）。
 */
export function createRefreshGuard(options: RefreshGuardOptions): RefreshGuard {
  let disposed = false;
  let intentPending = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function clearTimers() {
    if (retryTimer) clearTimeout(retryTimer);
    if (idleTimer) clearTimeout(idleTimer);
    retryTimer = undefined;
    idleTimer = undefined;
  }

  function handleCycleEnd() {
    if (disposed) return;
    if (!intentPending) {
      return;
    }
    // 本周期里有「没被执行的意图」⇒ 补发
    intentPending = false;
    options.onTrailing?.(true);
    let tries = 0;
    const tryIssue = () => {
      if (disposed) return;
      if (options.isBusy()) {
        if (tries >= TRAILING_IDLE_MAX_RETRIES) {
          // 等不到空闲：放弃本轮（用户若再次刷新会重新登记意图）
          options.onTrailing?.(false);
          idleTimer = undefined;
          return;
        }
        tries += 1;
        idleTimer = setTimeout(tryIssue, TRAILING_IDLE_RETRY_MS);
        return;
      }
      options.onTrailing?.(false); // vxe 自己的 loading 接管补发
      options.issue();
      idleTimer = undefined;
    };
    // vxe 在 ajax.query 收尾之后才把 tableLoading 置回 false，让出一个宏任务再判断
    retryTimer = setTimeout(tryIssue, 0);
  }

  return {
    markIntent() {
      if (disposed) return;
      intentPending = true;
    },
    consumeIntent() {
      intentPending = false;
    },
    request() {
      if (disposed) return;
      intentPending = true;
      if (options.isBusy()) {
        // 会被丢弃 ⇒ 只登记，交给 handleCycleEnd 补发
        return;
      }
      options.issue();
    },
    notifyCycleEnd() {
      handleCycleEnd();
    },
    dispose() {
      disposed = true;
      intentPending = false;
      clearTimers();
    },
  };
}
