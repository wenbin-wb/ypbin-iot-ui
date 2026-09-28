/**
 * 告警列表页的两个**纯判据**（无任何 import ⇒ 用例可以在本机直接跑，不被 api/request 依赖链拖累）。
 *
 * 它们承载两条本仓已收口过的纪律：
 * 1. **失败绝不画成空态**（`listSlotState`）——「加载失败」与「确实没有数据」在 vxe 的 `#empty` 槽里
 *    长得一样，把失败画成空态会让用户永久留下「没有数据」这个错误结论；
 * 2. **设备过滤的合并顺序**（`resolveDeviceFilter`）——表单里显式选的设备优先于 URL 带来的设备，
 *    否则「清空筛选」会被 URL 参数悄悄抵消。
 *
 * 抽成纯函数是为了让这两条纪律**有可运行的用例守门**：判据写在模板里时，回归无法被咬住
 * （独立复核 2026-10-03 实测：删掉模板里的 `v-if="!listError"` 后，可运行用例无一转红）。
 */

/** 列表槽位状态：失败优先于空。 */
export type ListSlotState = 'content' | 'empty' | 'error';

/**
 * 决定列表 `#empty` 槽渲染什么。
 *
 * @param error    非空表示本次加载失败（原样展示后端 message）
 * @param rowCount 当前已取回的行数
 * @returns `error` 优先于 `empty`；有行则为 `content`
 */
export function listSlotState(error: string, rowCount: number): ListSlotState {
  if (error !== '') {
    return 'error';
  }
  return rowCount > 0 ? 'content' : 'empty';
}

/**
 * 设备过滤的合并规则。
 *
 * @param formDeviceId   筛选表单里选的设备
 * @param presetDeviceId 从设备台账带过来的 `?deviceId=`
 * @returns 生效的设备过滤；两者都为空则 `undefined`（= 不过滤）
 */
export function resolveDeviceFilter(
  formDeviceId?: string,
  presetDeviceId?: string,
): string | undefined {
  const form = (formDeviceId ?? '').trim();
  if (form !== '') {
    return form;
  }
  const preset = (presetDeviceId ?? '').trim();
  return preset === '' ? undefined : preset;
}

/**
 * 把同一数据源的并发请求**串行化**：任意时刻至多一个在途请求，且按**发出顺序**执行。
 *
 * 🔴 修前实测到的真实竞态（`list-refresh.test.ts` 判红的那条）：页面顶部的**告警计数摘要**
 * `reloadSummary()` 是普通 async 函数，**不经过 vxe**，因此没有 vxe 那层在途守卫
 * （vxe `commitProxy` 在 `tableLoading` 期间再来 query 会直接 `return`，详见 `index.vue` 注释）。
 * 于是「进页面时的摘要请求（慢）」与「确认/静默后的摘要请求（快）」可以同时在途，
 * 最终展示的值取决于**谁最后返回**而不是**谁最后发出**：
 * 旧请求后到 ⇒ 用户刚确认完，顶部计数却回退成确认前的数字（`activeCount` 偏高、`ackedCount` 偏低）。
 *
 * 两张表格（实例/规则）**不需要**它：vxe 已经保证同一时刻至多一个在途 query，
 * 那里的 `listError` 不会被乱序响应污染。所以本函数只用在摘要上——
 * 不给不存在的竞态写守卫，也不留只为「看起来更稳」的空壳代码。
 *
 * 注意：**排队，不丢弃**（丢弃会让用户点了刷新却什么都不发生）。
 *
 * @returns `run(task)`：把 `task` 排到队尾，返回该 task 自身的结果 promise。
 */
export function createSerialRunner(): <T>(
  task: () => Promise<T>,
) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(task: () => Promise<T>): Promise<T> {
    // 无论上一个成功还是失败，下一个都要跑（失败语义由各自调用方负责）
    const started = tail.then(task, task);
    // 队列尾部只关心「上一个结束了」，不把异常往后传（否则会变成未处理拒绝）
    tail = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  };
}

/**
 * 后端 message 是否在说「缺少租户上下文」。
 *
 * 为什么需要它：平台管理员若在没有选定租户的身份下做**写操作**，后端会（在修复后）返回一句人话
 * 业务错误而不是裸 500；页面除了原样展示这句话，还应给一条**能照着做**的引导。
 * 判定刻意只认后端消息里的稳定短语（不猜前端状态），避免把普通错误误诊成租户问题。
 *
 * @param message 后端返回的 message（或前端兜底文案）
 * @returns 疑似租户上下文问题
 */
export function isTenantContextError(message: string): boolean {
  if (!message) {
    return false;
  }
  return (
    message.includes('租户上下文') ||
    message.includes('tenant context') ||
    message.includes('没有租户')
  );
}
