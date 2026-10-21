/**
 * 数字孪生状态色（**调色板模块**：色值集中在此，`.vue` 只 import 常量）。
 *
 * ## 为什么放在**引擎层**（`three/twin/colors.ts`）而不是视图层
 *
 * 两个理由，缺一都会出问题：
 *
 * 1. **design-token 门禁**（`views/iot/shared/design-token.test.ts`）**禁止在 `.vue` 里
 *    硬编码 6 位 hex**（绕过主题 token、暗色不可用）。3D 锚点的状态色是画布渲染用的
 *    真实颜色（three 的 `Color` 与 CSS2D 标签都吃它），无法用 Tailwind 语义 token
 *    表达（canvas 里没有 CSS 变量继承）⇒ 下沉到 `.ts` 调色板模块。
 * 2. **依赖方向**：本文件被 `three/twin/anchor-layer.ts`（引擎层）使用。
 *    若把它放在 `views/iot/twin/`，引擎层就要 `import '../../views/...'` ——
 *    形成 `views → anchor-layer → three` 的**静态**依赖环，会把 740KB 的 three
 *    提前拉进首屏（`advancedChunks` 只决定切到哪个文件，不决定何时加载）。
 *    放在引擎层后，方向变成 `views → three/twin/colors`（单向），three 才能真正按需加载。
 *    详见工单 #125。
 *
 * ## 为什么不用主题 token
 *
 * 这些颜色表达的是「设备在线状态」这一**业务语义**，与明暗主题无关：
 * 在线绿 / 离线灰 / 未知黄 / 停用深灰 / 告警红 —— 换主题时它们不该变
 * （否则暗色下「在线」变成浅绿会与背景对比不足）。图例（`runtime-legend.vue`）
 * 与 3D 锚点层（`three/twin/anchor-layer.ts`）**共用本模块**，保证两处颜色永不漂移。
 */

/** 在线（绿）。 */
export const TWIN_COLOR_ONLINE = '#22c55e';

/** 离线（灰）。 */
export const TWIN_COLOR_OFFLINE = '#94a3b8';

/** 未知（黄）：平台还没拿到过该设备的连接事件，**不代表离线**。 */
export const TWIN_COLOR_UNKNOWN = '#f59e0b';

/** 停用（深灰）：运维意图上的停用，比离线更深以区分。 */
export const TWIN_COLOR_DISABLED = '#475569';

/** 告警（红）。 */
export const TWIN_COLOR_ALERT = '#ef4444';

/** 告警闪烁的浅色相位（红 300 档）。 */
export const TWIN_COLOR_ALERT_DIM = '#fca5a5';

/** 锚点标签文字（高对比浅色）。 */
export const TWIN_COLOR_LABEL_TEXT = '#e2e8f0';

/** 锚点标签文字（弱化：无数据时用，明确「没有数据」而不是 0）。 */
export const TWIN_COLOR_LABEL_TEXT_MUTED = '#94a3b8';

/** 锚点标签边框（常态）。 */
export const TWIN_COLOR_LABEL_BORDER = 'rgba(148,163,184,.35)';

/** 锚点标签边框（有告警时）。 */
export const TWIN_COLOR_LABEL_BORDER_ALERT = 'rgba(239,68,68,.75)';

/** 锚点标签背景（半透明深色）。 */
export const TWIN_COLOR_LABEL_BG = 'rgba(11,18,32,.82)';

/** 图标贴图底色的白（由 Sprite 材质 color 相乘染色）。 */
export const TWIN_COLOR_ICON_BASE = '#ffffff';

/** 图标内圈深色。 */
export const TWIN_COLOR_ICON_INNER = 'rgba(11,18,32,0.85)';
