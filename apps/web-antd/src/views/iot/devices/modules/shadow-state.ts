import { $t } from '#/locales';

/**
 * 设备影子「期望值」编辑的**纯逻辑**（JSON 解析/校验/格式化/合并与差异对比），零 vue 依赖可单测。
 *
 * 为什么抽出：details 页把 desired 当「目标配置」，编辑入口让用户改 **JSON 文本**。
 * 但 JSON 文本与对象之间来回转换的边界（非法 JSON、非对象、空对象、深层值），
 * 以及 reported ↔ desired 的**值等价口径**，都是"做错了看不出"的部分 —— 抽成纯函数在 jsdom 外穷举。
 *
 * 影子差异的判等口径必须与后端 `ShadowValueComparator` 一致（见 {@link shadowValueEquals}）：
 * 前端显示「一致/不一致」而后端 delta 已空（或反之）会让两处结论打架。
 */

/** JSON 解析失败结论：只带 i18n key 与参数，文案由 {@link resolveDesiredParseMessage} 解析。 */
export interface DesiredParseFailed {
  ok: false;
  /** i18n 键（`page.iot.shadow.validation.*`）。 */
  messageKey: string;
  /** 插值参数（按 key 定义顺序传入）。 */
  params?: Array<number | string>;
}

/** JSON 解析成功结论（value 一定是对象）。 */
export interface DesiredParseSucceeded {
  ok: true;
  /** 解析出的对象（ok=true 时非空引用）。 */
  value: Record<string, unknown>;
}

/** JSON 解析结论。 */
export type DesiredParseResult = DesiredParseFailed | DesiredParseSucceeded;

/**
 * 把解析结论解析成面向用户的文案（成功返回空串）。
 *
 * 页面必须经此渲染错误，不得直接展示 `messageKey`（那会把 i18n 键暴露给用户）。
 *
 * @param result 解析结论
 * @returns 本地化错误文案；通过时为空串
 */
export function resolveDesiredParseMessage(result: DesiredParseResult): string {
  return result.ok ? '' : $t(result.messageKey, result.params ?? []);
}

/**
 * 解析期望值 JSON 文本。
 *
 * 🔴 必须是**对象**（后端 IotShadowReq.desired 是 Map）：数组/标量/null 都是非法输入，
 * 否则保存时后端会 4xx，且页面把错误延迟到提交后。
 *
 * @param text 用户输入的 JSON 文本
 * @returns 解析结论
 */
export function parseDesiredJson(text: string): DesiredParseResult {
  const raw = (text ?? '').trim();
  if (raw === '') {
    // 空文本按"清空 desired"处理：给 {} 而不是报错（清空是合法意图）
    return { ok: true, value: {} };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      messageKey: 'page.iot.shadow.validation.jsonInvalid',
      ok: false,
    };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      messageKey: 'page.iot.shadow.validation.objectRequired',
      ok: false,
    };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * 把 desired 对象格式化为可编辑的 JSON 文本（编辑前回显；空 desired 给 '{}'）。
 *
 * @param desired 当前期望值
 * @returns 格式化文本
 */
export function desiredToEditableText(
  desired?: null | Record<string, unknown>,
): string {
  if (!desired || Object.keys(desired).length === 0) {
    return '{}';
  }
  return JSON.stringify(desired, null, 2);
}

/**
 * 轻量展示：对象转「键=值」行（与详情页既有 shadowRows 同风格）。
 *
 * 值若为对象/数组则 JSON 化再显示（避免 [object Object]）。
 *
 * @param record 任意对象
 * @returns 行数组（键名升序，稳定展示）
 */
export function recordToRows(record?: null | Record<string, unknown>): Array<{
  key: string;
  value: string;
}> {
  if (!record) {
    return [];
  }
  return Object.keys(record)
    .toSorted()
    .map((key) => ({
      key,
      value: formatCell(record[key]),
    }));
}

/** 影子差异行的状态（四态；其中两类与后端 delta 的两种成因一一对应）。 */
export type ShadowDiffStatus =
  | 'extra-report'
  | 'match'
  | 'missing-report'
  | 'value-differs';

/** 影子差异行（reported / desired 逐键对比）。 */
export interface ShadowDiffRow {
  /** 属性键。 */
  key: string;
  /** reported 侧展示文本（reported 缺该键时为空串）。 */
  reportedText: string;
  /** desired 侧展示文本（desired 缺该键时为空串）。 */
  desiredText: string;
  /** 四态之一（见 {@link ShadowDiffStatus}）。 */
  status: ShadowDiffStatus;
}

