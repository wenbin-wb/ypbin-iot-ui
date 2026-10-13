import type { IotPointApi } from '#/api/iot';

/**
 * 点位映射表单的**纯逻辑**（枚举/校验/payload 构建/回显），零 vue 依赖可单测。
 *
 * 校验逐条对齐后端 `IotPointMappingReq`：
 *   propertyId @NotNull；refType/addressType/rawAddress/rw @NotBlank；
 *   rawAddress @Size(max=128)；pollIntervalMs @Min(0)；scaleFactor/offsetValue 可空数字；
 *   byteOrder 可空 big|little；enabled 可空。
 *
 * Modbus 寄存器解码 v2 追加 registerFormat（int|float|bits）与位域（bitOffset/bitLength）：
 * 三形态的字段可见性、payload 组成与切换清理都收敛在本文件，便于断言（见 applyRegisterFormat /
 * buildPointPayload / registerDecodeSegments）。
 */

/** propertyId 可映射到的引用类型（后端 PointRefType）。 */
export const POINT_REF_TYPES = [
  { value: 'property', labelKey: 'page.iot.point.refTypeProperty' },
  { value: 'command', labelKey: 'page.iot.point.refTypeCommand' },
] as const;

/** 地址类型（后端 AddressType）。 */
export const POINT_ADDRESS_TYPES = [
  { value: 'holding', labelKey: 'page.iot.point.addressHolding' },
  { value: 'input', labelKey: 'page.iot.point.addressInput' },
  { value: 'coil', labelKey: 'page.iot.point.addressCoil' },
  { value: 'discrete', labelKey: 'page.iot.point.addressDiscrete' },
  { value: 'nodeid', labelKey: 'page.iot.point.addressNodeId' },
  { value: 'topic', labelKey: 'page.iot.point.addressTopic' },
] as const;

/**
 * 字序（word order，后端 `byteOrder`）：big = 高字在前（ABCD）；little = 低字在前（CDAB）。
 * **仅 Modbus 寄存器点位、且 wordCount=2（32 位）时生效。**
 */
export const POINT_BYTE_ORDERS = [
  { value: 'big', labelKey: 'page.iot.point.byteOrderBig' },
  { value: 'little', labelKey: 'page.iot.point.byteOrderLittle' },
] as const;

/**
 * 寄存器值形态（后端 `registerFormat`，默认 `int`）。
 * - int：整数（等价 v1 —— wordCount 1|2 + signed + 字序）；
 * - float：IEEE754 **单精度**浮点，固定占 2 个寄存器，不发 signed，字序生效；
 * - bits：单寄存器内位域，固定 1 个寄存器，不发 signed/字序，必填 bitOffset + bitLength。
 */
export const POINT_REGISTER_FORMATS = [
  { value: 'int', labelKey: 'page.iot.point.registerFormatInt' },
  { value: 'float', labelKey: 'page.iot.point.registerFormatFloat' },
  { value: 'bits', labelKey: 'page.iot.point.registerFormatBits' },
] as const;

/** 寄存器值形态取值。 */
export type PointRegisterFormat =
  (typeof POINT_REGISTER_FORMATS)[number]['value'];

/** 单个 Modbus 寄存器的位宽（位域校验上限）。 */
export const POINT_REGISTER_BITS = 16;

/** 位域起始位上限（0..15）。 */
export const POINT_BIT_OFFSET_MAX = POINT_REGISTER_BITS - 1;

/** 是否为合法的寄存器值形态；非法/缺省一律按 `int` 回落。 */
export function isPointRegisterFormat(
  value?: string,
): value is PointRegisterFormat {
  return value === 'int' || value === 'float' || value === 'bits';
}

/** 形态兜底：缺字段（老数据/后端未返回）按后端默认 `int` 回落。 */
export function normalizeRegisterFormat(value?: string): PointRegisterFormat {
  return isPointRegisterFormat(value) ? value : 'int';
}

