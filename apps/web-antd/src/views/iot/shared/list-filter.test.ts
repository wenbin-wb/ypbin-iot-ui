import type { FilterShape } from './list-filter';

import { describe, expect, it } from 'vitest';

import {
  ALERT_INSTANCE_FILTER_DEFAULTS,
  ALERT_INSTANCE_FILTER_PAGE,
  ALERT_INSTANCE_FILTER_VERSION,
  filterStorageKey,
  loadFilter,
  pickFilterFields,
  sanitizeFilter,
  saveFilterIfChanged,
} from './list-filter';

/**
 * 筛选持久化纯逻辑用例（看板 #12）。
 *
 * 重点：回填不信任存储（脏 JSON / 类型错 / 未知字段一律回退默认）；
 * 保存幂等；分页字段不持久化；版本化 key 支持结构演进。
 */

describe('filterStorageKey（版本化）', () => {
  it('含页面名与版本', () => {
    expect(filterStorageKey('alert-instances', 1)).toBe(
      'ypbin-iot.filter.alert-instances.v1',
    );
  });

  it('bump 版本 ⇒ key 变化（旧值整体失效）', () => {
    expect(filterStorageKey('alert-instances', 2)).not.toBe(
      filterStorageKey('alert-instances', 1),
    );
  });
});

describe('sanitizeFilter（不信任存储）', () => {
  it('合法对象通过；缺字段补默认；未知字段忽略', () => {
    const defaults = { state: '', severity: '', activeOnly: false };
    const shape1: FilterShape = {
      state: 'string',
      severity: 'string',
      activeOnly: 'boolean',
    };
    expect(
      sanitizeFilter({ state: 'FIRING', hacker: 'x' }, shape1, defaults),
    ).toEqual({
      state: 'FIRING',
      severity: '',
      activeOnly: false,
    });
  });

  it('类型不符回退默认（存了 number 的 state 不能炸也不能接受）', () => {
    const defaults = { state: '', severity: '' };
    const shape2: FilterShape = { state: 'string', severity: 'string' };
    expect(
      sanitizeFilter({ state: 123, severity: 'WARNING' }, shape2, defaults),
    ).toEqual({
      state: '',
      severity: 'WARNING',
    });
  });

  it('布尔字段只接受 boolean', () => {
    const defaults = { activeOnly: false };
    const shape3: FilterShape = { activeOnly: 'boolean' };
    expect(sanitizeFilter({ activeOnly: 'true' }, shape3, defaults)).toEqual({
      activeOnly: false,
    });
    expect(sanitizeFilter({ activeOnly: true }, shape3, defaults)).toEqual({
      activeOnly: true,
    });
  });

  it('非对象（数组/字符串/null）⇒ 全默认', () => {
    const defaults = { state: '' };
    const shapeQ: FilterShape = { state: 'string' };
    expect(sanitizeFilter([1], shapeQ, defaults)).toEqual({ state: '' });
    expect(sanitizeFilter('x', shapeQ, defaults)).toEqual({ state: '' });
    expect(sanitizeFilter(null, shapeQ, defaults)).toEqual({ state: '' });
  });
});

describe('loadFilter（读失败 ⇒ 默认，不抛）', () => {
  it('无存储 ⇒ 默认', () => {
    localStorage.clear();
    expect(loadFilter('p', 1, { s: 'string' }, { s: '' })).toEqual({ s: '' });
  });

  it('脏 JSON（非法）⇒ 默认不炸', () => {
    window.localStorage.setItem('ypbin-iot.filter.p.v1', '{ oops');
    expect(loadFilter('p', 1, { s: 'string' }, { s: '' })).toEqual({ s: '' });
  });

  it('合法 JSON 但字段缺 ⇒ 补默认', () => {
    window.localStorage.setItem(
      'ypbin-iot.filter.p.v1',
      JSON.stringify({ s: 'FIRING' }),
    );
    expect(
      loadFilter('p', 1, { s: 'string', b: 'boolean' }, { s: '', b: false }),
    ).toEqual({
      s: 'FIRING',
      b: false,
    });
  });
});

describe('saveFilterIfChanged（幂等）', () => {
  it('变化与否返回差异正确', () => {
    const value = { state: 'FIRING', severity: '' };
    localStorage.clear();
    expect(saveFilterIfChanged('p', 1, value)).toBe(true);
    expect(saveFilterIfChanged('p', 1, { state: 'FIRING', severity: '' })).toBe(
      false,
    );
    expect(saveFilterIfChanged('p', 1, { state: 'ACKED', severity: '' })).toBe(
      true,
    );
  });

  it('传入 previous 时用它比较', () => {
    const value = { state: 'FIRING' };
    expect(saveFilterIfChanged('p', 1, value, value)).toBe(false);
  });
});

describe('pickFilterFields（分页不入存储）', () => {
  it('剔除 page/pageSize 与空值', () => {
    expect(
      pickFilterFields({
        page: 2,
        pageSize: 20,
        state: 'FIRING',
        deviceId: '',
        activeOnly: true,
      }),
    ).toEqual({ state: 'FIRING', activeOnly: true });
  });
});

describe('告警实例筛选常量自洽（冒烟）', () => {
  it('默认值与 shape 类型一致', () => {
    expect(ALERT_INSTANCE_FILTER_DEFAULTS.state).toBe('');
    expect(ALERT_INSTANCE_FILTER_DEFAULTS.severity).toBe('');
    expect(ALERT_INSTANCE_FILTER_DEFAULTS.deviceId).toBe('');
    expect(ALERT_INSTANCE_FILTER_VERSION).toBe(1);
    expect(ALERT_INSTANCE_FILTER_PAGE).toContain('alert');
  });
});