/**
 * 逐键对比 reported 与 desired（键名升序，稳定输出）。
 *
 * 状态（与后端 delta 的两种成因对齐，再补上 delta 不表达的两种）：
 * - `missing-report`：desired 有、reported 缺该键（该键尚未上报）＝后端 delta 的「缺上报」；
 * - `value-differs`：两侧都有但值不等价＝后端 delta 的「值不一致」；
 * - `extra-report`：reported 有、desired 无该键（上报里多出来的键，后端 delta **不含**）；
 * - `match`：两侧都有且值等价（后端 delta **不含**）。
 *
 * 为什么前端自己算而不是直接用后端 delta：delta 只覆盖「desired 有、reported 不一致或缺失」的键，
 * 会把「一致」「仅上报」两类整个吞掉；可视化需要完整键集与稳定升序，故这里是同口径的**超集**。
 * 判等必须与后端同一口径（见 {@link shadowValueEquals}），否则同一台设备会出现
 * 「前端说不一致、后端 delta 已空」的矛盾结论。
 *
 * @param reported 设备上报值
 * @param desired 平台期望值
 * @returns 差异行（键名升序）
 */
export function shadowDiffRows(
  reported?: null | Record<string, unknown>,
  desired?: null | Record<string, unknown>,
): ShadowDiffRow[] {
  const left = reported ?? {};
  const right = desired ?? {};
  const keys = [
    ...new Set([...Object.keys(left), ...Object.keys(right)]),
  ].toSorted();
  return keys.map((key) => {
    const hasReported = Object.hasOwn(left, key);
    const hasDesired = Object.hasOwn(right, key);
    // 分支用「肯定条件」写：key 来自两侧并集，故两者都没有是不可能的，最后一个 else 只会落
    // 「只有 desired 有」这一种情况。
    let status: ShadowDiffStatus;
    if (hasReported && hasDesired) {
      status = shadowValueEquals(left[key], right[key])
        ? 'match'
        : 'value-differs';
    } else if (hasReported) {
      status = 'extra-report';
    } else {
      status = 'missing-report';
    }
    return {
      desiredText: hasDesired ? formatCell(right[key]) : '',
      key,
      reportedText: hasReported ? formatCell(left[key]) : '',
      status,
    };
  });
}

/**
 * 一键应用：把 desired 收敛到 reported（`desired ← reported`，剔除 reported 中没有的键）。
 *
 * **为什么是「以上报为准」而不是「以期望为准」**：上报是设备侧事实，期望是平台侧意图。界面上的
 * 「不一致」绝大多数是期望已下发、设备尚未对齐（或两侧口径不同）；若改成「以期望为准」把 desired
 * 扩写成两侧并集，会把「设备从没上报过的键」凭空写成平台期望，反而制造出更多待下发的目标。
 * 以上报收敛则让 desired 只保留平台**已确认收到**的键，且与后端
 * `PUT /devices/{id}/shadow` 的**整体替换**语义天然对齐（请求体就是最终 desired，不做增量合并），
 * 所以这里返回的就是可直接 PUT 的完整 desired；不再提供第二种半截语义。
 *
 * 注意这是**平台侧**动作：不改设备、不触发下发，只改平台记录的期望值。报告为空时结果就是空
 * desired（会清掉全部期望键）—— 有损，组件必须在二次确认里说清并由用户显式确认。
 *
 * `desired` 参数用于**无变化短路**：结果与当前 desired 同键且同口径等价时，原样返回入参对象
 * （引用相等），调用方可据此跳过无意义的 PUT。
 *
 * @param reported 设备上报值（收敛依据）
 * @param desired 当前期望值（仅用于无变化短路，不参与取值）
 * @returns 新的 desired；无变化时返回传入的 desired 本身
 */
export function buildDesiredFromReported(
  reported?: null | Record<string, unknown>,
  desired?: null | Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...reported };
  if (desired && sameShadowMap(next, desired)) {
    return desired;
  }
  return next;
}

/**
 * 影子值等价判定（与后端 `ShadowValueComparator.equal` 同一口径）。
 *
 * 口径来源：后端 `ypbin-service/.../shadow/ShadowValueComparator.java`（delta 的唯一判据）。
 * reported 的值是读数**原值字符串**（`"25.0"`），desired 来自命令参数（可能是 `25` 数值或
 * `true` 布尔），直接 `===` 会把「已对齐」判成不一致。归一化规则：
 * - null / undefined 视为同一哨兵（「值为 null」与「键不存在」由调用方按键存在性区分）；
 * - 布尔与 `"true"`/`"false"` 字符串（忽略大小写）归一；
 * - 数字与可解析为数字的字符串归一后按数值比较（`"25.0"` == `25`）；
 * - 对象/数组**区分类型**并递归归一后逐项比较（空对象 ≠ 空数组，与后端 Map/List 一致）；
 * - **刻意不 trim**（属性值里的前后空格可能有语义）；
 * - 十进制用定点运算而非 `Number()`：二进制浮点会让 `0.1+0.2` 这类值产生偏差，
 *   而后端用 BigDecimal 精确比较 —— 两侧必须同一口径。
 *
 * @param left 左值
 * @param right 右值
 * @returns 等价返回 true
 */
export function shadowValueEquals(left: unknown, right: unknown): boolean {
  return deepEquals(normalizeValue(left), normalizeValue(right));
}

