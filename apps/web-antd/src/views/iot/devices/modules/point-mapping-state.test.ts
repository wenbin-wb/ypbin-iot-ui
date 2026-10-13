import { describe, expect, it } from 'vitest';

import {
  applyRegisterFormat,
  buildPointPayload,
  emptyPointForm,
  formFromPoint,
  isModbusRegisterAddressType,
  isPointRegisterFormat,
  normalizeRegisterFormat,
  normalizeStringWordCount,
  POINT_BIT_OFFSET_MAX,
  POINT_DOUBLE_WORD_COUNT,
  POINT_RAW_ADDRESS_MAX,
  POINT_REGISTER_BITS,
  POINT_STRING_WORD_COUNT_MAX,
  POINT_STRING_WORD_COUNT_MIN,
  registerDecodeSegments,
  resolvePointListState,
  validatePointForm,
} from './point-mapping-state';

/**
 * 点位映射表单纯逻辑用例。
 *
 * 重点：校验与后端 IotPointMappingReq 约束同口径（propertyId NotNull /
 * refType|addressType|rawAddress|rw NotBlank / rawAddress <=128 / pollIntervalMs >=0 整数 /
 * scaleFactor|offsetValue 数字 / byteOrder big|little / wordCount 1|2 / signed boolean）；
 * 回显与提交保真；Modbus 寄存器解码 v1/v2/v3 的下发口径（registerFormat 四形态的字段组成、
 * 切换清理、位域校验与 string 的寄存器个数 1..32）。
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

  it('★ int：32 位 · 有符号 · 低字在前（不裸露 big/little 枚举值）', () => {
    expect(
      registerDecodeSegments({
        addressType: 'holding',
        registerFormat: 'int',
        wordCount: 2,
        signed: true,
        byteOrder: 'little',
      }),
    ).toEqual([
      { key: 'page.iot.point.wordCount2' },
      { key: 'page.iot.point.signedInt' },
      { key: 'page.iot.point.byteOrderLittle' },
    ]);
  });

  it('int：16 位时不展示字序（即便 resp 里带着历史 byteOrder）', () => {
    expect(
      registerDecodeSegments({
        addressType: 'input',
        registerFormat: 'int',
        wordCount: 1,
        signed: false,
        byteOrder: 'big',
      }),
    ).toEqual([
      { key: 'page.iot.point.wordCount1' },
      { key: 'page.iot.point.unsigned' },
    ]);
  });

  it('int：缺字段按后端默认展示（16 位 · 无符号）；字序取值非法时不瞎猜', () => {
    expect(registerDecodeSegments({ addressType: 'holding' })).toEqual([
      { key: 'page.iot.point.wordCount1' },
      { key: 'page.iot.point.unsigned' },
    ]);
    expect(
      registerDecodeSegments({
        addressType: 'holding',
        wordCount: 2,
        signed: false,
        byteOrder: 'middle',
      }),
    ).toEqual([
      { key: 'page.iot.point.wordCount2' },
      { key: 'page.iot.point.unsigned' },
    ]);
  });

  it('★ float：`32 位浮点 · 低字在前（CDAB）`，且不出现符号片段', () => {
    expect(
      registerDecodeSegments({
        addressType: 'holding',
        registerFormat: 'float',
        wordCount: 2,
        signed: false,
        byteOrder: 'little',
      }),
    ).toEqual([
      { key: 'page.iot.point.registerFormatFloatShort' },
      { key: 'page.iot.point.byteOrderLittle' },
    ]);
    // 未选字序时只剩形态
    expect(
      registerDecodeSegments({ addressType: 'input', registerFormat: 'float' }),
    ).toEqual([{ key: 'page.iot.point.registerFormatFloatShort' }]);
  });

  it('★ bits：`位域：bit 3..5（3 位）`（offset..offset+length-1）', () => {
    expect(
      registerDecodeSegments({
        addressType: 'holding',
        registerFormat: 'bits',
        wordCount: 1,
        bitOffset: 3,
        bitLength: 3,
      }),
    ).toEqual([{ key: 'page.iot.point.bitsRangeShort', params: [3, 5, 3] }]);
  });

  it('bits：位域信息缺失时退化为「位域」，不编造范围', () => {
    expect(
      registerDecodeSegments({
        addressType: 'holding',
        registerFormat: 'bits',
      }),
    ).toEqual([{ key: 'page.iot.point.registerFormatBitsShort' }]);
  });

  it('非寄存器点位一律返回空（列表显示 -）', () => {
    for (const addressType of ['coil', 'discrete', 'nodeid', 'topic']) {
      for (const registerFormat of ['int', 'float', 'bits']) {
        expect(registerDecodeSegments({ addressType, registerFormat })).toEqual(
          [],
        );
      }
    }
  });
});

describe('registerFormat：默认值与老数据回落', () => {
  it('新建默认 int，位域字段默认不写（保持后端默认）', () => {
    const form = emptyPointForm();
    expect(form.registerFormat).toBe('int');
    expect(form.bitOffset).toBeUndefined();
    expect(form.bitLength).toBeUndefined();
  });

  it('normalizeRegisterFormat：缺省/非法值一律回落 int', () => {
    expect(normalizeRegisterFormat(undefined)).toBe('int');
    expect(normalizeRegisterFormat('')).toBe('int');
    expect(normalizeRegisterFormat('bool')).toBe('int');
    expect(normalizeRegisterFormat('float')).toBe('float');
    expect(normalizeRegisterFormat('bits')).toBe('bits');
    // v3：string 已成为合法形态；v4：double 亦然
    expect(normalizeRegisterFormat('string')).toBe('string');
    expect(normalizeRegisterFormat('double')).toBe('double');
    expect(isPointRegisterFormat('bits')).toBe(true);
    expect(isPointRegisterFormat('string')).toBe(true);
    expect(isPointRegisterFormat('double')).toBe(true);
    expect(isPointRegisterFormat('bool')).toBe(false);
  });

  it('formFromPoint：老数据（无 registerFormat）回落 int，位域空串化', () => {
    const form = formFromPoint({
      id: '1',
      deviceId: '9',
      propertyId: '1001',
      refType: 'property',
      rawAddress: '40001',
      addressType: 'holding',
      rw: 'R',
    });
    expect(form.registerFormat).toBe('int');
    expect(form.bitOffset).toBe('');
    expect(form.bitLength).toBe('');
  });

  it('★ formFromPoint：形态与宽度不自洽时以形态为准归一（界面所见 = payload 所发）', () => {
    const asFloat = formFromPoint({
      id: '1',
      deviceId: '9',
      propertyId: '1001',
      refType: 'property',
      rawAddress: '40001',
      addressType: 'holding',
      registerFormat: 'float',
      wordCount: 1,
      rw: 'R',
    });
    expect(asFloat.registerFormat).toBe('float');
    expect(asFloat.wordCount).toBe('2');

    const asBits = formFromPoint({
      id: '1',
      deviceId: '9',
      propertyId: '1001',
      refType: 'property',
      rawAddress: '40001',
      addressType: 'holding',
      registerFormat: 'bits',
      wordCount: 2,
      rw: 'R',
    });
    expect(asBits.registerFormat).toBe('bits');
    expect(asBits.wordCount).toBe('1');
  });

  it('formFromPoint：bits 完整回显位域', () => {
    const form = formFromPoint({
      id: '1',
      deviceId: '9',
      propertyId: '1001',
      refType: 'property',
      rawAddress: '40001',
      addressType: 'holding',
      registerFormat: 'bits',
      wordCount: 1,
      bitOffset: 3,
      bitLength: 3,
      rw: 'R',
    });
    expect(form.registerFormat).toBe('bits');
    expect(form.bitOffset).toBe('3');
    expect(form.bitLength).toBe('3');
  });
});

describe('applyRegisterFormat（形态切换的联动清理）', () => {
  function bitsForm() {
    const form = validForm();
    form.registerFormat = 'bits';
    form.wordCount = '1';
    form.bitOffset = '3';
    form.bitLength = '4';
    return form;
  }

  it('★ bits → int：清掉位域字段（bitOffset / bitLength）', () => {
    const next = applyRegisterFormat(bitsForm(), 'int');
    expect(next.registerFormat).toBe('int');
    expect(next.bitOffset).toBeUndefined();
    expect(next.bitLength).toBeUndefined();
  });

  it('★ int → float：wordCount 置 2、signed 置 false、清位域', () => {
    const form = validForm();
    form.wordCount = '1';
    form.signed = true;
    form.bitOffset = '2';
    form.bitLength = '3';
    const next = applyRegisterFormat(form, 'float');
    expect(next.registerFormat).toBe('float');
    expect(next.wordCount).toBe('2');
    expect(next.signed).toBe(false);
    expect(next.bitOffset).toBeUndefined();
    expect(next.bitLength).toBeUndefined();
  });

  it('★ float → bits：wordCount 置 1、signed 置 false、清字序（后端忽略）', () => {
    const form = validForm();
    form.registerFormat = 'float';
    form.wordCount = '2';
    form.signed = true;
    form.byteOrder = 'big';
    const next = applyRegisterFormat(form, 'bits');
    expect(next.registerFormat).toBe('bits');
    expect(next.wordCount).toBe('1');
    expect(next.signed).toBe(false);
    expect(next.byteOrder).toBeUndefined();
  });

  it('int → bits 不主动编造位域（留给用户填）', () => {
    const next = applyRegisterFormat(validForm(), 'bits');
    expect(next.bitOffset).toBeUndefined();
    expect(next.bitLength).toBeUndefined();
  });
});

describe('buildPointPayload：三形态的字段组成', () => {
  it('★ int：等价 v1（wordCount + signed；字序仅 32 位下发）', () => {
    const form = validForm();
    form.registerFormat = 'int';
    form.wordCount = '2';
    form.signed = true;
    form.byteOrder = 'little';
    expect(buildPointPayload('9', form)).toMatchObject({
      registerFormat: 'int',
      wordCount: 2,
      signed: true,
      byteOrder: 'little',
    });

    const form16 = validForm();
    form16.registerFormat = 'int';
    form16.wordCount = '1';
    form16.byteOrder = 'little';
    const payload16 = buildPointPayload('9', form16);
    expect(payload16).toMatchObject({
      registerFormat: 'int',
      wordCount: 1,
      signed: false,
    });
    expect(payload16).not.toHaveProperty('byteOrder');
  });

  it('★ float：wordCount 固定 2、不发 signed、字序生效、位域不发', () => {
    const form = validForm();
    form.registerFormat = 'float';
    form.wordCount = '1';
    form.byteOrder = 'little';
    form.bitOffset = '3';
    form.bitLength = '4';
    const payload = buildPointPayload('9', form);
    expect(payload).toMatchObject({
      registerFormat: 'float',
      wordCount: 2,
      byteOrder: 'little',
    });
    expect(payload).not.toHaveProperty('signed');
    expect(payload).not.toHaveProperty('bitOffset');
    expect(payload).not.toHaveProperty('bitLength');
  });

  it('★ bits：wordCount 固定 1、带出 bitOffset/bitLength、不发 signed/字序', () => {
    const form = validForm();
    form.registerFormat = 'bits';
    form.wordCount = '2';
    form.bitOffset = '3';
    form.bitLength = '3';
    form.byteOrder = 'big';
    form.signed = true;
    const payload = buildPointPayload('9', form);
    expect(payload).toMatchObject({
      registerFormat: 'bits',
      wordCount: 1,
      bitOffset: 3,
      bitLength: 3,
    });
    expect(payload).not.toHaveProperty('signed');
    expect(payload).not.toHaveProperty('byteOrder');
  });

  it('三种形态都只在 Modbus 寄存器点位下发（非寄存器点位一律不带）', () => {
    for (const addressType of ['coil', 'discrete', 'nodeid', 'topic']) {
      for (const registerFormat of ['int', 'float', 'bits']) {
        const form = validForm();
        form.addressType = addressType;
        form.registerFormat = registerFormat;
        form.bitOffset = '1';
        form.bitLength = '1';
        const payload = buildPointPayload('9', form);
        for (const field of [
          'bitLength',
          'bitOffset',
          'byteOrder',
          'registerFormat',
          'signed',
          'wordCount',
        ]) {
          expect(payload).not.toHaveProperty(field);
        }
      }
    }
  });
});

describe('位域（bits）校验', () => {
  function bitsForm(offset: string, length: string) {
    const form = validForm();
    form.registerFormat = 'bits';
    form.bitOffset = offset;
    form.bitLength = length;
    return form;
  }

  it('合法范围通过（含边界 0..15 / 1..16）', () => {
    expect(validatePointForm(bitsForm('0', '16')).ok).toBe(true);
    expect(validatePointForm(bitsForm('15', '1')).ok).toBe(true);
    expect(validatePointForm(bitsForm('3', '3')).ok).toBe(true);
    expect(POINT_BIT_OFFSET_MAX).toBe(15);
    expect(POINT_REGISTER_BITS).toBe(16);
  });

  it('★ 越界拒绝：起始位 + 位宽 > 16', () => {
    expect(validatePointForm(bitsForm('15', '2')).ok).toBe(false);
    expect(validatePointForm(bitsForm('10', '7')).ok).toBe(false);
  });

  it('起始位越界 / 非整数 / 空 ⇒ 拒绝', () => {
    expect(validatePointForm(bitsForm('16', '1')).ok).toBe(false);
    expect(validatePointForm(bitsForm('-1', '1')).ok).toBe(false);
    expect(validatePointForm(bitsForm('1.5', '1')).ok).toBe(false);
    expect(validatePointForm(bitsForm('', '1')).ok).toBe(false);
  });

  it('位宽 < 1 / 非整数 / 空 ⇒ 拒绝', () => {
    expect(validatePointForm(bitsForm('0', '0')).ok).toBe(false);
    expect(validatePointForm(bitsForm('0', '1.5')).ok).toBe(false);
    expect(validatePointForm(bitsForm('0', '')).ok).toBe(false);
  });

  it('int/float 不校验位域（该形态下位域字段不参与）', () => {
    const form = validForm();
    form.registerFormat = 'int';
    form.bitOffset = '99';
    form.bitLength = '99';
    expect(validatePointForm(form).ok).toBe(true);
  });

  it('registerFormat 非法取值 ⇒ 拒绝（string 已合法）', () => {
    expect(
      validatePointForm({ ...validForm(), registerFormat: 'bool' }).ok,
    ).toBe(false);
    expect(
      validatePointForm({ ...validForm(), registerFormat: 'string' }).ok,
    ).toBe(true);
  });
});

describe('string 形态（多寄存器拼固定 UTF-8）', () => {
  it('normalizeStringWordCount：1..32 原样，越界/非法回落 1', () => {
    expect(normalizeStringWordCount(1)).toBe('1');
    expect(normalizeStringWordCount(3)).toBe('3');
    expect(normalizeStringWordCount(32)).toBe('32');
    expect(normalizeStringWordCount('3')).toBe('3');
    expect(normalizeStringWordCount(0)).toBe('1');
    expect(normalizeStringWordCount(33)).toBe('1');
    expect(normalizeStringWordCount('abc')).toBe('1');
    expect(normalizeStringWordCount(undefined)).toBe('1');
    expect(POINT_STRING_WORD_COUNT_MIN).toBe(1);
    expect(POINT_STRING_WORD_COUNT_MAX).toBe(32);
  });

  it('★ payload：string 只发 registerFormat + wordCount（不发 signed/字序/位域）', () => {
    const form = validForm();
    form.registerFormat = 'string';
    form.wordCount = '3';
    // 故意都填上：string 下必须一个都不下发
    form.signed = true;
    form.byteOrder = 'big';
    form.bitOffset = '3';
    form.bitLength = '3';
    const payload = buildPointPayload('9', form);
    expect(payload).toMatchObject({ registerFormat: 'string', wordCount: 3 });
    for (const field of ['bitLength', 'bitOffset', 'byteOrder', 'signed']) {
      expect(payload).not.toHaveProperty(field);
    }
    // 与 int 基线相比，只少一个 signed（即 string 只带 registerFormat + wordCount 两个形态字段）
    const intPayload = buildPointPayload('9', validForm());
    expect(Object.keys(payload).toSorted()).toEqual(
      Object.keys(intPayload)
        .filter((key) => key !== 'signed')
        .toSorted(),
    );
  });

  it('★ 切换清理：切到 string ⇒ wordCount=1、清 signed/字序/位域', () => {
    const form = validForm();
    form.registerFormat = 'bits';
    form.wordCount = '1';
    form.signed = true;
    form.byteOrder = 'little';
    form.bitOffset = '3';
    form.bitLength = '3';
    const next = applyRegisterFormat(form, 'string');
    expect(next.registerFormat).toBe('string');
    expect(next.wordCount).toBe('1');
    expect(next.signed).toBe(false);
    expect(next.byteOrder).toBeUndefined();
    expect(next.bitOffset).toBeUndefined();
    expect(next.bitLength).toBeUndefined();
  });

  it('★ 切走 string 时清掉超范围的寄存器个数（int 只认 1|2）', () => {
    const form = validForm();
    form.registerFormat = 'string';
    form.wordCount = '9';
    const next = applyRegisterFormat(form, 'int');
    expect(next.registerFormat).toBe('int');
    expect(next.wordCount).toBe('1');
    // 1..2 范围内的值保持不动
    const form2 = validForm();
    form2.registerFormat = 'string';
    form2.wordCount = '2';
    expect(applyRegisterFormat(form2, 'int').wordCount).toBe('2');
  });

  it('★ 校验边界：1..32 通过；0 / 33 / 非整数 / 空 拒绝', () => {
    const withCount = (count: string) => {
      const form = validForm();
      form.registerFormat = 'string';
      form.wordCount = count;
      return form;
    };
    expect(validatePointForm(withCount('1')).ok).toBe(true);
    expect(validatePointForm(withCount('3')).ok).toBe(true);
    expect(validatePointForm(withCount('32')).ok).toBe(true);
    expect(validatePointForm(withCount('0')).ok).toBe(false);
    expect(validatePointForm(withCount('33')).ok).toBe(false);
    expect(validatePointForm(withCount('1.5')).ok).toBe(false);
    expect(validatePointForm(withCount('abc')).ok).toBe(false);
    expect(validatePointForm(withCount('')).ok).toBe(false);
  });

  it('formFromPoint：string 回显寄存器个数（越界/缺失回落 1）', () => {
    const stringResp = (
      wordCount?: number,
    ): Parameters<typeof formFromPoint>[0] => ({
      id: '1',
      deviceId: '9',
      propertyId: '1001',
      refType: 'property',
      rawAddress: '40001',
      addressType: 'holding',
      registerFormat: 'string',
      wordCount,
      rw: 'R',
    });
    expect(formFromPoint(stringResp(3)).wordCount).toBe('3');
    expect(formFromPoint(stringResp(32)).wordCount).toBe('32');
    expect(formFromPoint(stringResp(33)).wordCount).toBe('1');
    expect(formFromPoint(stringResp(undefined)).wordCount).toBe('1');
  });

  it('registerDecodeSegments：`字符串 · 3 个寄存器（UTF-8）`，个数异常只说形态', () => {
    expect(
      registerDecodeSegments({
        addressType: 'holding',
        registerFormat: 'string',
        wordCount: 3,
      }),
    ).toEqual([
      { key: 'page.iot.point.registerFormatStringShort' },
      { key: 'page.iot.point.stringWordCountShort', params: [3] },
    ]);
    expect(
      registerDecodeSegments({
        addressType: 'holding',
        registerFormat: 'string',
        wordCount: 99,
      }),
    ).toEqual([{ key: 'page.iot.point.registerFormatStringShort' }]);
    expect(
      registerDecodeSegments({
        addressType: 'holding',
        registerFormat: 'string',
      }),
    ).toEqual([{ key: 'page.iot.point.registerFormatStringShort' }]);
  });

  it('非寄存器点位仍不下发 string 形态（沿用 v2 规则）', () => {
    for (const addressType of ['coil', 'discrete', 'nodeid', 'topic']) {
      const form = validForm();
      form.addressType = addressType;
      form.registerFormat = 'string';
      form.wordCount = '4';
      const payload = buildPointPayload('9', form);
      expect(payload).not.toHaveProperty('registerFormat');
      expect(payload).not.toHaveProperty('wordCount');
    }
  });
});

describe('double 形态（IEEE754 双精度，固定 4 寄存器）', () => {
  it('注册表与常量：double 合法，固定 4 个寄存器', () => {
    expect(isPointRegisterFormat('double')).toBe(true);
    expect(normalizeRegisterFormat('double')).toBe('double');
    expect(POINT_DOUBLE_WORD_COUNT).toBe(4);
  });

  it('★ payload：只发 registerFormat + wordCount=4 + 可选 byteOrder（不发 signed/位域）', () => {
    const form = validForm();
    form.registerFormat = 'double';
    form.wordCount = '4';
    form.byteOrder = 'little';
    // 故意都填上：double 下 signed/位域必须一个都不下发
    form.signed = true;
    form.bitOffset = '3';
    form.bitLength = '3';
    const payload = buildPointPayload('9', form);
    expect(payload).toMatchObject({
      registerFormat: 'double',
      wordCount: 4,
      byteOrder: 'little',
    });
    for (const field of ['bitLength', 'bitOffset', 'signed']) {
      expect(payload).not.toHaveProperty(field);
    }
    // 未选字序时不发 byteOrder
    const noOrder = validForm();
    noOrder.registerFormat = 'double';
    noOrder.wordCount = '4';
    expect(buildPointPayload('9', noOrder)).not.toHaveProperty('byteOrder');
  });

  it('★ 校验：wordCount 必须为 4（1/2/3/5/空/非数字 全拒）', () => {
    const withCount = (count: string) => {
      const form = validForm();
      form.registerFormat = 'double';
      form.wordCount = count;
      return form;
    };
    expect(validatePointForm(withCount('4')).ok).toBe(true);
    for (const bad of ['', '1', '2', '3', '5', '44', 'x']) {
      expect(validatePointForm(withCount(bad)).ok).toBe(false);
    }
  });

  it('★ 切换清理：切到 double ⇒ wordCount=4、清 signed/位域、**保留字序**（与 float 一致）', () => {
    const form = validForm();
    form.registerFormat = 'int';
    form.wordCount = '1';
    form.signed = true;
    form.byteOrder = 'little';
    form.bitOffset = '3';
    form.bitLength = '3';
    const next = applyRegisterFormat(form, 'double');
    expect(next.registerFormat).toBe('double');
    expect(next.wordCount).toBe('4');
    expect(next.signed).toBe(false);
    expect(next.bitOffset).toBeUndefined();
    expect(next.bitLength).toBeUndefined();
    expect(next.byteOrder).toBe('little');
  });

  it('★ 切走 double 时超范围 wordCount 清回 1 / 归到目标形态固定值', () => {
    const form = validForm();
    form.registerFormat = 'double';
    form.wordCount = '4';
    const toInt = applyRegisterFormat(form, 'int');
    expect(toInt.registerFormat).toBe('int');
    expect(toInt.wordCount).toBe('1');
    expect(applyRegisterFormat(form, 'float').wordCount).toBe('2');
    expect(applyRegisterFormat(form, 'bits').wordCount).toBe('1');
  });

  it('formFromPoint：double 回显 wordCount=4（脏数据也归一到 4）', () => {
    const doubleResp = (
      wordCount?: number,
    ): Parameters<typeof formFromPoint>[0] => ({
      id: '1',
      deviceId: '9',
      propertyId: '1001',
      refType: 'property',
      rawAddress: '40001',
      addressType: 'holding',
      registerFormat: 'double',
      wordCount,
      rw: 'R',
    });
    expect(formFromPoint(doubleResp(4)).wordCount).toBe('4');
    expect(formFromPoint(doubleResp(2)).wordCount).toBe('4');
    expect(formFromPoint(doubleResp(undefined)).wordCount).toBe('4');
  });

  it('registerDecodeSegments：`双精度浮点（4 个寄存器） · 低字在前（DCBA）`', () => {
    expect(
      registerDecodeSegments({
        addressType: 'holding',
        registerFormat: 'double',
        wordCount: 4,
        byteOrder: 'little',
      }),
    ).toEqual([
      { key: 'page.iot.point.registerFormatDoubleShort' },
      { key: 'page.iot.point.byteOrderLittleDouble' },
    ]);
    expect(
      registerDecodeSegments({
        addressType: 'holding',
        registerFormat: 'double',
        wordCount: 4,
        byteOrder: 'big',
      }),
    ).toEqual([
      { key: 'page.iot.point.registerFormatDoubleShort' },
      { key: 'page.iot.point.byteOrderBig' },
    ]);
    // 未选字序 / 非法字序：只说形态
    expect(
      registerDecodeSegments({
        addressType: 'holding',
        registerFormat: 'double',
        wordCount: 4,
      }),
    ).toEqual([{ key: 'page.iot.point.registerFormatDoubleShort' }]);
    expect(
      registerDecodeSegments({
        addressType: 'holding',
        registerFormat: 'double',
        wordCount: 4,
        byteOrder: 'middle',
      }),
    ).toEqual([{ key: 'page.iot.point.registerFormatDoubleShort' }]);
  });

  it('double 只在 Modbus 寄存器点位下发（沿用 v2/v3 规则）', () => {
    for (const addressType of ['coil', 'discrete', 'nodeid', 'topic']) {
      const form = validForm();
      form.addressType = addressType;
      form.registerFormat = 'double';
      form.wordCount = '4';
      const payload = buildPointPayload('9', form);
      expect(payload).not.toHaveProperty('registerFormat');
      expect(payload).not.toHaveProperty('wordCount');
    }
  });
});

describe('int/float/bits/string 回归（v4 不改既有口径）', () => {
  it('int：wordCount 1|2 + signed；字序仅 32 位下发', () => {
    const form = validForm();
    form.registerFormat = 'int';
    form.wordCount = '2';
    form.signed = true;
    form.byteOrder = 'little';
    expect(buildPointPayload('9', form)).toMatchObject({
      registerFormat: 'int',
      wordCount: 2,
      signed: true,
      byteOrder: 'little',
    });
  });

  it('float：固定 2 寄存器、不发 signed、字序生效、不发位域', () => {
    const form = validForm();
    form.registerFormat = 'float';
    form.wordCount = '1';
    form.byteOrder = 'little';
    form.bitOffset = '3';
    form.bitLength = '3';
    const payload = buildPointPayload('9', form);
    expect(payload).toMatchObject({
      registerFormat: 'float',
      wordCount: 2,
      byteOrder: 'little',
    });
    expect(payload).not.toHaveProperty('signed');
    expect(payload).not.toHaveProperty('bitOffset');
    expect(payload).not.toHaveProperty('bitLength');
  });

  it('bits：固定 1 寄存器、带位域、不发 signed/字序；位域校验不变', () => {
    const form = validForm();
    form.registerFormat = 'bits';
    form.wordCount = '2';
    form.signed = true;
    form.byteOrder = 'big';
    form.bitOffset = '3';
    form.bitLength = '3';
    const payload = buildPointPayload('9', form);
    expect(payload).toMatchObject({
      registerFormat: 'bits',
      wordCount: 1,
      bitOffset: 3,
      bitLength: 3,
    });
    expect(payload).not.toHaveProperty('signed');
    expect(payload).not.toHaveProperty('byteOrder');
    // 既有校验不变：0..15 / 1..16-offset
    expect(
      validatePointForm({ ...form, bitOffset: '15', bitLength: '1' }).ok,
    ).toBe(true);
    expect(
      validatePointForm({ ...form, bitOffset: '15', bitLength: '2' }).ok,
    ).toBe(false);
    expect(
      validatePointForm({ ...form, bitOffset: '16', bitLength: '1' }).ok,
    ).toBe(false);
  });

  it('string：只发 registerFormat + wordCount（回归不变）', () => {
    const form = validForm();
    form.registerFormat = 'string';
    form.wordCount = '3';
    form.signed = true;
    form.byteOrder = 'big';
    const payload = buildPointPayload('9', form);
    expect(payload).toMatchObject({ registerFormat: 'string', wordCount: 3 });
    for (const field of ['signed', 'byteOrder', 'bitOffset', 'bitLength']) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  it('int/float/bits 的 wordCount 校验仍是 1|2；double 必须为 4（不受 string 1..32 影响）', () => {
    for (const registerFormat of ['int', 'float', 'bits']) {
      const form = validForm();
      form.registerFormat = registerFormat;
      form.wordCount = '3';
      expect(validatePointForm(form).ok).toBe(false);
      expect(buildPointPayload('9', form).wordCount).not.toBe(3);
    }
    const doubleForm = validForm();
    doubleForm.registerFormat = 'double';
    doubleForm.wordCount = '3';
    expect(validatePointForm(doubleForm).ok).toBe(false);
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
