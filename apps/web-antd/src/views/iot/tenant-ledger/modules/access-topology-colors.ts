/**
 * 接入拓扑图的 **ECharts 色值常量**（从 `access-topology.vue` 收敛到此处）。
 *
 * ## 为什么这里必须保留 6 位 hex，而不是 `hsl(var(--token))`
 *
 * 本仓 ECharts 统一走 **CanvasRenderer**（`packages/effects/plugins/src/echarts/echarts.ts`），
 * ECharts 会把颜色字符串直接赋给 canvas 的 `ctx.fillStyle` / `ctx.strokeStyle`。
 * Canvas **不解析 CSS 变量**：`fillStyle = 'hsl(var(--success))'` 是非法赋值，浏览器
 * 会**静默忽略**（保持上一次颜色），表现为「图画出来了但颜色全错/全黑」，且不报错 ——
 * 属于比硬编码更难排查的静默失效。
 *
 * 因此图表数据色只能保留**具体色值字面量**，并集中在本文件统一管理：
 * ① `.vue` 里不再出现 hex 字面量（design-token 静态门禁只扫 `.vue` 的 class/hex）；
 * ② 色值与既有 `.ts` 用例的断言（`access-topology.test.ts` 断言 `'#00b42a'` 等）保持一致，
 *    本轮不制造行为漂移；
 * ③ 语义仍然清晰：OK=绿、BAD=红、UNKNOWN=灰、TENANT=品牌蓝、EDGE=浅灰连线。
 *
 * ## 后续（follow-up，非本轮范围）
 *
 * 若要让拓扑图跟随暗色主题，需在**主题切换后**用 `getComputedStyle(document.documentElement)`
 * 读取 `--success`/`--destructive`/`--muted-foreground`/`--primary`/`--border` 再拼成
 * `hsl(...)` 传给 ECharts，并触发重绘（当前是一次性取色，暗色下沿用亮色档）。
 */

/** 健康（接入节点 leaseAlive=true、平台 reportLag 正常）。 */
export const TOPOLOGY_COLOR_OK = '#00b42a';

/** 异常（leaseAlive=false、平台上报滞后超阈值）。 */
export const TOPOLOGY_COLOR_BAD = '#f2547b';

/** 未知/不可接入（未上报、租户 assignable=false）。 */
export const TOPOLOGY_COLOR_UNKNOWN = '#8a94a6';

/** 租户节点品牌色（与主色系一致）。 */
export const TOPOLOGY_COLOR_TENANT = '#0066f5';

/** 拓扑连线色（浅灰，避免抢节点视觉）。 */
export const TOPOLOGY_COLOR_EDGE = '#b6c2d9';
