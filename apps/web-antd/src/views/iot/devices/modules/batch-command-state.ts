import type { IotCommandApi, IotThingModelApi } from '#/api/iot';

import { buildCsv } from './series-utils';

/**
 * 批量下发的**纯逻辑层**（零 vue、零网络、零 i18n 文案，便于单测）。
 *
 * 为什么单独一层：批量下发最容易出的三类事故——① 把「未受理」与「已受理但未送达」混为一谈
 * （设备离线被当成配置错误，运维去改物模型而真正的问题是网络）；② 部分失败被汇总成「成功 N 台」
 * 的一句好话（**最危险**，用户以为都下发了）；③ 导出的 CSV 与表格口径不一致。
 * 这三件事都有对错、必须可回归，所以规则全部放这里，组件只做「取数 + 渲染」。
 */

/** 逐设备结果的三态（**本能力的核心口径**，与后端 accepted/ok 两字段一一映射）。 */
export type BatchItemState =
  /** 平台已受理且设备确实收到（statusCode=sent）。 */
  | 'accepted-not-delivered'
  /** 平台已受理但未送达（实例已落库，可重发；设备离线属此态，**不是失败**）。 */
  | 'delivered'
  /** 未受理（设备不存在/停用/无物模型/被拒/预算耗尽/内部错误）。 */
  | 'rejected';

/**
 * 判定单台结果的三态。
 *
 * 判定顺序**不能反**：先看 accepted（平台是否受理），再看 ok（设备是否收到）。
 * accepted 缺失按「未受理」处理——宁可按未受理如实展示（用户会去看原因），
 * 也不能把不确定的结果画成「已送达」。
 */
export function resolveBatchItemState(
  item: IotCommandApi.CommandBatchItemResult,
): BatchItemState {
  if (item?.accepted !== true) {
    return 'rejected';
  }
  return item.ok === true ? 'delivered' : 'accepted-not-delivered';
}

/** 该条是否可重发（受理成功即有 requestId ⇒ 可对该设备重发同一条请求）。 */
export function canResendBatchItem(
  item: IotCommandApi.CommandBatchItemResult,
): boolean {
  return (
    resolveBatchItemState(item) === 'accepted-not-delivered' &&
    typeof item.requestId === 'string' &&
    item.requestId !== ''
  );
}

export interface BatchResultSummary {
  accepted: number;
  delivered: number;
  notDelivered: number;
  rejected: number;
  total: number;
  /** 是否「整体成功」：**只有全部送达**才算（delivered === total 且 total > 0）。 */
  allDelivered: boolean;
  /** 是否存在任何非「已送达」的条目（部分失败/部分未送达）。 */
  partial: boolean;
}

/** 汇总逐设备结果（**从条目算**，不信任后端计数——计数与条目不一致时以条目为准）。 */
export function summarizeBatchResults(
  items: IotCommandApi.CommandBatchItemResult[],
): BatchResultSummary {
  let accepted = 0;
  let delivered = 0;
  for (const item of items) {
    const state = resolveBatchItemState(item);
    if (state === 'rejected') {
      continue;
    }
    accepted += 1;
    if (state === 'delivered') {
      delivered += 1;
    }
  }
  const total = items.length;
  const rejected = total - accepted;
  return {
    accepted,
    allDelivered: total > 0 && delivered === total,
    delivered,
    notDelivered: accepted - delivered,
    partial: total > 0 && delivered < total,
    rejected,
    total,
  };
}

/**
 * 后端计数与逐条结果是否一致（total = accepted + rejected 且各计数等于按条目统计值）。
 * 不一致时页面**展示条目口径**并把差异标出来，而不是照抄一个对不上的数字。
 */
export function batchCountsConsistent(
  resp: IotCommandApi.CommandBatchResp,
  summary: BatchResultSummary,
): boolean {
  return (
    toCount(resp.total) === summary.total &&
    toCount(resp.accepted) === summary.accepted &&
    toCount(resp.rejected) === summary.rejected &&
    toCount(resp.delivered) === summary.delivered
  );
}

