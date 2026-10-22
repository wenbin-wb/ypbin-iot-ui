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

// ---------------------------------------------------------------------------
// 视觉改造（Track A）：环境 / 灯光 / 后处理 / 动效相关色板
//
// 设计语言（对齐用户给的冷链大屏参考图，但**保持深色底**）：
//   - 建筑/地面/机柜 = **低饱和冷灰蓝**（不能是纯灰，纯灰在暗底上会显得「死」）；
//   - 状态点/告警 = **高饱和**（在线绿 / 告警红），用来和冷灰形成冷暖对比；
//   - 点缀 = **暖金琥珀自发光**（配 Bloom，画面才有「温度」与层次）。
//
// 为什么全部放这里：`.vue` 禁 6 位 hex（design-token 门禁），且这些是 canvas 里的
// 真实颜色（无法用 Tailwind 语义 token 表达）。集中在一处也便于整体调色。
// ---------------------------------------------------------------------------

/** 画布背景渐变：顶部（略亮，模拟「有天光的上方」）。 */
export const TWIN_COLOR_BACKGROUND_TOP = '#111a2b';

/** 画布背景渐变：底部（略暗，营造纵深，但仍留足对比度让地平线可见）。 */
export const TWIN_COLOR_BACKGROUND_BOTTOM = '#070b14';

/**
 * 半球光：天空色（冷灰蓝，略亮）。
 *
 * HemisphereLight 让「顶面亮、侧/底面暗」，这是参考图里最明显的质感来源。
 */
export const TWIN_COLOR_HEMI_SKY = '#8fa6c8';

/** 半球光：地面色（深冷灰，压住底部，避免死黑）。 */
export const TWIN_COLOR_HEMI_GROUND = '#16202e';

/** 主方向光（柔和冷白，负责投影）。 */
export const TWIN_COLOR_SUN = '#f2f6ff';

/** 补光（极弱的暖色，从背面补，勾出建筑轮廓，避免暗部一片冷灰）。 */
export const TWIN_COLOR_FILL = '#4a5c78';

/** 地面：冷灰混凝土。 */
export const TWIN_COLOR_GROUND = '#182130';

/** 地面网格线（工业风，低对比）。 */
export const TWIN_COLOR_GRID_LINE = '#2b3a50';

/** 网格次级线（更暗）。 */
export const TWIN_COLOR_GRID_LINE_MINOR = '#1e2a3a';

/** 扫描线纹理（斜向，画在地面上，透明度 <5%）。 */
export const TWIN_COLOR_SCAN_LINE = '#6f8fb8';

/** 暖金琥珀：机柜指示灯/点缀自发光（配合 Bloom，只让这一类发光）。 */
export const TWIN_COLOR_WARM_GLOW = '#ffb347';

/** 扫描光圈的冷青（工业设备感，与暖金形成对比，低透明度）。 */
export const TWIN_COLOR_SCAN_RING = '#38bdf8';

/** 锚点标签：胶囊底的描边（冷灰，high contrast 才不会被背景吃掉）。 */
export const TWIN_COLOR_LABEL_CAPSULE_BORDER = 'rgba(203,213,225,.55)';

/** 锚点标签：投影（柔和，制造「浮在模型上方」的层级感）。 */
export const TWIN_COLOR_LABEL_SHADOW = 'rgba(2,6,23,.55)';

/** 锚点标签：hover 时的高亮描边。 */
export const TWIN_COLOR_LABEL_CAPSULE_BORDER_HOVER = 'rgba(226,232,240,.95)';

/** 锚点标签：hover 光晕（白色低透明度外发光）。 */
export const TWIN_COLOR_LABEL_GLOW = 'rgba(226,232,240,.35)';

/** 锚点标签：被挤压降级为圆点时的底色（中性灰）。 */
export const TWIN_COLOR_DOT_NEUTRAL = '#cbd5e1';

/**
 * 告警扩散环的颜色（红）。
 *
 * 与 {@link TWIN_COLOR_ALERT} 同色相但独立常量：扩散环要参与 Bloom，
 * 且需要在浅/深背景上都醒目，后续可能单独调亮度而不影响锚点状态色。
 */
export const TWIN_COLOR_ALERT_RIPPLE = '#f87171';