/** Modbus 寄存器宽度（后端 `wordCount`，int 1|2，默认 1）。 */
export const POINT_WORD_COUNTS = [
  { value: '1', labelKey: 'page.iot.point.wordCount1' },
  { value: '2', labelKey: 'page.iot.point.wordCount2' },
] as const;

/**
 * Modbus 数值符号（后端 `signed`，**Boolean**，默认 false = 无符号）。
 * 与同 DTO 的 `enabled` 口径一致（DB 列 TINYINT 0/1，Java 侧是 Boolean）。
 */
export const POINT_SIGNED_OPTIONS = [
  { value: false, labelKey: 'page.iot.point.unsigned' },
  { value: true, labelKey: 'page.iot.point.signedInt' },
] as const;

/**
 * 是否为「Modbus 寄存器」地址类型 —— 只有保持/输入寄存器参与寄存器解码 v1。
 * coil/discrete（位）与 nodeid/topic（非 Modbus）都不适用。
 */
export function isModbusRegisterAddressType(addressType?: string): boolean {
  return addressType === 'holding' || addressType === 'input';
}

/** 读写权限（schema 注释 R/W/RW）。 */
export const POINT_RW_OPTIONS = [
  { value: 'R', labelKey: 'page.iot.point.rwRead' },
  { value: 'W', labelKey: 'page.iot.point.rwWrite' },
  { value: 'RW', labelKey: 'page.iot.point.rwReadWrite' },
] as const;

/** 协议内地址最大长度（后端 @Size(max=128)）。 */
export const POINT_RAW_ADDRESS_MAX = 128;

/** 表单界面（字符串形态，便于回显与提交保真）。 */
export interface PointForm {
  propertyId: string;
  refType: string;
  rawAddress: string;
  addressType: string;
  /** 采集周期毫秒（空 = 未设）。 */
  pollIntervalMs?: string;
  /** 缩放因子（空 = 未设）。 */
  scaleFactor?: string;
  /** 偏移量（空 = 未设）。 */
  offsetValue?: string;
  byteOrder?: string;
  /** Modbus 寄存器宽度（'1' = 16 位 | '2' = 32 位；字符串形态便于回显与提交保真）。 */
  wordCount: string;
  /** Modbus 数值符号（false = 无符号 | true = 有符号）。 */
  signed: boolean;
  /** 寄存器值形态（'int' | 'float' | 'bits'）。 */
  registerFormat: string;
  /** 位域起始位（仅 bits；字符串形态，空 = 未填）。 */
  bitOffset?: string;
  /** 位域位宽（仅 bits；字符串形态，空 = 未填）。 */
  bitLength?: string;
  rw: string;
  enabled: boolean;
}

/** 校验结论。 */
export interface PointFormCheck {
  ok: boolean;
  /** ok=false 时非空。 */
  message: string;
}

/**
 * 新建时的默认表单（enabled 默认开、rw 默认 R —— schema 默认 R）。
 */
export function emptyPointForm(): PointForm {
  return {
    propertyId: '',
    refType: 'property',
    rawAddress: '',
    addressType: 'holding',
    pollIntervalMs: undefined,
    scaleFactor: undefined,
    offsetValue: undefined,
    byteOrder: undefined,
    // 后端默认值：wordCount=1、signed=false（无符号）；byteOrder 默认不写（空 = 不发送）。
    wordCount: '1',
    signed: false,
    // 后端默认值：registerFormat='int'；位域字段仅在 bits 下填写，默认不写。
    registerFormat: 'int',
    bitOffset: undefined,
    bitLength: undefined,
    rw: 'R',
    enabled: true,
  };
}

/**
 * 形态切换时的**联动清理**（返回新表单；原则与 v1 一致：界面所见即所发）。
 *
 * - `float`：wordCount 固定 2、signed 置 false（后端要求 false 且不下发）、清位域字段；
 * - `bits`：wordCount 固定 1、signed 置 false、清字序（后端忽略），位域字段留给用户填；
 * - `int`：清位域字段（位域只属于 bits），wordCount/signed 保持用户选择。
 */
