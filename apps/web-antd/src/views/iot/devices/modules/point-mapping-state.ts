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

/** 字节序（schema 注释 big|little）。 */
export const POINT_BYTE_ORDERS = [
  { value: 'big', labelKey: 'page.iot.point.byteOrderBig' },
  { value: 'little', labelKey: 'page.iot.point.byteOrderLittle' },
] as const;

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
    form.byteOrder !== undefined &&
    form.byteOrder !== '' &&
    form.byteOrder !== 'big' &&
    form.byteOrder !== 'little'
  ) {
    return { ok: false, message: '字节序只能是 big 或 little' };
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
  if (form.byteOrder) {
    payload.byteOrder = form.byteOrder;
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
    rw: point.rw,
    enabled: point.enabled !== false,
  };
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
