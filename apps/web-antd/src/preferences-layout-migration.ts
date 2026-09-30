/**
 * 布局偏好一次性归一（K1：偏好「缓存优先」导致改默认值对老用户不生效）。
 *
 * <p>背景：偏好初始化时 `PreferenceManager#initPreferences` 用
 * `mergeWithArrayOverride({}, cachedPreferences, initialPreferences)` 合并，
 * **用户缓存的设置优先**、代码默认值只补齐缺失字段（见 `@vben-core/preferences`）。
 * 因此只在 `preferences.ts` 里把 `app.layout` 改成 `mixed-nav`，对**已经访问过本站**
 * 的用户不生效——localStorage 里的旧布局会盖掉新默认值。</p>
 *
 * <p>做法：按命名空间记录一个「布局归一版本号」。版本落后时**只删除缓存里下列
 * 代码驱动的字段**（不碰主题 / 语言，也不碰业务 store 的令牌）。
 * - `app.layout`：平台级导航要求 mixed-nav；
 * - `app.name`：应用已由基座名（Ypbin Admin）改为 Ypbin IoT 物联网平台，
 *   老缓存里的旧名会盖掉新默认值，清掉后由代码默认值补齐；
 * - `app.defaultHomePath`：首次登录落点由无组件的 `/dashboard`（白屏）改为
 *   `/dashboard/analytics`，老缓存里的旧值会把登录后去向改回白屏页；
 * - `app.defaultAvatar`：默认头像由基座 unpkg 外链图改为本地 IoT 头像；
 * - `header.menuAlign`：顶部大模块导航要求居中；
 * - `sidebar.autoActivateChild`：点顶部大模块时内容区要同步切换。</p>
 *
 * <p>为什么直接改缓存 blob 而不是用公开的 `updatePreferences`：后者的落盘是 150ms
 * debounce，页面在 debounce 触发前关闭会留下「版本号已写、布局没落盘」的永久不一致；
 * 同步改写 blob 没有这个窗口。缓存结构一旦与预期不符（不推进版本号并返回 false），
 * 由调用方用 `updatePreferences` 兜底。</p>
 *
 * @author wenbin
 * @since 2026-09-26
 */

/** 平台级导航要求的布局（vben 原生：顶部一级大模块 + 左侧二级菜单）。 */
export const REQUIRED_LAYOUT = 'mixed-nav';

/** 布局归一版本号；修改下述任一代码默认值时递增。 */
const LAYOUT_MIGRATION_VERSION = 4;

/** 需要从老缓存里清除的代码驱动字段：[偏好分区, 字段名] */
const STALE_PREFERENCE_FIELDS: Array<[string, string]> = [
  ['app', 'layout'],
  ['app', 'name'],
  ['app', 'defaultHomePath'],
  ['app', 'defaultAvatar'],
  ['header', 'menuAlign'],
  ['sidebar', 'autoActivateChild'],
];

/** 与 `@vben-core/preferences` 的 `STORAGE_KEYS.MAIN` 保持一致。 */
const PREFERENCES_STORAGE_KEY = 'preferences';

function migrationVersionKey(namespace: string): string {
  return `${namespace}-layout-migration-version`;
}

function cachedPreferencesKey(namespace: string): string {
  return `${namespace}-${PREFERENCES_STORAGE_KEY}`;
}

/**
 * 删除缓存偏好里的代码驱动字段（见 STALE_PREFERENCE_FIELDS，只删这些，
 * 用户自选的主题/语言/布局等不动）。
 *
 * @param namespace 偏好缓存命名空间
 * @returns 缓存侧是否已确保不含旧字段；`false` 表示缓存结构不符合预期，需上层兜底
 */
function clearCachedLayout(namespace: string): boolean {
  const raw = window.localStorage.getItem(cachedPreferencesKey(namespace));
  if (!raw) {
    return true;
  }
  const stored = JSON.parse(raw) as {
    value?: Record<string, Record<string, unknown> | undefined>;
  };
  const root = stored?.value;
  if (!root || typeof root !== 'object') {
    return false;
  }
  let dirty = false;
  for (const [section, key] of STALE_PREFERENCE_FIELDS) {
    const group = root[section];
    if (!group || typeof group !== 'object' || !(key in group)) {
      continue;
    }
    // 不用 `delete group[key]`：oxlint no-dynamic-delete 禁止动态键删除，
    // 这里用白名单重建对象达到同样效果
    const stale = new Set(
      STALE_PREFERENCE_FIELDS.filter(([s]) => s === section).map(([, k]) => k),
    );
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(group)) {
      if (stale.has(k)) {
        dirty = true;
      } else {
        kept[k] = v;
      }
    }
    root[section] = kept;
  }
  if (dirty) {
    window.localStorage.setItem(
      cachedPreferencesKey(namespace),
      JSON.stringify(stored),
    );
  }
  return true;
}

/**
 * 把老用户偏好缓存里的代码驱动字段一次性清掉，使代码默认值对其生效。
 *
 * @param namespace 偏好缓存命名空间（必须与 `initPreferences` 传入的一致）
 * @returns 是否已确保缓存侧不含旧布局；`false` 时调用方应用 `updatePreferences` 兜底
 */
export function normalizeCachedLayoutPreference(namespace: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    // `window.localStorage` **取值本身**在部分环境就会抛 SecurityError（沙箱 iframe、cookie 全禁、
    // 某些隐私设置），因此这个判断也必须放进 try 里——取值留在 try 之外会让异常直穿 main.ts 的
    // initApplication()，把应用启动整个带崩（白屏）。口径与 @vben-core/shared 的
    // StorageManager#createDefaultDriver 一致：拿不到存储就降级跳过，绝不阻断启动。
    if (!window.localStorage) {
      return false;
    }
    const appliedVersion = window.localStorage.getItem(
      migrationVersionKey(namespace),
    );
    if (
      appliedVersion !== null &&
      Number(appliedVersion) >= LAYOUT_MIGRATION_VERSION
    ) {
      return true;
    }
    if (!clearCachedLayout(namespace)) {
      return false;
    }
    window.localStorage.setItem(
      migrationVersionKey(namespace),
      String(LAYOUT_MIGRATION_VERSION),
    );
    return true;
  } catch (error) {
    // localStorage 被禁用或缓存损坏时跳过归一：偏好处理失败不应阻断应用启动
    console.warn('[preferences] 布局偏好归一失败，已跳过：', error);
    return false;
  }
}