export function applyRegisterFormat(
  form: PointForm,
  format: string,
): PointForm {
  const next: PointForm = { ...form, registerFormat: format };
  if (format === 'float') {
    next.wordCount = '2';
    next.signed = false;
    next.bitOffset = undefined;
    next.bitLength = undefined;
  } else if (format === 'bits') {
    next.wordCount = '1';
    next.signed = false;
    next.byteOrder = undefined;
  } else {
    next.bitOffset = undefined;
    next.bitLength = undefined;
  }
  return next;
}

/** 数字是否合法（可空：空 = 合法；非空必须是有限数字）。 */
function isOptionalNumber(text?: string): boolean {
  if (text === undefined || text === null || text.trim() === '') {
    return true;
  }
  const value = Number(text);
  return Number.isFinite(value);
}

/** 校验表单（与后端 @NotBlank/@NotNull/@Size/@Min 同口径）。 */
export function validatePointForm(form: PointForm): PointFormCheck {
  if (!form.propertyId || form.propertyId.trim() === '') {
    return { ok: false, message: '关联属性/命令不能为空' };
  }
  if (!form.refType || form.refType.trim() === '') {
    return { ok: false, message: '关联类型不能为空' };
  }
  if (!form.addressType || form.addressType.trim() === '') {
    return { ok: false, message: '地址类型不能为空' };
  }
  if (!form.rw || form.rw.trim() === '') {
    return { ok: false, message: '读写权限不能为空' };
  }
  const address = (form.rawAddress ?? '').trim();
  if (address === '') {
    return { ok: false, message: '协议内地址不能为空' };
  }
  if (address.length > POINT_RAW_ADDRESS_MAX) {
    return {
      ok: false,
      message: `协议内地址超过 ${POINT_RAW_ADDRESS_MAX} 字符限制`,
    };
  }
  if (form.pollIntervalMs !== undefined && form.pollIntervalMs !== '') {
    const interval = Number(form.pollIntervalMs);
    if (!Number.isInteger(interval) || interval < 0) {
      return { ok: false, message: '采集周期必须是非负整数（毫秒）' };
    }
  }
  if (!isOptionalNumber(form.scaleFactor)) {
    return { ok: false, message: '缩放因子必须是数字' };
  }
  if (!isOptionalNumber(form.offsetValue)) {
    return { ok: false, message: '偏移量必须是数字' };
  }
  if (
    form.wordCount !== undefined &&
    form.wordCount !== '' &&
    form.wordCount !== '1' &&
    form.wordCount !== '2'
  ) {
    return { ok: false, message: '寄存器宽度只能是 1（16 位）或 2（32 位）' };
  }
  if (form.signed !== true && form.signed !== false) {
    return { ok: false, message: '数值符号必须是有符号(true)/无符号(false)' };
  }
  if (!isPointRegisterFormat(form.registerFormat)) {
    return { ok: false, message: '寄存器值形态只能是 int / float / bits' };
  }
  if (form.registerFormat === 'bits') {
    const offsetText = (form.bitOffset ?? '').trim();
    const lengthText = (form.bitLength ?? '').trim();
    if (offsetText === '') {
      return { ok: false, message: '位域的起始位不能为空（0..15）' };
    }
    if (lengthText === '') {
      return { ok: false, message: '位域的位宽不能为空（1..16-起始位）' };
    }
    const offset = Number(offsetText);
    const length = Number(lengthText);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > POINT_BIT_OFFSET_MAX
    ) {
      return {
        ok: false,
        message: `位域起始位必须是 0..${POINT_BIT_OFFSET_MAX} 的整数`,
      };
    }
    if (!Number.isInteger(length) || length < 1) {
      return { ok: false, message: '位域位宽必须是不小于 1 的整数' };
    }
    if (offset + length > POINT_REGISTER_BITS) {
      return {
        ok: false,
        message: `位域越界：起始位 + 位宽不能超过 ${POINT_REGISTER_BITS}（当前 ${offset} + ${length} = ${offset + length}）`,
      };
    }
  }
  if (
    form.byteOrder !== undefined &&
    form.byteOrder !== '' &&
    form.byteOrder !== 'big' &&
    form.byteOrder !== 'little'
  ) {
    return { ok: false, message: '字序只能是 big 或 little' };
  }
  return { ok: true, message: '' };
}