/** 后端计数一律可能是 Long 字符串 ⇒ 显式转数（口径同 utils/backend-number，但不在这里引 UI 依赖）。 */
function toCount(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 未受理原因码 → i18n 键（**未知码返回空串**，由调用方原样展示 code，不猜文案）。 */
export function batchRejectReasonKey(code?: null | string): string {
  switch ((code ?? '').trim().toUpperCase()) {
    case 'BATCH_BUDGET_EXCEEDED': {
      return 'page.iot.device.batchCommand.reasonBudget';
    }
    case 'COMMAND_REJECTED': {
      return 'page.iot.device.batchCommand.reasonRejected';
    }
    case 'DEVICE_DISABLED': {
      return 'page.iot.device.batchCommand.reasonDisabled';
    }
    case 'DEVICE_NOT_FOUND': {
      return 'page.iot.device.batchCommand.reasonNotFound';
    }
    case 'DEVICE_WITHOUT_PRODUCT': {
      return 'page.iot.device.batchCommand.reasonWithoutProduct';
    }
    case 'INTERNAL_ERROR': {
      return 'page.iot.device.batchCommand.reasonInternal';
    }
    case 'THING_MODEL_EMPTY': {
      return 'page.iot.device.batchCommand.reasonThingModelEmpty';
    }
    case 'THING_MODEL_LOAD_FAILED': {
      return 'page.iot.device.batchCommand.reasonThingModelLoadFailed';
    }
    default: {
      return '';
    }
  }
}

/** 投递失败原因码 → i18n 键（未知码返回空串，原样展示 code）。 */
export function batchDeliveryReasonKey(code?: null | string): string {
  switch ((code ?? '').trim().toUpperCase()) {
    case 'DEVICE_OFFLINE': {
      return 'page.iot.device.batchCommand.deliveryDeviceOffline';
    }
    case 'DEVICE_REJECTED': {
      return 'page.iot.device.batchCommand.deliveryDeviceRejected';
    }
    case 'EMQX_ERROR': {
      return 'page.iot.device.batchCommand.deliveryEmqx';
    }
    case 'NO_SUBSCRIBER': {
      return 'page.iot.device.batchCommand.deliveryNoSubscriber';
    }
    case 'TIMEOUT': {
      return 'page.iot.device.batchCommand.deliveryTimeout';
    }
    default: {
      return '';
    }
  }
}

// ---------------------------------------------------------------- 设备与标识

/** 参与批量下发的设备（页面只需这几列；productId 用于「标识在不在该设备物模型里」的预判）。 */
export interface BatchTargetDevice {
  deviceCode?: string;
  deviceId: string;
  deviceName?: string;
  productId?: string;
}

/** 跨设备去重后的 id 清单（去空、去重、保序；后端也会去重，前端先把「将下发 N 台」说准）。 */
export function normalizeBatchDeviceIds(ids: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids ?? []) {
    const id = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim();
    if (id === '' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** 一个产品的物模型（属性 + 命令）；批量下发的目标标识取它们的并集。 */
export interface BatchProductModel {
  commands: IotThingModelApi.CommandResp[];
  productId: string;
  properties: IotThingModelApi.PropertyResp[];
}

/** 目标标识候选（带「哪些产品支持」信息，用于预判会被逐台拒绝的设备数）。 */
export interface BatchIdentifierOption {
  label: string;
  /** 支持该标识的产品 id（跨设备判「这台会不会被拒」用）。 */
  productIds: string[];
  value: string;
}

function accessModeOf(mode?: string): string {
  return (mode ?? '').trim().toUpperCase();
}

/**
 * 从物模型构造目标标识候选（**只列该动作真正合法的目标**）：
 * - property_set 只列可写属性（W/RW）；property_get 只列可读属性（R/RW）；
 * - service_call 只列命令定义；标识按跨服务去重（后端命令索引按 identifier 归并）。
 *
 * 为什么必须从物模型来而不是让用户手打：手打标识 = 把拼写错误留到下发时才由设备侧拒绝，
 * 几十台设备一起报 COMMAND_REJECTED 却没人知道是打错字。
 */
export function buildBatchIdentifierOptions(
  models: BatchProductModel[],
  kind: string,
): BatchIdentifierOption[] {
  const byValue = new Map<string, BatchIdentifierOption>();
  const add = (value: string, label: string, productId: string) => {
    if (value === '') {
      return;
    }
    const existing = byValue.get(value);
    if (existing) {
      if (!existing.productIds.includes(productId)) {
        existing.productIds.push(productId);
      }
      return;
    }
    byValue.set(value, { label, productIds: [productId], value });
  };
  for (const model of models) {
    if (kind === 'service_call') {
      for (const command of model.commands ?? []) {
        const identifier = (command.identifier ?? '').trim();
        if (identifier === '') {
          continue;
        }
        add(identifier, command.commandName || identifier, model.productId);
      }
      continue;
    }
    const wanted = kind === 'property_set' ? ['W', 'RW'] : ['R', 'RW'];
    for (const property of model.properties ?? []) {
      const identifier = (property.identifier ?? '').trim();
      if (
        identifier === '' ||
        !wanted.includes(accessModeOf(property.accessMode))
      ) {
        continue;
      }
      add(identifier, property.propertyName || identifier, model.productId);
    }
  }
  return [...byValue.values()].toSorted((left, right) =>
    left.value.localeCompare(right.value),
  );
}

/**
 * 该标识在选中设备里「物模型不支持」的设备数（**预判**，不是最终结论）。
 *
 * 用途：确认前人话复述里点明「有 X 台设备的物模型没有这个标识，会被逐台拒绝」——
 * 让用户在点下去之前就知道会有一部分设备失败，而不是下发后才发现。
 */
export function countUnsupportedDevices(
  option: BatchIdentifierOption | undefined,
  devices: BatchTargetDevice[],
): number {
  if (!option) {
    return devices.length;
  }
  let count = 0;
  for (const device of devices) {
    if (!device.productId || !option.productIds.includes(device.productId)) {
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------- 参数

/** 服务调用的一个入参定义（后端物模型 inputParams 的元素）。 */
export interface CommandParamDef {
  dataType: string;
  enumList: string[];
  identifier: string;
  name: string;
  required: boolean;
  unit?: string;
}

/**
 * 解析命令入参定义（命令响应里的 inputParams 字段，后端存的是 TSL paras 的 JSON 数组）。
 *
 * 解析失败/不是数组一律返回空数组（调用方回落到「JSON 文本」输入）——**不抛异常**：
 * 入参定义是产品的可选字段，写坏了不该让整个批量弹窗打不开。
 */
export function parseCommandParamDefs(raw?: null | string): CommandParamDef[] {
  const text = (raw ?? '').trim();
  if (text === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const defs: CommandParamDef[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const identifier = String(
      record.paraName ?? record.identifier ?? record.name ?? '',
    ).trim();
    if (identifier === '') {
      continue;
    }
    defs.push({
      dataType: String(record.dataType ?? 'string')
        .trim()
        .toLowerCase(),
      enumList: toStringList(record.enumList),
      identifier,
      name: String(record.paraName ?? record.name ?? identifier).trim(),
      required: record.required === true,
      unit:
        typeof record.unit === 'string' && record.unit !== ''
          ? record.unit
          : undefined,
    });
  }
  return defs;
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).filter((item) => item !== '');
  }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
    } catch {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
    }
  }
  return [];
}

/** 入参控件类型（组件据此选控件；**按物模型类型**而不是让人一律填 JSON）。 */
export type CommandParamControl = 'input' | 'number' | 'select' | 'switch';

export function paramControlOf(def: CommandParamDef): CommandParamControl {
  if (def.enumList.length > 0 || def.dataType === 'enum') {
    return 'select';
  }
  switch (def.dataType) {
    case 'bool': {
      return 'switch';
    }
    case 'decimal':
    case 'int':
    case 'long': {
      return 'number';
    }
    default: {
      return 'input';
    }
  }
}

export interface ParamCollectResult {
  /** 缺失的必填参数标识。 */
  missing: string[];
  ok: boolean;
  params: Record<string, unknown>;
  /** 非数值类型填了非数字的标识。 */
  wrongType: string[];
}

/**
 * 把「按入参定义填的控件值」收成服务调用 params 对象。
 *
 * 只收集**定义里出现过**的字段：避免把界面残留值悄悄发给设备。必填缺失与非数值类型
 * 都在这里拦下（前端先拦一道，后端仍会校验）。
 */
export function collectServiceParams(
  defs: CommandParamDef[],
  values: Record<string, unknown>,
): ParamCollectResult {
  const params: Record<string, unknown> = {};
  const missing: string[] = [];
  const wrongType: string[] = [];
  for (const def of defs) {
    const raw = values[def.identifier];
    const empty =
      raw === undefined ||
      raw === null ||
      (typeof raw === 'string' && raw.trim() === '');
    if (empty) {
      if (def.required) {
        missing.push(def.identifier);
      }
      continue;
    }
    const control = paramControlOf(def);
    if (control === 'number') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        wrongType.push(def.identifier);
        continue;
      }
      params[def.identifier] = parsed;
      continue;
    }
    if (control === 'switch') {
      params[def.identifier] = raw === true;
      continue;
    }
    params[def.identifier] = raw;
  }
  return {
    missing,
    ok: missing.length === 0 && wrongType.length === 0,
    params,
    wrongType,
  };
}

/**
 * 输入框文本 → 下发的 JSON 值（与在线调试同一口径）：优先 JSON 解析（数字/布尔/字符串字面量），
 * 解析失败按**字符串**下发（不静默丢弃用户输入）；空串按字符串空值。
 */
export function parseBatchValue(text: string): unknown {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') {
    return '';
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

/** 解析 params JSON 文本：**必须是 JSON 对象**（数组/标量/null 都拒绝）。 */
export function parseParamsObject(
  text: string,
): { ok: false } | { ok: true; value: Record<string, unknown> } {
  const raw = (text ?? '').trim() === '' ? '{}' : (text ?? '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

// ---------------------------------------------------------------- CSV

/** 结果表 / CSV 的一行（由三态 + 原始字段拼出，保证两者同源不漂移）。 */
export interface BatchResultRow {
  accepted: boolean;
  code: string;
  deviceCode: string;
  deviceId: string;
  deviceName: string;
  errorCode: string;
  message: string;
  requestId: string;
  state: BatchItemState;
  statusCode: string;
}

/** 把逐设备结果与设备台账信息拼成展示行（设备名/编码优先，缺失回落 id —— 不编造名字）。 */
export function buildBatchResultRows(
  items: IotCommandApi.CommandBatchItemResult[],
  labelOf: (deviceId: string) => { code?: string; name?: string },
): BatchResultRow[] {
  return items.map((item) => {
    const deviceId = String(item.deviceId ?? '');
    const label = labelOf(deviceId);
    return {
      accepted: item.accepted === true,
      code: item.code ?? '',
      deviceCode: label.code ?? '',
      deviceId,
      deviceName: label.name ?? '',
      errorCode: item.errorCode ?? '',
      message: item.message ?? '',
      requestId: item.requestId ?? '',
      state: resolveBatchItemState(item),
      statusCode: item.statusCode ?? '',
    };
  });
}

/** 结果 CSV 的数据行（表头由组件按 i18n 给；值与表格展示同源）。 */
export function buildBatchResultCsvRows(
  rows: BatchResultRow[],
  stateText: (state: BatchItemState) => string,
): string[][] {
  return rows.map((row) => [
    row.deviceName || row.deviceCode || row.deviceId,
    row.deviceCode,
    row.deviceId,
    stateText(row.state),
    row.statusCode,
    row.errorCode,
    row.code,
    row.message,
    row.requestId,
  ]);
}

/** 结果 CSV 文本（CRLF；不含 BOM，BOM 由下载处加）。 */
export function buildBatchResultCsv(
  header: string[],
  rows: string[][],
): string {
  return buildCsv(header, rows);
}
