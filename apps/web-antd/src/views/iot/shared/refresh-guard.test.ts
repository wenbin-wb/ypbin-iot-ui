import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRefreshGuard,
  QUERY_TIMEOUT_MS,
  QueryTimeoutError,
  TRAILING_IDLE_MAX_RETRIES,
  TRAILING_IDLE_RETRY_MS,
  withQueryTimeout,
} from './refresh-guard';

/**
 * vxe「静默丢弃」守卫（query 客户端超时 + trailing 重发 + 可见加载态）的纯逻辑用例。
 *
 * 背景：vxe `commitProxy` 在途时对再来的 query 直接 return（`ajax.query` 不会被调用），
 * 用户点刷新「什么都没发生」。本守卫在页面自有信号（意图标记 + ajax.query 周期结束）上
 * 实现：被丢弃的意图在当前周期结束后用最新状态补发一次，补发前拉起可见 loading。
 * 用例用桩 `isBusy`/`issue` 直接驱动状态机，不依赖真实 vxe/DOM。
 */

describe('withQueryTimeout（query 客户端超时）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('在超时时间内返回 ⇒ 原样透传结果', async () => {
    const promise = Promise.resolve('ok');
    const pending = withQueryTimeout(promise, 5000);
    // 先挂 handler 再推时钟（handler 必须早于任何 rejection 附着，见下一条注释）
    const settled = pending.then(
      (value) => {
        expect(value).toBe('ok');
      },
      (error: unknown) => {
        throw error;
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
  });

  it('★ 超过 QUERY_TIMEOUT_MS 未返回 ⇒ 抛 QueryTimeoutError（页面据此展示「查询超时」）', async () => {
    const never = new Promise<never>(() => {});
    const pending = withQueryTimeout(never);
    // 先挂 handler 再推时钟：否则 reject 发生在 fake-timer 回合内、handler 还没挂上，
    // 会被 Node 记为未处理拒绝（用例仍过，但 vitest 记 unhandled error）
    const settled = pending.then(
      () => {
        throw new Error('查询不应成功返回');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(QueryTimeoutError);
      },
    );
    await vi.advanceTimersByTimeAsync(QUERY_TIMEOUT_MS + 1);
    await settled;
  });

  it('底层失败早于超时 ⇒ 透传原始错误（不误判成超时）', async () => {
    let rejectFn!: (reason: unknown) => void;
    const failing = new Promise<never>((_resolve, reject) => {
      rejectFn = reject;
    });
    const pending = withQueryTimeout(failing, 5000);
    // 先挂 handler 再拒绝（否则拒绝先于 handler 附着，被记为未处理）
    const settled = pending.then(
      () => {
        throw new Error('查询不应成功返回');
      },
      (error: unknown) => {
        expect((error as Error).message).toBe('后端 say no');
      },
    );
    rejectFn(new Error('后端 say no'));
    await vi.advanceTimersByTimeAsync(100);
    await settled;
  });
});

describe('createRefreshGuard（trailing 重发 + 可见加载态）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeGuard(busyInitially = false) {
    const issued: string[] = [];
    let busy = busyInitially;
    const trailing: boolean[] = [];
    const guard = createRefreshGuard({
      isBusy: () => busy,
      issue: () => {
        issued.push('issue');
      },
      onTrailing: (active) => {
        trailing.push(active);
      },
    });
    return { guard, issued, setBusy: (v: boolean) => (busy = v), trailing };
  }

  it('空闲时 request() ⇒ 立即发（无丢弃可守，不发多余请求）', () => {
    const { guard, issued } = makeGuard(false);
    guard.request();
    expect(issued).toEqual(['issue']);
  });

  it('★ 在途时 request() ⇒ 不发，周期结束后用最新状态补发一次（不丢点击）', async () => {
    const { guard, issued, setBusy, trailing } = makeGuard(true);
    guard.request();
    // 在途 ⇒ 没有立即发起
    expect(issued).toEqual([]);
    // 补发前拉起可见 loading（用户能看到动作被接住）
    guard.notifyCycleEnd();
    expect(trailing).toEqual([true]);

    // vxe 真正把 tableLoading 置回 false 需要一两个宏任务
    setBusy(false);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(TRAILING_IDLE_RETRY_MS + 1);
    expect(issued).toEqual(['issue']);
    // 补发开始时把外部 loading 交给 vxe 自己的 loading
    expect(trailing[trailing.length - 1]).toBe(false);
  });

  it('★ 在途期间多次刷新意图 ⇒ 只补发一次（合并为最新状态）', async () => {
    const { guard, issued, setBusy } = makeGuard(true);
    guard.request();
    guard.markIntent(); // 例如工具栏刷新事件又来了
    guard.request();
    expect(issued).toEqual([]);

    guard.notifyCycleEnd();
    setBusy(false);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(TRAILING_IDLE_RETRY_MS + 1);
    expect(issued).toEqual(['issue']);
  });

  it('★ 查询真正启动（consumeIntent）⇒ 周期结束不再补发（没有静默重复请求）', async () => {
    const { guard, issued, setBusy } = makeGuard(false);
    guard.request(); // 立即发 → ajax.query 被调用 → consumeIntent
    guard.consumeIntent();
    setBusy(true); // 该周期里又来了别的意图但被丢弃
    guard.markIntent();
    guard.notifyCycleEnd(); // 周期结束
    setBusy(false);
    await vi.advanceTimersByTimeAsync(0);
    // 上一次 request 已被消费、这次 markIntent 是要补发的
    expect(issued).toEqual(['issue', 'issue']);
  });

  it('周期结束后仍在途（vxe 尚未复位）⇒ 轮询等待，最多 TRAILING_IDLE_MAX_RETRIES 次后放弃', async () => {
    const { guard, issued, trailing } = makeGuard(true);
    guard.request();
    guard.notifyCycleEnd();
    // vxe 一直没复位 ⇒ 多次轮询后放弃本轮（不无限空转）
    for (let i = 0; i < TRAILING_IDLE_MAX_RETRIES + 2; i += 1) {
      await vi.advanceTimersByTimeAsync(TRAILING_IDLE_RETRY_MS + 1);
    }
    expect(issued).toEqual([]);
    expect(trailing[trailing.length - 1]).toBe(false);
  });

  it('dispose 后不再补发（页面卸载不留定时器）', async () => {
    const { guard, issued, setBusy } = makeGuard(true);
    guard.request();
    guard.notifyCycleEnd();
    guard.dispose();
    setBusy(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(issued).toEqual([]);
  });

  it('失败周期（超时/报错）不属于「丢弃」：意图已被 consume ⇒ 不自动重试（错误展示职责在调用方）', async () => {
    const { guard, issued, setBusy } = makeGuard(false);
    guard.request();
    guard.consumeIntent(); // ajax.query 启动了（虽然最终失败）
    guard.notifyCycleEnd(); // 失败也结束周期
    setBusy(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(issued).toEqual(['issue']); // 只有原来那一次，没有静默重试
  });
});