/**
 * 构建后端请求体（enabled 缺省 true；空数字字段不发送，避免把 undefined 序列化进去）。
 */
export function buildPointPayload(
  deviceId: string,
  form: PointForm,
): IotPointApi.PointMappingSaveReq {
  const payload: IotPointApi.PointMappingSaveReq = {
    deviceId,
    propertyId: form.propertyId.trim(),
    refType: form.refType.trim(),
    rawAddress: form.rawAddress.trim(),
    addressType: form.addressType.trim(),
    rw: form.rw.trim(),
    enabled: form.enabled,
  };
  const interval = form.pollIntervalMs?.trim();
  if (interval) {
    payload.pollIntervalMs = Number(interval);
  }
  const scale = form.scaleFactor?.trim();
  if (scale) {
    payload.scaleFactor = scale;
  }
  const offset = form.offsetValue?.trim();
  if (offset) {
    payload.offsetValue = offset;
  }
  // 寄存器解码字段只对保持/输入寄存器有意义；其余地址类型一律不下发（后端按默认处理）。
  if (isModbusRegisterAddressType(form.addressType)) {
    const format = normalizeRegisterFormat(form.registerFormat);
    payload.registerFormat = format;
    if (format === 'float') {
      // IEEE754 单精度固定占 2 个寄存器；signed 由后端要求 false ⇒ 不下发。
      payload.wordCount = 2;
      if (form.byteOrder) {
        payload.byteOrder = form.byteOrder;
      }
    } else if (format === 'bits') {
      // 单寄存器内位域：wordCount 固定 1；signed / 字序后端忽略 ⇒ 不下发。
      payload.wordCount = 1;
      const offset = form.bitOffset?.trim();
      const length = form.bitLength?.trim();
      if (offset) {
        payload.bitOffset = Number(offset);
      }
      if (length) {
        payload.bitLength = Number(length);
      }
    } else {
      payload.wordCount = form.wordCount === '2' ? 2 : 1;
      payload.signed = form.signed === true;
      // 字序仅在 32 位（wordCount=2）时生效 ⇒ wordCount=1 时 byteOrder 不参与 payload。
      if (payload.wordCount === 2 && form.byteOrder) {
        payload.byteOrder = form.byteOrder;
      }
    }
  }
  return payload;
}

/**
 * 编辑回显：Resp → 表单（BigDecimal 字符串保留；可空字段空串化，便于输入框占位）。
 */
export function formFromPoint(point: IotPointApi.PointMappingResp): PointForm {
  // 形态决定宽度：float 固定 2、bits 固定 1。若后端数据与形态不自洽（历史脏数据），
  // 以形态为准归一，保证「界面所见 = payload 所发」。
  const registerFormat = normalizeRegisterFormat(point.registerFormat);
  let wordCount = point.wordCount === 2 ? '2' : '1';
  if (registerFormat === 'float') {
    wordCount = '2';
  } else if (registerFormat === 'bits') {
    wordCount = '1';
  }
  return {
    propertyId: point.propertyId,
    refType: point.refType,
    rawAddress: point.rawAddress,
    addressType: point.addressType,
    pollIntervalMs:
      point.pollIntervalMs === undefined || point.pollIntervalMs === null
        ? ''
        : String(point.pollIntervalMs),
    scaleFactor: point.scaleFactor ?? '',
    offsetValue: point.offsetValue ?? '',
    byteOrder: point.byteOrder ?? '',
    // 缺字段（老数据/后端未返回）回落到后端默认：wordCount=1、signed=false。
    wordCount,
    signed: point.signed === true,
    // 缺字段（老数据/后端未返回）按后端默认 registerFormat='int' 回落；位域空串化便于输入。
    registerFormat,
    bitOffset:
      point.bitOffset === undefined || point.bitOffset === null
        ? ''
        : String(point.bitOffset),
    bitLength:
      point.bitLength === undefined || point.bitLength === null
        ? ''
        : String(point.bitLength),
    rw: point.rw,
    enabled: point.enabled !== false,
  };
}

