import { describe, expect, it } from 'vitest';

import {
  resolveBatchDisabledReason,
  resolveBatchOutcome,
  resolvePageAfterDelete,
  resolvePageAfterEmptyQuery,
} from './list-actions';

/**
 * 设备台账「动作口径」纯逻辑用例。
 *
 * 覆盖三件会直接导致**错误结论**的事：
 * 1. 批量按钮为什么禁用（灰按钮无解释 = 用户不知道点不了的原因）；
 * 2. 批量写操作按「后端实际生效台数」还是「勾选数」播报（错报会让用户以为处理完了）；
 * 3. 删空当前页后查哪一页（错页会把「本页空了」说成「整个租户没有设备」）。
 */

describe('resolveBatchDisabledReason', () => {
  it('未勾选 ⇒ noSelection；勾选后可用（空串）', () => {
    expect(resolveBatchDisabledReason(0, false)).toBe('noSelection');
    expect(resolveBatchDisabledReason(3, false)).toBe('');
  });

  it('请求在途优先报 pending（用户刚点过按钮，最需要知道「已在提交」）', () => {
    expect(resolveBatchDisabledReason(3, true)).toBe('pending');
    // 即使在途时勾选被清空，也仍是 pending（两个原因同时成立时报更紧急的那个）
    expect(resolveBatchDisabledReason(0, true)).toBe('pending');
  });
});

describe('resolveBatchOutcome（按后端实际生效台数播报）', () => {
  it('全部生效 ⇒ full，台数用后端返回值', () => {
    expect(resolveBatchOutcome(3, 3)).toMatchObject({
      affected: 3,
      level: 'full',
      notEffective: 0,
      verified: true,
    });
  });

  it('🔴 部分生效 ⇒ partial，并给出未生效台数（不得报勾选数）', () => {
    expect(resolveBatchOutcome(3, 2)).toMatchObject({
      affected: 2,
      level: 'partial',
      notEffective: 1,
      verified: true,
    });
    // 后端 Long 可能以字符串返回
    expect(resolveBatchOutcome(3, '1')).toMatchObject({
      affected: 1,
      level: 'partial',
      notEffective: 2,
    });
  });

  it('🔴 0 台生效 ⇒ none（勾中的设备已被他人删除，或已处于目标状态未命中 UPDATE）', () => {
    expect(resolveBatchOutcome(2, 0)).toMatchObject({
      affected: 0,
      level: 'none',
      notEffective: 2,
    });
  });

  it('后端未返回计数（老后端/空值）⇒ 按勾选数播报但标记 verified=false', () => {
    for (const raw of [undefined, null, '', Number.NaN]) {
      expect(resolveBatchOutcome(2, raw as never)).toMatchObject({
        affected: 2,
        level: 'full',
        verified: false,
      });
    }
  });

  it('负数/小数等脏值按 0/截断处理，不产生负台数', () => {
    expect(resolveBatchOutcome(2, -1)).toMatchObject({
      affected: 0,
      level: 'none',
    });
    expect(resolveBatchOutcome(2, 1.9)).toMatchObject({
      affected: 1,
      level: 'partial',
    });
  });
});

describe('resolvePageAfterDelete（删空本页回退上一页）', () => {
  it('删除后本页仍有行 ⇒ 留在当前页', () => {
    expect(
      resolvePageAfterDelete({
        currentPage: 2,
        pageSize: 10,
        totalBefore: 21,
        visibleCount: 10,
        deletedCount: 1,
      }),
    ).toBe(2);
  });

  it('🔴 第 2 页删空最后一条 ⇒ 回退到第 1 页', () => {
    expect(
      resolvePageAfterDelete({
        currentPage: 2,
        pageSize: 10,
        totalBefore: 11,
        visibleCount: 1,
        deletedCount: 1,
      }),
    ).toBe(1);
  });

  it('第 1 页删空 ⇒ 仍是第 1 页（此时「没有设备」才是真的）', () => {
    expect(
      resolvePageAfterDelete({
        currentPage: 1,
        pageSize: 10,
        totalBefore: 1,
        visibleCount: 1,
        deletedCount: 1,
      }),
    ).toBe(1);
  });

  it('部分未生效（实际删除数 < 本页行数）⇒ 不回退：本页还有数据', () => {
    expect(
      resolvePageAfterDelete({
        currentPage: 3,
        pageSize: 10,
        totalBefore: 25,
        visibleCount: 5,
        deletedCount: 2,
      }),
    ).toBe(3);
  });

  it('一次删掉超过一页时不得越过「还有数据的最后一页」', () => {
    // 第 3 页（共 3 页）一次清空 ⇒ 剩余 20 条 = 2 页 ⇒ 最多回到第 2 页
    expect(
      resolvePageAfterDelete({
        currentPage: 3,
        pageSize: 10,
        totalBefore: 30,
        visibleCount: 10,
        deletedCount: 10,
      }),
    ).toBe(2);
  });

  it('页码/页大小脏值不产生 0 或负数', () => {
    expect(
      resolvePageAfterDelete({
        currentPage: 0,
        pageSize: 0,
        totalBefore: 0,
        visibleCount: 0,
        deletedCount: 1,
      }),
    ).toBe(1);
  });
});

describe('resolvePageAfterEmptyQuery（查到空页的兜底修正）', () => {
  it('总数 > 0 且本页为空 ⇒ 给出「还有数据的最后一页」（调用方与当前页不同才改查）', () => {
    // 11 条、每页 10 ⇒ 最后一页是第 2 页
    expect(resolvePageAfterEmptyQuery(10, 11)).toBe(2);
    // 25 条、每页 10 ⇒ 最后一页是第 3 页
    expect(resolvePageAfterEmptyQuery(10, 25)).toBe(3);
    // 恰好整除 ⇒ 最后一页就是 ceil 结果
    expect(resolvePageAfterEmptyQuery(10, 30)).toBe(3);
  });

  it('总数为 0 ⇒ 不修正（此时「没有设备」是真的，不能凭空跳页）', () => {
    expect(resolvePageAfterEmptyQuery(10, 0)).toBe(0);
  });

  it('页大小脏值不产生 0/负页码或除零', () => {
    expect(resolvePageAfterEmptyQuery(0, 5)).toBe(5);
    expect(resolvePageAfterEmptyQuery(-1, 2)).toBe(2);
  });
});