/** null/undefined 的归一化哨兵。 */
const NULL_SENTINEL = Symbol('shadow-null');

/** 归一化后的值（数字/列表/映射带类型标记，布尔与字符串保持原样）。 */
type NormalizedValue =
  | boolean
  | string
  | typeof NULL_SENTINEL
  | { entries: Array<[string, NormalizedValue]>; type: 'map' }
  | { items: NormalizedValue[]; type: 'list' }
  | { type: 'number'; value: string };

/** 归一化（规则见 {@link shadowValueEquals}）。 */
function normalizeValue(value: unknown): NormalizedValue {
  if (value === null || value === undefined) {
    return NULL_SENTINEL;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      // 非有限数退回字符串口径（与后端 BigDecimal 解析失败时退回原串一致）
      return String(value);
    }
    return { type: 'number', value: decimalOf(String(value)) ?? String(value) };
  }
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') {
      return true;
    }
    if (lower === 'false') {
      return false;
    }
    const decimal = decimalOf(value);
    return decimal === null ? value : { type: 'number', value: decimal };
  }
  if (Array.isArray(value)) {
    return { items: value.map((item) => normalizeValue(item)), type: 'list' };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(
        ([key, item]) =>
          [key, normalizeValue(item)] as [string, NormalizedValue],
      )
      .toSorted(([a], [b]) => {
        if (a === b) {
          return 0;
        }
        return a < b ? -1 : 1;
      });
    return { entries, type: 'map' };
  }
  // 兜底：未知类型退回字符串口径（读路径不因一个怪值整体失败）
  return String(value);
}

/** 归一化后的深比较。 */
function deepEquals(left: NormalizedValue, right: NormalizedValue): boolean {
  if (left === NULL_SENTINEL || right === NULL_SENTINEL) {
    return left === right;
  }
  if (isNormalizedNumber(left) && isNormalizedNumber(right)) {
    return left.value === right.value;
  }
  if (isNormalizedList(left) && isNormalizedList(right)) {
    if (left.items.length !== right.items.length) {
      return false;
    }
    // noUncheckedIndexedAccess：长度已相等，取不到只可能是实现缺陷，按不等处理（不静默放行）
    return left.items.every((item, index) => {
      const counterpart = right.items[index];
      return counterpart !== undefined && deepEquals(item, counterpart);
    });
  }
  if (isNormalizedMap(left) && isNormalizedMap(right)) {
    if (left.entries.length !== right.entries.length) {
      return false;
    }
    const rightMap = new Map(right.entries);
    return left.entries.every(([key, value]) => {
      const counterpart = rightMap.get(key);
      return counterpart !== undefined && deepEquals(value, counterpart);
    });
  }
  return left === right;
}

function isNormalizedNumber(
  value: NormalizedValue,
): value is { type: 'number'; value: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'number'
  );
}

function isNormalizedList(
  value: NormalizedValue,
): value is { items: NormalizedValue[]; type: 'list' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'list'
  );
}

function isNormalizedMap(
  value: NormalizedValue,
): value is { entries: Array<[string, NormalizedValue]>; type: 'map' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'map'
  );
}

/** 两个影子对象是否同键且同口径等价（供 {@link buildDesiredFromReported} 短路）。 */
function sameShadowMap(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) && shadowValueEquals(left[key], right[key]),
  );
}

/**
 * 十进制归一化：仅接受 `[+-]?(digits[.digits?] | .digits)(e[+-]digits)?`，
 * 返回去尾零后的规范十进制串（`"25.0"` → `"25"`）；不可解析返回 null。
 */
function decimalOf(raw: string): null | string {
  // 注意：**不 trim**（后端口径），带空格的串直接判为不可解析、走原串比较
  const match = /^[+-]?(\d+\.?\d*|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) {
    return null;
  }
  const mantissa = match[1] ?? '';
  const exponent = Number(match[2] ?? '0');
  const sign = raw.startsWith('-') ? '-' : '';
  const [intPart = '', fracPart = ''] = mantissa.split('.');
  // 小数点位置 = 整数部分长度 + 指数；先按原样拼数字，再去前导零并同步移动小数点
  let digits = `${intPart}${fracPart}`;
  let point = intPart.length + exponent;
  const leadingZeros = /^0*/.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(leadingZeros);
  point -= leadingZeros;
  if (digits === '') {
    return '0';
  }
  let integerPart: string;
  let fractionPart: string;
  if (point <= 0) {
    integerPart = '0';
    fractionPart = '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    integerPart = digits + '0'.repeat(point - digits.length);
    fractionPart = '';
  } else {
    integerPart = digits.slice(0, point);
    fractionPart = digits.slice(point);
  }
  fractionPart = fractionPart.replace(/0+$/, '');
  const canonical =
    fractionPart === '' ? integerPart : `${integerPart}.${fractionPart}`;
  return canonical === '0' ? '0' : `${sign}${canonical}`;
}

/** 单元格值格式化（标量字面化；对象/数组 JSON 化）。 */
function formatCell(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
