import type { IotTwinApi } from '#/api/iot';

/**
 * 悬浮/点击卡片的数据组装（**纯函数，可单测**）。
 *
 * ## 为什么单独一层
 *
 * 卡片的每一行都涉及「数据口径」，而口径错了比不显示更危险：
 *
 * 1. **无数据必须是 `--` 而不是 `0`**（本仓既有约定）：后端对「从未上报」的属性
 *    返回 `values[key] = { value: null, ts: null }`，若前端把它当 0 渲染，
 *    运维会看到一台「温度 0℃」的正常设备 —— 这是会导致误判的安全级错误。
 * 2. **`stale` 是运行态级别（值已失效），`quality` 是值级别**：两者可以并存，
 *    必须**分别**呈现，不能用一个「异常」色笼统盖住。
 * 3. **绑定的 `unitOverride` 优先于属性 `unit`**（用户在绑定编辑器里显式覆盖过）。
 * 4. **`displayRole=primary` 的行要能被识别**（卡片主展示属性高亮），
 *    且没有 primary 时取第一条绑定（与 `runtime-store` 的主展示属性口径**完全一致**，
 *    否则画布标签与卡片会显示两个不同的属性）。
 *
 * 本模块只做「结构化取值」，不做任何 i18n 与 DOM —— 文案由 `.vue` 用 `$t` 渲染。
 */

/** 卡片中一行的数据质量级别（决定颜色/图标，不决定文案）。 */
export type CardValueQuality = 'bad' | 'good' | 'missing' | 'stale' | 'unknown';

/** 卡片中的一行（= 一个属性绑定 + 它的最新值）。 */
export interface PropertyCardRow {
  /** 展示名（属性名，绑定里的 `propertyName`）。 */
  propertyName: string;
  /** 属性业务标识（用于排查，卡片上以小字展示）。 */
  propertyIdentifier: string;
  /** 已按小数位格式化并**不含单位**的数值文本；无数据时为 `undefined`。 */
  valueText?: string;
  /** 单位（`unitOverride` 优先，其次属性 `unit`；都没有为 undefined）。 */
  unit?: string;
  /** 质量级别。 */
  quality: CardValueQuality;
  /** 是否为该点位的主展示属性（横向对齐画布标签里显示的那个属性）。 */
  primary: boolean;
  /** 绑定是否已失效（属性在物模型里已被删除）。 */
  bindingStale: boolean;
  /** 值是否被后端标记为 stale（数据已失效）。 */
  valueStale: boolean;
  /** 值的原始质量码（原样透出，便于排查）。 */
  qualityCode?: string;
  /** 最近更新时间（epoch 毫秒）；无 ts 时为 undefined。 */
  updatedAt?: number;
}

/** 卡片整体状态（用于给卡片一个总色条/徽标）。 */
export type PropertyCardStatus =
  | 'alert'
  | 'disabled'
  | 'normal'
  | 'offline'
  | 'unknown';

/** 悬浮卡片的数据。 */
export interface PropertyCardModel {
  pointId: string;
  /** 设备名（回落到设备 ID，绝不显示空白）。 */
  deviceName: string;
  deviceId: string;
  /** 点位备注（可为空）。 */
  remark?: string;
  /** 模型节点名（配置期用于对照，可为空）。 */
  nodeName?: string;
  /** 活动告警数。 */
  alertCount: number;
  /** 设备在线状态（online/offline/unknown/空）。 */
  onlineStatus?: null | string;
  /** 启停位（1 启用 / 0 停用）。 */
  status?: null | number;
  /** 卡片总状态。 */
  cardStatus: PropertyCardStatus;
  /** 属性行（主展示属性排第一，其余按绑定顺序）。 */
  rows: PropertyCardRow[];
  /** 是否有任何一行拿到了真实数值（全无 ⇒ 卡片顶部提示「暂无上报」）。 */
  hasAnyValue: boolean;
}

/** 组装输入：绑定（配置态）与运行态值（实时）。 */
export interface BuildPropertyCardInput {
  /** 点位响应（提供绑定、设备名、备注）。 */
  point: IotTwinApi.PointResp;
  /** 运行态值（键 = 属性标识）；无数据时为空对象或 undefined。 */
  values: Record<string, IotTwinApi.RuntimeValueResp> | undefined;
  /** 运行态点位（提供在线状态/告警数）；未到达时为 undefined。 */
  runtime:
    | Pick<
        IotTwinApi.RuntimePointResp,
        'alertCount' | 'onlineStatus' | 'status'
      >
    | undefined;
}

/**
 * 判定数值文本。
 *
 * @param raw 原始值（后端是字符串；可能是 null/空串/非数字）
 * @param decimals 小数位
 * @returns 展示文本；无数据返回 undefined（**不返回 '0'**）
 */
export function formatCardValue(
  raw: null | string | undefined,
  decimals: null | number | undefined,
): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (decimals === null || decimals === undefined) {
    return trimmed;
  }
  const numeric = Number(trimmed);
  // 非数字（枚举/布尔/字符串属性）不套小数位——强行 toFixed 会得到 "NaN"
  if (!Number.isFinite(numeric)) {
    return trimmed;
  }
  return numeric.toFixed(decimals);
}

