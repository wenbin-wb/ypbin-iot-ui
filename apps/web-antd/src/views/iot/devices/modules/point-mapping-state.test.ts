import { describe, expect, it } from 'vitest';

import {
  buildPointPayload,
  emptyPointForm,
  formFromPoint,
  POINT_RAW_ADDRESS_MAX,
  resolvePointListState,
  validatePointForm,
} from './point-mapping-state';

/**
 * 点位映射表单纯逻辑用例（看板 #13）。
 *
 * 重点：校验与后端 IotPointMappingReq 约束同口径（propertyId NotNull /
 * refType|addressType|rawAddress|rw NotBlank / rawAddress <=128 / pollIntervalMs >=0 整数 /
 * scaleFactor|offsetValue 数字 / byteOrder big|little）；回显与提交保真。
 */

function validForm() {
  const form = emptyPointForm();
  form.propertyId = '1001';
  form.rawAddress = '40001';
  return form;
}

describe('validatePointForm（与后端同口径）', () => {
  it('合法表单通过', () => {
    expect(validatePointForm(validForm())).toMatchObject({ ok: true });
  });

  it('必填项逐项拒绝：propertyId / refType / addressType / rw / rawAddress', () => {
    const base = validForm();
    expect(validatePointForm({ ...base, propertyId: '' }).ok).toBe(false);
    expect(validatePointForm({ ...base, refType: '' }).ok).toBe(false);
    expect(validatePointForm({ ...base, addressType: '' }).ok).toBe(false);
    expect(validatePointForm({ ...base, rw: '' }).ok).toBe(false);
    expect(validatePointForm({ ...base, rawAddress: '  ' }).ok).toBe(false);
  });

  it('rawAddress 长度 <=128（后端 @Size(max=128)）', () => {
    expect(
      validatePointForm({
        ...validForm(),
        rawAddress: 'x'.repeat(POINT_RAW_ADDRESS_MAX),
      }).ok,
    ).toBe(true);
    expect(
      validatePointForm({
        ...validForm(),
        rawAddress: 'x'.repeat(POINT_RAW_ADDRESS_MAX + 1),
      }).ok,
    ).toBe(false);
  });

  it('pollIntervalMs 必须是非负整数', () => {
    expect(validatePointForm({ ...validForm(), pollIntervalMs: '0' }).ok).toBe(
      true,
    );
    expect(
      validatePointForm({ ...validForm(), pollIntervalMs: '1000' }).ok,
    ).toBe(true);
    expect(validatePointForm({ ...validForm(), pollIntervalMs: '-1' }).ok).toBe(
      false,
    );
    expect(
      validatePointForm({ ...validForm(), pollIntervalMs: '1.5' }).ok,
    ).toBe(false);
    expect(
      validatePointForm({ ...validForm(), pollIntervalMs: 'abc' }).ok,
    ).toBe(false);
  });

  it('scaleFactor/offsetValue 可空，非空必须数字', () => {
    expect(validatePointForm({ ...validForm(), scaleFactor: '' }).ok).toBe(
      true,
    );
    expect(validatePointForm({ ...validForm(), scaleFactor: '0.01' }).ok).toBe(
      true,
    );
    expect(validatePointForm({ ...validForm(), scaleFactor: 'abc' }).ok).toBe(
      false,
    );
    expect(validatePointForm({ ...validForm(), offsetValue: '-0.5' }).ok).toBe(
      true,
    );
    expect(validatePointForm({ ...validForm(), offsetValue: '--' }).ok).toBe(
      false,
    );
  });

  it('byteOrder 只允许 big|little', () => {
    expect(validatePointForm({ ...validForm(), byteOrder: 'big' }).ok).toBe(
      true,
    );
    expect(validatePointForm({ ...validForm(), byteOrder: 'little' }).ok).toBe(
      true,
    );
    expect(validatePointForm({ ...validForm(), byteOrder: '' }).ok).toBe(true);
    expect(validatePointForm({ ...validForm(), byteOrder: 'abcd' }).ok).toBe(
      false,
    );
  });
});

describe('buildPointPayload', () => {
  it('trim + enabled 缺省 true', () => {
    const form = validForm();
    form.rawAddress = '  40001  ';
    form.pollIntervalMs = '1000';
    const payload = buildPointPayload('9', form);
    expect(payload).toMatchObject({
      deviceId: '9',
      propertyId: '1001',
      rawAddress: '40001',
      pollIntervalMs: 1000,
      enabled: true,
    });
  });

  it('空数字字段不发送（避免把空串/undefined 序列化上去）', () => {
    const payload = buildPointPayload('9', validForm());
    expect(payload).not.toHaveProperty('scaleFactor');
    expect(payload).not.toHaveProperty('pollIntervalMs');
    expect(payload).not.toHaveProperty('byteOrder');
  });

  it('scaleFactor/offsetValue 字符串原样保真（BigDecimal 语义）', () => {
    const form = validForm();
    form.scaleFactor = '0.01';
    form.offsetValue = '-1.5';
    expect(buildPointPayload('9', form)).toMatchObject({
      scaleFactor: '0.01',
      offsetValue: '-1.5',
    });
  });
});

describe('formFromPoint（编辑回显）', () => {
  it('resp 完整回显（enabled 缺省视为开）', () => {
    const form = formFromPoint({
      id: '1',
      deviceId: '9',
      propertyId: '1001',
      refType: 'property',
      rawAddress: '40001',
      addressType: 'holding',
      pollIntervalMs: 1000,
      scaleFactor: '0.01',
      byteOrder: 'big',
      rw: 'RW',
      enabled: true,
    });
    expect(form).toMatchObject({
      propertyId: '1001',
      pollIntervalMs: '1000',
      scaleFactor: '0.01',
      byteOrder: 'big',
      rw: 'RW',
      enabled: true,
    });
  });

  it('可空字段空串化（编辑时不显示 undefined）', () => {
    const form = formFromPoint({
      id: '1',
      deviceId: '9',
      propertyId: '1001',
      refType: 'property',
      rawAddress: '40001',
      addressType: 'holding',
      rw: 'R',
    });
    expect(form.pollIntervalMs).toBe('');
    expect(form.scaleFactor).toBe('');
    expect(form.offsetValue).toBe('');
    expect(form.byteOrder).toBe('');
    expect(form.enabled).toBe(true);
  });
});

describe('resolvePointListState（错误优先于空）', () => {
  it('加载中优先', () => {
    expect(resolvePointListState(true, '', 0)).toBe('loading');
  });

  it('失败必须 error，不能画成空', () => {
    expect(resolvePointListState(false, '网络错误', 0)).toBe('error');
  });

  it('确实无数据才空', () => {
    expect(resolvePointListState(false, '', 0)).toBe('empty');
  });

  it('有数据 ready', () => {
    expect(resolvePointListState(false, '', 2)).toBe('ready');
  });
});