/**
 * 由 CSS 颜色串判断是否为「浅色底」（用于深浅主题下切换画布配色）。
 *
 * ## 为什么需要这个判定
 *
 * 画布配色（背景渐变/地面/网格线）是为暗色主题调好的。亮色主题下若继续用同一套，
 * 会出现「深色画布嵌在亮色页面里」的割裂感（反差过大，像贴上去的一块黑玻璃）。
 * 而 `viewJson.background` 是**用户显式配置**的场景颜色，语义上应被视为浅色底
 * （用户选了浅色就按浅色主题处理地面/网格），因此两者用同一个判定。
 *
 * 支持 `#rgb`/`#rrggbb`/`rgb()`/`rgba()`；无法解析时按**深色**处理（安全默认：
 * 现有配色就是深色，解析不了时保持原样，不会把画布刷成一片白）。
 *
 * @param color CSS 颜色串
 * @returns 是否浅色底
 */
export function isLightBackground(color: null | string | undefined): boolean {
  if (!color) {
    return false;
  }
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color.trim());
  if (hex) {
    const raw = hex[1] ?? '';
    const full =
      raw.length === 3 ? [...raw].map((char) => char + char).join('') : raw;
    const value = Number.parseInt(full, 16);
    if (!Number.isFinite(value)) {
      return false;
    }
    // 用「除以通道基数取余」代替位掩码：本仓 formatter（oxfmt）会把十六进制字面量降小写、
    // linter（oxlint）又要求大写，两者对同一行互相改写 ⇒ 门禁永远红。完全避开十六进制字面量。
    const CHANNEL_BASE = 256;
    const RRGB_SHIFT = CHANNEL_BASE * CHANNEL_BASE;
    const r = Math.floor(value / RRGB_SHIFT) % CHANNEL_BASE;
    const g = Math.floor(value / CHANNEL_BASE) % CHANNEL_BASE;
    const b = value % CHANNEL_BASE;
    // 感知亮度（Rec. 601）：0.5 附近是深浅分界，浅灰白都 > 0.7
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.72;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = (rgb[1] ?? '').split(',').map((part) => Number(part.trim()));
    const [r = 0, g = 0, b = 0] = parts;
    if (![r, g, b].every((n) => Number.isFinite(n))) {
      return false;
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.72;
  }
  return false;
}

/** 浅色底时画布背景渐变：顶部（冷白灰，接近页面背景）。 */
export const TWIN_COLOR_BACKGROUND_TOP_LIGHT = '#eef2f7';

/** 浅色底时画布背景渐变：底部（略深，营造纵深但仍是浅色）。 */
export const TWIN_COLOR_BACKGROUND_BOTTOM_LIGHT = '#d3dae4';

/** 浅色底时地面主色（冷白灰：与浅色页面同层次，避免深色地面像贴纸）。 */
export const TWIN_COLOR_GROUND_LIGHT = '#d7dce4';

/** 浅色底时网格主色（比深色底用更深的线，保证对比度）。 */
export const TWIN_COLOR_GRID_LINE_LIGHT = '#9aa6b6';

/**
 * 浅色底（亮色主题）下的**标签胶囊配色**。
 *
 * 暗色主题的胶囊是「深底 + 浅字」，放到浅色画布上会变成一排深色药丸，视觉上比模型还重。
 * 浅色底改用「白底 + 深字 + 细边框」，并保留状态色（圆点/边框仍按在线/告警着色），
 * 这样「设备状态」仍然是第一视觉信息，胶囊只是承载文字。
 */
export const TWIN_COLOR_LABEL_BG_LIGHT = 'rgba(255,255,255,.92)';
export const TWIN_COLOR_LABEL_TEXT_LIGHT = '#1f2937';
export const TWIN_COLOR_LABEL_TEXT_MUTED_LIGHT = '#6b7280';
export const TWIN_COLOR_LABEL_BORDER_LIGHT = 'rgba(100,116,139,.45)';
export const TWIN_COLOR_LABEL_SHADOW_LIGHT = 'rgba(15,23,42,.18)';
/** 浅色底下圆点的描边色（深色描边才与白底分离；暗色底下是白描边）。 */
export const TWIN_COLOR_DOT_RING_LIGHT = 'rgba(255,255,255,.96)';
