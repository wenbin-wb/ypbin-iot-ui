import { describe, expect, it } from 'vitest';

import {
  buildPointPayload,
  emptyPointForm,
  formFromPoint,
  isModbusRegisterAddressType,
  POINT_RAW_ADDRESS_MAX,
  registerDecodeLabelKeys,
  resolvePointListState,
  validatePointForm,
} from './point-mapping-state';

/**
 * 点位映射表单纯逻辑用例。
 *
 * 重点：校验与后端 IotPointMappingReq 约束同口径（propertyId NotNull /
 * refType|addressType|rawAddress|rw NotBlank / rawAddress <=128 / pollIntervalMs >=0 整数 /
 * scaleFactor|offsetValue 数字 / byteOrder big|little / wordCount 1|2 / signed boolean）；
 * 回显与提交保真；Modbus 寄存器解码 v1 的下发口径。
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

  it('wordCount 只允许 1|2（后端 int，默认 1）', () => {
    expect(validatePointForm({ ...validForm(), wordCount: '1' }).ok).toBe(true);
    expect(validatePointForm({ ...validForm(), wordCount: '2' }).ok).toBe(true);
    expect(validatePointForm({ ...validForm(), wordCount: '' }).ok).toBe(true);
    expect(validatePointForm({ ...validForm(), wordCount: '3' }).ok).toBe(
      false,
    );
    expect(validatePointForm({ ...validForm(), wordCount: 'x' }).ok).toBe(
      false,
    );
  });

  it('signed 是 boolean（后端 Boolean，默认 false = 无符号）', () => {
    expect(validatePointForm({ ...validForm(), signed: false }).ok).toBe(true);
    expect(validatePointForm({ ...validForm(), signed: true }).ok).toBe(true);
    // 老口径（0/1 数字或字符串）必须被拒，避免契约回归成 Integer
    expect(validatePointForm({ ...validForm(), signed: 0 as never }).ok).toBe(
      false,
    );
    expect(validatePointForm({ ...validForm(), signed: '1' as never }).ok).toBe(
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

  it('寄存器点位（Modbus）默认下发后端默认值 wordCount=1 / signed=false', () => {
    const payload = buildPointPayload('9', validForm());
    expect(payload.wordCount).toBe(1);
    expect(payload.signed).toBe(false);
  });

  it('★ wordCount=1（16 位）时 byteOrder 不参与 payload（契约：仅 32 位生效）', () => {
    const form = validForm();
    form.wordCount = '1';
    form.byteOrder = 'little';
    expect(buildPointPayload('9', form)).not.toHaveProperty('byteOrder');
  });

  it('★ wordCount=2（32 位）时 byteOrder 按契约带出，signed 按选择带出', () => {
    const form = validForm();
    form.wordCount = '2';
    form.signed = true;
    form.byteOrder = 'little';
    expect(buildPointPayload('9', form)).toMatchObject({
      wordCount: 2,
      signed: true,
      byteOrder: 'little',
    });
  });

  it('wordCount=2 但未选字序时不下发 byteOrder（后端默认）', () => {
    const form = validForm();
    form.wordCount = '2';
    form.byteOrder = undefined;
    expect(buildPointPayload('9', form)).not.toHaveProperty('byteOrder');
  });

  it('★ 非 Modbus 寄存器点位（coil/discrete/nodeid/topic）不下发三个解码字段', () => {
    for (const addressType of ['coil', 'discrete', 'nodeid', 'topic']) {
      const form = validForm();
      form.addressType = addressType;
      form.wordCount = '2';
      form.signed = true;
      form.byteOrder = 'big';
      const payload = buildPointPayload('9', form);
      expect(payload).not.toHaveProperty('wordCount');
      expect(payload).not.toHaveProperty('signed');
      expect(payload).not.toHaveProperty('byteOrder');
    }
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

  it('后端未返回 wordCount/signed 时回落到后端默认 1 / false（老数据不会被改成别的语义）', () => {
    const form = formFromPoint({
      id: '1',
      deviceId: '9',
      propertyId: '1001',
      refType: 'property',
      rawAddress: '40001',
      addressType: 'holding',
      rw: 'R',
    });
    expect(form.wordCount).toBe('1');
    expect(form.signed).toBe(false);
  });

  it('wordCount=2 / signed=true 完整回显', () => {
    const form = formFromPoint({
      id: '1',
      deviceId: '9',
      propertyId: '1001',
      refType: 'property',
      rawAddress: '40001',
      addressType: 'holding',
      wordCount: 2,
      signed: true,
      byteOrder: 'little',
      rw: 'R',
    });
    expect(form.wordCount).toBe('2');
    expect(form.signed).toBe(true);
    expect(form.byteOrder).toBe('little');
  });
});

describe('寄存器解码（Modbus）：可读展示与适用性', () => {
  it('isModbusRegisterAddressType 只认 holding|input', () => {
    expect(isModbusRegisterAddressType('holding')).toBe(true);
    expect(isModbusRegisterAddressType('input')).toBe(true);
    for (const t of ['coil', 'discrete', 'nodeid', 'topic', '', undefined]) {
      expect(isModbusRegisterAddressType(t)).toBe(false);
    }
  });

  it('★ 32 位 · 有符号 · 低字在前（不裸露 big/little 枚举值）', () => {
    expect(
      registerDecodeLabelKeys({
        addressType: 'holding',
        wordCount: 2,
        signed: true,
        byteOrder: 'little',
      }),
    ).toEqual([
      'page.iot.point.wordCount2',
      'page.iot.point.signedInt',
      'page.iot.point.byteOrderLittle',
    ]);
  });

  it('16 位时不展示字序（即便 resp 里带着历史 byteOrder）', () => {
    expect(
      registerDecodeLabelKeys({
        addressType: 'input',
        wordCount: 1,
        signed: false,
        byteOrder: 'big',
      }),
    ).toEqual(['page.iot.point.wordCount1', 'page.iot.point.unsigned']);
  });

  it('缺字段按后端默认展示（16 位 · 无符号），非寄存器点位返回空（列表显示 -）', () => {
    expect(registerDecodeLabelKeys({ addressType: 'holding' })).toEqual([
      'page.iot.point.wordCount1',
      'page.iot.point.unsigned',
    ]);
    for (const addressType of ['coil', 'discrete', 'nodeid', 'topic']) {
      expect(registerDecodeLabelKeys({ addressType })).toEqual([]);
    }
  });

  it('32 位但字序取值非法时不瞎猜（不追加字序片段）', () => {
    expect(
      registerDecodeLabelKeys({
        addressType: 'holding',
        wordCount: 2,
        signed: false,
        byteOrder: 'middle',
      }),
    ).toEqual(['page.iot.point.wordCount2', 'page.iot.point.unsigned']);
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
