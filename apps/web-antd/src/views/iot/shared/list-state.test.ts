import type { ListSlotState, ListState } from './list-state';

import { describe, expect, it } from 'vitest';

import { resolveListSlotState, resolveListState } from './list-state';

/**
 * 三态判据的**唯一**回归网（2026-10-20 审查 P2「6 份逐字重复」收口）。
 *
 * 这里直接断言共享函数的语义；各业务 state 模块（tag/import/trace/point-mapping/
 * 平台告警/OpenAPI Key/告警中心）的薄封装由各自既有用例守住（行为零漂移）。
 *
 * 关键顺序（写死在 `shared/list-state.ts` 注释里）：
 * - `loading` 优先于失败：加载中不展示错误，避免首屏「加载中 → 闪一下失败」；
 * - **失败优先于空**：有错误即使 0 条也是 `error`，绝不画成「没有数据」。
 */
describe('resolveListState（四态：loading > error > empty/ready）', () => {
  it('加载中优先：即使同时有错误、0 条，也返回 loading（不闪假失败）', () => {
    expect(
      resolveListState({ errorMessage: 'boom', itemCount: 0, loading: true }),
    ).toBe('loading');
  });

  it('失败优先于空：有错误且 0 条 ⇒ error（不是 empty）', () => {
    expect(resolveListState({ errorMessage: '网络错误', itemCount: 0 })).toBe(
      'error',
    );
  });

  it('失败优先于有数据：有错误且 >0 条仍返回 error（旧数据不能冒充成功）', () => {
    expect(resolveListState({ errorMessage: '网络错误', itemCount: 7 })).toBe(
      'error',
    );
  });

  it('无错误 + 0 条 ⇒ empty', () => {
    expect(resolveListState({ errorMessage: '', itemCount: 0 })).toBe('empty');
  });

  it('无错误 + >0 条 ⇒ ready', () => {
    expect(resolveListState({ errorMessage: '', itemCount: 3 })).toBe('ready');
  });

  it('errorMessage 为 null/undefined 等同无错误；loading 默认 false', () => {
    expect(
      resolveListState({
        errorMessage: null,
        itemCount: 0,
      }),
    ).toBe('empty');
    expect(
      resolveListState({
        errorMessage: undefined,
        itemCount: 0,
      }),
    ).toBe('empty');
    expect(resolveListState({ itemCount: 1 })).toBe('ready');
  });

  it('itemCount 为 0 或负数都按空处理（不把负数当成有数据）', () => {
    const empty: ListState = resolveListState({ itemCount: 0 });
    const negative: ListState = resolveListState({ itemCount: -1 });
    expect(empty).toBe('empty');
    expect(negative).toBe('empty');
  });
});

describe('resolveListSlotState（三态：error > content/empty）', () => {
  it('有错误 + 0 行 ⇒ error（失败绝不画成空态）', () => {
    expect(resolveListSlotState('后端 message', 0)).toBe('error');
  });

  it('有错误 + 有行 ⇒ error（不让旧行掩盖失败）', () => {
    expect(resolveListSlotState('后端 message', 5)).toBe('error');
  });

  it('无错误 + 0 行 ⇒ empty', () => {
    expect(resolveListSlotState('', 0)).toBe('empty');
  });

  it('无错误 + 有行 ⇒ content', () => {
    expect(resolveListSlotState('', 3)).toBe('content');
  });

  it('errorMessage 为 null/undefined 等同无错误；rowCount 默认 0', () => {
    const slot: ListSlotState = resolveListSlotState(null);
    expect(slot).toBe('empty');
    expect(resolveListSlotState(undefined, 2)).toBe('content');
  });
});
