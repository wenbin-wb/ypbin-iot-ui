/**
 * 列表筛选**持久化**的纯逻辑（看板 #12「筛选持久化」）。
 *
 * 设计（一次做到位）：
 *   ① **回填走表单初始化**：schema 的 defaultValue 取自持久化值 ⇒ 首次进入筛选即恢复，
 *      此后表单状态就是真实状态（用户改动/清空自然生效）；
 *   ② **保存走幂等写入**：查询启动时把筛选字段存 localStorage，值无变化不写（避免重复 IO）；
 *   ③ **不信任存储**：读回时逐字段类型校验，脏数据/旧 schema 一律回退默认（不炸、不脏）；
 *   ④ **版本化 key**：页面筛选结构演进时 bump version 即可整体失效（不会把旧字段值灌进新结构）。
 *
 * 字段类型 shape 驱动校验：string | boolean | stringArray（state 是多值逗号分隔，存 string）。
 */

/** 存储前缀（避免与其它应用 localStorage 冲突）。 */
export const FILTER_STORAGE_PREFIX = 'ypbin-iot.filter.';

/** 字段类型。 */
export type FilterFieldType = 'boolean' | 'string' | 'stringArray';

/** 字段 shape：字段名 → 期望类型。 */
export type FilterShape = Record<string, FilterFieldType>;

/**
 * 稳定存储 key（含版本：结构演进时 bump 即可整体失效）。
 */
export function filterStorageKey(page: string, version: number): string {
  return `${FILTER_STORAGE_PREFIX + page}.v${version}`;
}

/** 单字段校验：类型不符/缺失 ⇒ 用默认值（不信任存储）。 */
function sanitizeField(
  value: unknown,
  type: FilterFieldType,
  fallback: unknown,
): unknown {
  if (value === undefined || value === null) {
    return fallback;
  }
  switch (type) {
    case 'boolean': {
      return typeof value === 'boolean' ? value : fallback;
    }
    case 'string': {
      return typeof value === 'string' ? value : fallback;
    }
    case 'stringArray': {
      return Array.isArray(value) &&
        value.every((item) => typeof item === 'string')
        ? (value as string[])
        : fallback;
    }
    default: {
      return fallback;
    }
  }
}

/**
 * 读筛选并**净化**：非对象 JSON / 未知字段（shape 外）一律忽略；
 * 字段类型不符回退默认；返回完整字段集合（含默认项）。
 */
export function sanitizeFilter<T extends object>(
  raw: unknown,
  shape: FilterShape,
  defaults: T,
): T {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...defaults };
  }
  const record = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    const type = shape[key];
    out[key] = type
      ? sanitizeField(
          record[key],
          type,
          (defaults as Record<string, unknown>)[key],
        )
      : (defaults as Record<string, unknown>)[key];
  }
  return out as T;
}

/**
 * 从 localStorage 读取并净化筛选（JSON 非法/非对象 ⇒ 默认；读失败视为无存储）。
 */
export function loadFilter<T extends object>(
  page: string,
  version: number,
  shape: FilterShape,
  defaults: T,
): T {
  try {
    const text = window.localStorage.getItem(filterStorageKey(page, version));
    if (!text) {
      return { ...defaults };
    }
    return sanitizeFilter<T>(JSON.parse(text), shape, defaults);
  } catch {
    return { ...defaults };
  }
}

/**
 * 幂等保存：内容与上次一致则跳过（避免每次查询都写 localStorage）。
 *
 * @returns 是否真的写了
 */
export function saveFilterIfChanged<T extends object>(
  page: string,
  version: number,
  value: T,
  previous?: null | T,
): boolean {
  try {
    const next = JSON.stringify(value);
    if (previous !== null && previous !== undefined) {
      // 显式上一值优先（组件内避免每次读 localStorage）
      if (JSON.stringify(previous) === next) {
        return false;
      }
    } else {
      // 无显式上一值 ⇒ 读存储旧文本比较（幂等不依赖调用方维护状态）
      const old = window.localStorage.getItem(filterStorageKey(page, version));
      if (old === next) {
        return false;
      }
    }
    window.localStorage.setItem(filterStorageKey(page, version), next);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从查询对象挑出**筛选字段**（剔除分页 page/pageSize），用于持久化。
 */
export function pickFilterFields<T extends object>(query: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === 'page' || key === 'pageSize') {
      continue;
    }
    if (value === undefined || value === null || value === '') {
      continue;
    }
    out[key] = value;
  }
  return out as Partial<T>;
}

/**
 * 告警实例列表的筛选 shape（字段与 IotAlertApi.InstanceQuery 筛选项对齐）。
 */
export const ALERT_INSTANCE_FILTER_DEFAULTS = {
  deviceId: '',
  severity: '',
  state: '',
} as const;

export const ALERT_INSTANCE_FILTER_SHAPE: FilterShape = {
  deviceId: 'string',
  severity: 'string',
  state: 'string',
};

/**
 * 告警实例列表持久化参数（版本=1；结构演进时 bump）。
 */
export const ALERT_INSTANCE_FILTER_VERSION = 1;

/** 告警实例列表页名（存储 key 的一部分）。 */
export const ALERT_INSTANCE_FILTER_PAGE = 'alert-instances';