/** 列表展示用的点位解码信息字段（Resp 的最小子集）。 */
export interface RegisterDecodePoint {
  addressType?: string;
  bitLength?: number;
  bitOffset?: number;
  byteOrder?: string;
  registerFormat?: string;
  signed?: boolean;
  wordCount?: number;
}

/** 「解码」列的一个可读片段：i18n 键 + 可选插值参数。 */
export interface RegisterDecodeSegment {
  key: string;
  params?: (number | string)[];
}

/** 字序枚举 → i18n 键（非法取值返回 undefined，不瞎猜）。 */
function byteOrderKey(byteOrder?: string): string | undefined {
  if (byteOrder === 'big') {
    return 'page.iot.point.byteOrderBig';
  }
  if (byteOrder === 'little') {
    return 'page.iot.point.byteOrderLittle';
  }
  return undefined;
}

/**
 * 寄存器解码的**可读片段**（由调用方 `$t(key, params)` 后拼接）。
 *
 * - 非 Modbus 寄存器点位（coil/discrete/nodeid/topic）返回 `[]` ⇒ 列表显示 `-`；
 * - `int`（默认）：`32 位（2 个寄存器） · 有符号 · 高字在前（ABCD）`；
 * - `float`：`32 位浮点 · 低字在前（CDAB）`（IEEE754 单精度固定 2 寄存器）；
 * - `bits`：`位域：bit 3..5（3 位）`（位域信息缺失时退化为 `位域`）；
 * - 一律不裸露 `big`/`little`、`int` 这类枚举值。
 */
export function registerDecodeSegments(
  point: RegisterDecodePoint,
): RegisterDecodeSegment[] {
  if (!isModbusRegisterAddressType(point.addressType)) {
    return [];
  }
  const format = normalizeRegisterFormat(point.registerFormat);

  if (format === 'float') {
    // IEEE754 单精度固定 2 个寄存器；字序仍生效。
    const segments: RegisterDecodeSegment[] = [
      { key: 'page.iot.point.registerFormatFloatShort' },
    ];
    const orderKey = byteOrderKey(point.byteOrder);
    if (orderKey) {
      segments.push({ key: orderKey });
    }
    return segments;
  }

  if (format === 'bits') {
    const { bitLength, bitOffset } = point;
    if (
      typeof bitOffset !== 'number' ||
      typeof bitLength !== 'number' ||
      !Number.isInteger(bitOffset) ||
      !Number.isInteger(bitLength) ||
      bitLength < 1
    ) {
      // 位域信息不完整（异常数据）：只说明形态，不编造范围。
      return [{ key: 'page.iot.point.registerFormatBitsShort' }];
    }
    return [
      {
        key: 'page.iot.point.bitsRangeShort',
        params: [bitOffset, bitOffset + bitLength - 1, bitLength],
      },
    ];
  }

  // int：等价 v1 的「宽度 · 符号 ·（仅 32 位时）字序」。
  const segments: RegisterDecodeSegment[] = [
    {
      key:
        point.wordCount === 2
          ? 'page.iot.point.wordCount2'
          : 'page.iot.point.wordCount1',
    },
    {
      key:
        point.signed === true
          ? 'page.iot.point.signedInt'
          : 'page.iot.point.unsigned',
    },
  ];
  if (point.wordCount === 2) {
    const orderKey = byteOrderKey(point.byteOrder);
    if (orderKey) {
      segments.push({ key: orderKey });
    }
  }
  return segments;
}

/** 点位列表展示态（错误优先于空）。 */
export type PointListState = 'empty' | 'error' | 'loading' | 'ready';

export function resolvePointListState(
  loading: boolean,
  errorMessage: string,
  itemCount: number,
): PointListState {
  if (loading) {
    return 'loading';
  }
  if (errorMessage) {
    return 'error';
  }
  return itemCount > 0 ? 'ready' : 'empty';
}
