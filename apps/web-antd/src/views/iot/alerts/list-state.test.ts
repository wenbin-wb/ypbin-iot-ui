import { describe, expect, it } from 'vitest';

import { listSlotState, resolveDeviceFilter } from './list-state';

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