/**
 * 质量码 → 卡片级别。
 *
 * 口径与 `runtime-store.ts` 的 `isGoodQuality` **一致**（不以 bad/uncertain 开头即正常），
 * 避免出现「画布说正常、卡片说异常」的分裂。
 *
 * @param code 后端质量码
 * @returns 级别
 */
export function classifyQuality(
  code: null | string | undefined,
): Exclude<CardValueQuality, 'missing' | 'stale'> {
  if (code === null || code === undefined || code.trim() === '') {
    return 'unknown';
  }
  const normalized = code.trim().toLowerCase();
  if (normalized.startsWith('bad') || normalized.startsWith('uncertain')) {
    return 'bad';
  }
  return 'good';
}

/**
 * 卡片总状态（与 `anchor-layer.resolveColor` 的优先级一致：
 * 停用 > 告警 > 在线 > 离线 > 未知）。
 *
 * @param runtime 运行态点位
 * @returns 状态
 */
export function resolveCardStatus(
  runtime:
    | Pick<
        IotTwinApi.RuntimePointResp,
        'alertCount' | 'onlineStatus' | 'status'
      >
    | undefined,
): PropertyCardStatus {
  if (runtime === undefined) {
    return 'unknown';
  }
  if (runtime.status === 0) {
    return 'disabled';
  }
  if ((runtime.alertCount ?? 0) > 0) {
    return 'alert';
  }
  if (runtime.onlineStatus === 'online') {
    return 'normal';
  }
  if (runtime.onlineStatus === 'offline') {
    return 'offline';
  }
  return 'unknown';
}

/**
 * 组装卡片。
 *
 * @param input 输入
 * @returns 卡片模型
 */
export function buildPropertyCard(
  input: BuildPropertyCardInput,
): PropertyCardModel {
  const { point, runtime, values } = input;
  const bindings = [...point.bindings];
  // 主展示属性：`displayRole === 'primary'` 优先，否则第一条
  // （与 `runtime-store.replaceSnapshot` 完全同口径）
  const primary =
    bindings.find((binding) => binding.displayRole === 'primary') ??
    bindings[0];
  const primaryIdentifier = primary?.propertyIdentifier;

  const ordered = primary
    ? [primary, ...bindings.filter((binding) => binding !== primary)]
    : bindings;

  const rows: PropertyCardRow[] = ordered.map((binding) => {
    const runtimeValue = values?.[binding.propertyIdentifier];
    const valueText = formatCardValue(runtimeValue?.value, binding.decimals);
    const valueStale = runtimeValue?.stale === true;
    const qualityCode = runtimeValue?.quality ?? undefined;
    let quality: CardValueQuality;
    if (valueText === undefined) {
      quality = 'missing';
    } else if (valueStale) {
      quality = 'stale';
    } else {
      quality = classifyQuality(qualityCode);
    }
    const unit = binding.unitOverride ?? binding.unit ?? undefined;
    const ts = runtimeValue?.ts;
    const parsedTs =
      ts === null || ts === undefined || ts === '' ? undefined : Number(ts);
    const updatedAt =
      parsedTs !== undefined && Number.isFinite(parsedTs) && parsedTs > 0
        ? parsedTs
        : undefined;
    return {
      bindingStale: binding.stale,
      primary: binding.propertyIdentifier === primaryIdentifier,
      propertyIdentifier: binding.propertyIdentifier,
      propertyName: binding.propertyName,
      quality,
      qualityCode,
      unit: unit === '' ? undefined : unit,
      updatedAt,
      valueStale,
      valueText,
    };
  });

  const hasAnyValue = rows.some((row) => row.valueText !== undefined);
  return {
    alertCount: runtime?.alertCount ?? 0,
    cardStatus: resolveCardStatus(runtime),
    deviceId: point.deviceId,
    deviceName: point.deviceIdName?.trim()
      ? point.deviceIdName
      : point.deviceId,
    hasAnyValue,
    nodeName: point.nodeName ?? undefined,
    onlineStatus: runtime?.onlineStatus,
    pointId: point.id,
    remark: point.remark ?? undefined,
    rows,
    status: runtime?.status,
  };
}

/**
 * 格式化相对时间（「12 秒前」这类）——**返回结构化结果，不含文案**。
 *
 * 为什么不在这里拼中文：纯函数层不做 i18n（拿不到 `$t`），
 * 输出中文字符串会让英文界面中英混杂（工单 #131 的实测问题）。
 * 这里只给「单位 + 数量」，由 `.vue` 用 `$t('page.iot.twin.card.age.second', [n])` 渲染。
 *
 * @param ts epoch 毫秒
 * @param now 当前时刻（默认 Date.now()）
 * @returns 相对时间描述；ts 非法时为 undefined
 */
export function describeAge(
  ts: number | undefined,
  now: number = Date.now(),
): undefined | { count: number; unit: 'day' | 'hour' | 'minute' | 'second' } {
  if (ts === undefined || !Number.isFinite(ts) || ts <= 0) {
    return undefined;
  }
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) {
    return { count: seconds, unit: 'second' };
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return { count: minutes, unit: 'minute' };
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return { count: hours, unit: 'hour' };
  }
  return { count: Math.round(hours / 24), unit: 'day' };
}
