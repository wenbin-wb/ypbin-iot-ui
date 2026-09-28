import { describe, expect, it } from 'vitest';

import {
  createSerialRunner,
  isTenantContextError,
  listSlotState,
  resolveDeviceFilter,
} from './list-state';

/**
 * 告警列表页两条纪律的用例（独立复核 2026-10-03 要求：覆盖缺口必须补**本机可跑**的用例）。
 *
 * 这两条判据此前写在模板里，无法被用例咬住——复核实测「删掉模板里的 `v-if="!listError"` 后
 * 54 个可运行用例无一转红」。抽成纯函数后，同样的回归会直接让下面的断言转红。
 */
describe('listSlotState（失败绝不画成空态）', () => {
  it('★ 失败 + 0 行 ⇒ error（**不得**判成 empty）', () => {
    expect(listSlotState('后端 message', 0)).toBe('error');
  });

  it('失败 + 已有行 ⇒ 仍是 error（「已有数据后刷新失败」也不许悄悄变成空态/继续展示过期数据）', () => {
    expect(listSlotState('后端 message', 5)).toBe('error');
  });

  it('无失败 + 0 行 ⇒ empty（这时才允许展示空态引导）', () => {
    expect(listSlotState('', 0)).toBe('empty');
  });

  it('无失败 + 有行 ⇒ content', () => {
    expect(listSlotState('', 3)).toBe('content');
  });
});

describe('resolveDeviceFilter（表单选择优先于 URL 带来的设备）', () => {
  it('表单选了设备 ⇒ 用表单值（压过 URL）', () => {
    expect(resolveDeviceFilter('1001', '1002')).toBe('1001');
  });

  it('表单没选 ⇒ 用 URL 带来的设备', () => {
    expect(resolveDeviceFilter('', '1002')).toBe('1002');
  });

  it('两者都没选/都是空白 ⇒ undefined（不过滤，而不是空串）', () => {
    expect(resolveDeviceFilter('', '')).toBeUndefined();
    expect(resolveDeviceFilter('   ', '   ')).toBeUndefined();
    expect(resolveDeviceFilter(undefined, undefined)).toBeUndefined();
  });
});

describe('isTenantContextError（把「缺租户」翻译成可照做的引导）', () => {
  it('★ 后端说「没有租户上下文」⇒ 判为租户问题（页面据此给「请先选择租户」引导）', () => {
    expect(
      isTenantContextError(
        '当前登录身份没有租户上下文，无法保存：请先在右上角选择/切换到你管理的租户',
      ),
    ).toBe(true);
    expect(isTenantContextError('missing tenant context')).toBe(true);
  });

  it('普通业务错误/空文案 ⇒ 不误诊为租户问题', () => {
    expect(isTenantContextError('阈值必须是数字（当前填的是「八十」）')).toBe(
      false,
    );
    expect(isTenantContextError('')).toBe(false);
  });
});

describe('createSerialRunner（同一数据源至多一个在途请求）', () => {
  it('★ 后发的任务必须等前一个结束后才开始（不并发）', async () => {
    const run = createSerialRunner();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = run(async () => {
      order.push('first:start');
      await firstBlocked;
      order.push('first:end');
      return 1;
    });
    const second = run(async () => {
      order.push('second:start');
      return 2;
    });

    // 前一个还没结束 ⇒ 第二个**连开始都不许开始**
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first:start']);

    releaseFirst();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('前一个失败 ⇒ 后一个照常执行（异常不吞掉队列，也不变成未处理拒绝）', async () => {
    const run = createSerialRunner();
    const first = run(async () => {
      throw new Error('旧请求失败');
    });
    const second = run(async () => 'ok');

    await expect(first).rejects.toThrow('旧请求失败');
    await expect(second).resolves.toBe('ok');
  });

  it('三个排队任务的返回顺序与发出顺序一致（后发者一定最后落地）', async () => {
    const run = createSerialRunner();
    const settled: number[] = [];
    const tasks = [1, 2, 3].map((n) =>
      run(async () => {
        settled.push(n);
        return n;
      }),
    );
    expect(await Promise.all(tasks)).toEqual([1, 2, 3]);
    expect(settled).toEqual([1, 2, 3]);
  });
});
