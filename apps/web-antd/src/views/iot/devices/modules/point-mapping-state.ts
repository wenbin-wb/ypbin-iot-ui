import type { IotPointApi } from '#/api/iot';

/**
 * 点位映射表单的**纯逻辑**（枚举/校验/payload 构建/回显），零 vue 依赖可单测。
 *
 * 校验逐条对齐后端 `IotPointMappingReq`：
 *   propertyId @NotNull；refType/addressType/rawAddress/rw @NotBlank；
 *   rawAddress @Size(max=128)；pollIntervalMs @Min(0)；scaleFactor/offsetValue 可空数字；
 *   byteOrder 可空 big|little；enabled 可空。
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
    rw: 'R',
    enabled: true,
  };
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
  // Modbus 寄存器解码三字段只对保持/输入寄存器有意义；其余地址类型一律不下发（后端按默认处理）。
  if (isModbusRegisterAddressType(form.addressType)) {
    payload.wordCount = form.wordCount === '2' ? 2 : 1;
    payload.signed = form.signed === true;
    // 字序仅在 32 位（wordCount=2）时生效 ⇒ wordCount=1 时 byteOrder 不参与 payload。
    if (payload.wordCount === 2 && form.byteOrder) {
      payload.byteOrder = form.byteOrder;
    }
  }
  return payload;
}

/**
 * 编辑回显：Resp → 表单（BigDecimal 字符串保留；可空字段空串化，便于输入框占位）。
 */
export function formFromPoint(point: IotPointApi.PointMappingResp): PointForm {
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
    wordCount: point.wordCount === 2 ? '2' : '1',
    signed: point.signed === true,
    rw: point.rw,
    enabled: point.enabled !== false,
  };
}

/** 列表展示用的点位解码信息字段（Resp 的最小子集）。 */
export interface RegisterDecodePoint {
  addressType?: string;
  byteOrder?: string;
  signed?: boolean;
  wordCount?: number;
}

/**
 * 寄存器解码的**可读片段**（返回 i18n 键数组，由调用方 `$t()` 后拼接）。
 *
 * - 非 Modbus 寄存器点位（coil/discrete/nodeid/topic）返回 `[]` ⇒ 列表显示 `-`；
 * - 顺序固定为「宽度 · 符号 ·（仅 32 位时）字序」，避免裸露 `big`/`little` 这类枚举值。
 */
export function registerDecodeLabelKeys(point: RegisterDecodePoint): string[] {
  if (!isModbusRegisterAddressType(point.addressType)) {
    return [];
  }
  const keys = [
    point.wordCount === 2
      ? 'page.iot.point.wordCount2'
      : 'page.iot.point.wordCount1',
    point.signed === true
      ? 'page.iot.point.signedInt'
      : 'page.iot.point.unsigned',
  ];
  if (point.wordCount === 2 && point.byteOrder === 'big') {
    keys.push('page.iot.point.byteOrderBig');
  } else if (point.wordCount === 2 && point.byteOrder === 'little') {
    keys.push('page.iot.point.byteOrderLittle');
  }
  return keys;
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
