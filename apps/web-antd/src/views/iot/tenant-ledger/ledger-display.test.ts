import { describe, expect, it } from 'vitest';

import {
  assignableColor,
  assignableLabelKey,
  buildTenantNameMap,
  filterLedgerRows,
} from './ledger-display';

/** 租户台账纯逻辑用例（名称解析映射 + 前端过滤 + assignable 三态）。 */

describe('buildTenantNameMap（不伪造名称）', () => {
  it('id → name；空白/缺失条目跳过', () => {
    const map = buildTenantNameMap([
      { code: 't1', id: '1001', name: '译云科技' },
      { code: 't2', id: '1002', name: '   ' },
      { code: 't3', id: '', name: '无 id 的脏数据' },
    ]);
    expect(map).toEqual({ '1001': '译云科技' });
  });

  it('null/undefined ⇒ 空映射（接口未返回时名称列回落由调用方负责）', () => {
    expect(buildTenantNameMap()).toEqual({});
    expect(buildTenantNameMap(null)).toEqual({});
  });

  it('long 字符串 id 不做 Number 转换（防精度丢失）', () => {
    const bigId = '1900000000000000123';
    expect(buildTenantNameMap([{ code: 't', id: bigId, name: 'A' }])).toEqual({
      [bigId]: 'A',
    });
  });
});

describe('filterLedgerRows（租户名 / tenantId，前端过滤）', () => {
  const rows = [{ tenantId: '1001' }, { tenantId: '2002' }];
  const names = { '1001': '译云科技', '2002': 'Acme' };

  it('空关键字（含纯空白/undefined）⇒ 原数组不动', () => {
    expect(filterLedgerRows(rows, '', names)).toBe(rows);
    expect(filterLedgerRows(rows, '   ', names)).toBe(rows);
    expect(filterLedgerRows(rows, undefined, names)).toBe(rows);
  });

  it('按租户名过滤（不区分大小写）', () => {
    expect(filterLedgerRows(rows, '译云', names)).toEqual([
      { tenantId: '1001' },
    ]);
    expect(filterLedgerRows(rows, 'acme', names)).toEqual([
      { tenantId: '2002' },
    ]);
  });

  it('按 tenantId 过滤（名称未解析出来时也可用）', () => {
    expect(filterLedgerRows(rows, '2002', {})).toEqual([{ tenantId: '2002' }]);
    expect(filterLedgerRows(rows, '2002', names)).toEqual([
      { tenantId: '2002' },
    ]);
  });

  it('无命中 ⇒ 空数组（由调用方渲染真空态）', () => {
    expect(filterLedgerRows(rows, '不存在', names)).toEqual([]);
  });
});

describe('assignable 三态展示（缺失不猜成「不可接入」）', () => {
  it('true/false 映射既有文案键与颜色', () => {
    expect(assignableLabelKey(true)).toBe('page.iot.ledger.assignableOn');
    expect(assignableLabelKey(false)).toBe('page.iot.ledger.assignableOff');
    expect(assignableColor(true)).toBe('success');
    expect(assignableColor(false)).toBe('default');
  });

  it('undefined/null ⇒ 未知键 + warning（不冒充 false）', () => {
    for (const value of [undefined, null]) {
      expect(assignableLabelKey(value)).toBe('page.iot.display.unknown');
      expect(assignableColor(value)).toBe('warning');
    }
  });
});
