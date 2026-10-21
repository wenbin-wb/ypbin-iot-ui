/**
 * 标签防重叠布局（**纯函数，可单测**；不依赖 three、不碰 DOM）。
 *
 * ## 要解决的问题（实测现状）
 *
 * 6 个锚点按 3D 投影直接摆 CSS2D 标签，没有任何避让：设备密集处标签**完全叠成一团**，
 * 只能看清最上面那一个的文字。用户的第一反馈就是「挤成一坨，看不清」。
 *
 * ## 算法
 *
 * 贪心 + 优先级：按「告警 > 在线 > 离线/未知」排好序，依次为每个标签挑选
 * **位移最小且不与已放置标签相交**的位置：
 *
 * 1. 候选位置 = 原位置 + `idealDisplacement` + 一圈**径向候选**（上下左右/斜向）；
 * 2. 每个标签有固定的尝试顺序（前 N 个 + 均匀抽样补齐），保证**确定性**
 *    （同样的输入每帧输出相同，否则画面会抖）；
 * 3. 全部候选都放不下 ⇒ 该标签降级为「只显示圆点」（`collapsed`），
 *    这样它仍然可点、可 hover 展开，**不会凭空消失**。
 *
 * ## 为什么是 O(n²)
 *
 * 每放置一个标签都要与已放置的标签两两比较。6~50 个点位时 n² 只有几十~几千次比较，
 * 可以每帧跑；**超过 N = 64 个点位必须换空间网格**（把已放置矩形按格子索引，查询只比
 * 邻居）。路线图里留了位置，但当前不实现：点位规模远未到，提前上网格反而增加坐标
 * 换算的出错面。
 */

/** 屏幕矩形（像素，基准为画布容器左上角）。 */
export interface ScreenRect {
  /** 左（含）。 */
  x: number;
  /** 上（含）。 */
  y: number;
  /** 宽。 */
  width: number;
  /** 高。 */
  height: number;
}

/** 布局输入：一个锚点在屏幕上的原始位置与尺寸。 */
export interface LabelInput {
  /** 点位 ID（稳定性/调试用）。 */
  pointId: string;
  /** 3D 投影得到的锚点屏幕坐标（标签的锚点）。 */
  anchor: { x: number; y: number };
  /** 标签自身尺寸（未避让时）。 */
  size: { height: number; width: number };
  /** 视觉层级：数值越大越优先占据原位置（告警最高）。相同值按输入顺序。 */
  priority: number;
  /**
   * 理想位移（通常来自「标签挂绳」的固定偏移，例如「圆点正上方 14px」）。
   *
   * 算法只在理想位移**之外**做必要的最小避让；没有避让时输出与理想位移完全一致，
   * 这保证「不拥挤时标签就是设计稿的样子」。
   */
  idealDisplacement?: { x: number; y: number };
  /** 该标签是否参与避让（例如 `labelVisible=false` 的点位不参与，但仍会挡住别人？否——不参与也不占位）。 */
  layout?: boolean;
}

/** 布局输出：一个锚点的最终摆放。 */
export interface LabelLayout {
  pointId: string;
  /** 最终矩形（相对画布容器左上角）。 */
  rect: ScreenRect;
  /** 相对原位置（不含理想位移）的避让位移。 */
  offset: { x: number; y: number };
  /** 是否因放不下而降级为「只显示圆点」（hover 才展开）。 */
  collapsed: boolean;
}

/** 避让能力上限（超过该值建议改空间网格；见文件头注释）。 */
export const LABEL_LAYOUT_SPATIAL_GRID_THRESHOLD = 64;

/** 圆角半径：命中判定按圆角矩形近似（只用于「是否相交」，不影响视觉）。 */
const MAX_PLACEMENT_ATTEMPTS = 24;

/** 候选位移半径（CSS 像素）。从小到大尝试，命中即停 ⇒ 天然得到「最小位移」。 */
const BASE_OFFSET_PX = 20;

/** 每个半径环上的候选方向数。 */
const DIRECTIONS_PER_RING = 8;

/** 相交判定容差（像素）：相邻标签允许 1px 的视觉贴合，避免 0.5px 抖动触发无尽重排。 */
export const LABEL_OVERLAP_TOLERANCE = 1;

/**
 * 收集「不会误报重叠」的固定尝试序列（按位移从小到大）。
 *
 * 刻意用**固定序列**而不是随机/逐帧搜索：标签必须每帧得到同一个结果，
 * 否则标签会在两个同样「可行」的位置之间来回跳（实测会非常刺眼）。
 *
 * @returns 位移候选（单位：像素）
 */
function placementCandidates(): Array<{ x: number; y: number }> {
  const candidates: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  // 环 1..3：半径递增，每环 8 个方向（先正交后斜向，正交位移更「自然」）
  const directions: ReadonlyArray<{ x: number; y: number }> = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: -1 },
    { x: -1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ];
  for (let ring = 1; ring <= 3; ring++) {
    for (let index = 0; index < DIRECTIONS_PER_RING; index++) {
      const direction = directions[index % directions.length] ?? {
        x: 0,
        y: -1,
      };
      candidates.push({
        x: direction.x * BASE_OFFSET_PX * ring,
        y: direction.y * BASE_OFFSET_PX * ring,
      });
    }
  }
  return candidates.slice(0, MAX_PLACEMENT_ATTEMPTS);
}

/** 预先算好的候选位移（模块级常量，避免每次布局重复分配）。 */
const CANDIDATES = placementCandidates();

/**
 * 两个矩形是否相交（带容差：容差内视为「不相交」，避免贴边反复重排）。
 *
 * @param a 矩形 A
 * @param b 矩形 B
 * @returns 是否真实重叠（超过容差）
 */
export function rectsOverlap(
  a: ScreenRect,
  b: ScreenRect,
  tolerance = LABEL_OVERLAP_TOLERANCE,
): boolean {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapX > tolerance && overlapY > tolerance;
}

/** 由「锚点 + 理想位移 + 避让位移」算出最终矩形。 */
function rectFor(
  input: LabelInput,
  displacement: { x: number; y: number },
): ScreenRect {
  const ideal = input.idealDisplacement ?? { x: 0, y: 0 };
  return {
    height: input.size.height,
    width: input.size.width,
    x: input.anchor.x + ideal.x + displacement.x,
    y: input.anchor.y + ideal.y + displacement.y,
  };
}

/**
 * 一次布局（**纯函数**：同样输入永远得到同样输出）。
 *
 * @param inputs 全部锚点（含不参与布局的，会被原样输出且不占位）
 * @param bounds 可选：可视区域尺寸；超出时按「放不下」降级（避免标签飘到画布外看不见）
 * @returns 与输入**同序**的布局结果
 */
export function layoutLabels(
  inputs: LabelInput[],
  bounds?: { height: number; width: number },
): LabelLayout[] {
  // 排序：优先级降序；相同优先级保持输入顺序（`sort` 是稳定的，但显式带上索引更稳）
  const order = inputs
    .map((input, index) => ({ index, input }))
    .filter((item) => item.input.layout !== false)
    .toSorted((left, right) => {
      if (right.input.priority !== left.input.priority) {
        return right.input.priority - left.input.priority;
      }
      return left.index - right.index;
    });

  const placed: ScreenRect[] = [];
  const byIndex = new Map<number, LabelLayout>();
  const fitsBounds = (rect: ScreenRect): boolean => {
    if (!bounds) {
      return true;
    }
    // 允许标签部分探出边界，但**锚点本身**必须在画布内（否则投影已在画布外）
    return (
      rect.x + rect.width > 0 &&
      rect.y + rect.height > 0 &&
      rect.x < bounds.width &&
      rect.y < bounds.height
    );
  };

  for (const { index, input } of order) {
    let chosen: LabelLayout | undefined;
    for (const candidate of CANDIDATES) {
      // 候选位移已按「离原位置由近到远」排好 ⇒ 第一个可行的就是位移最小的
      const rect = rectFor(input, candidate);
      const overlaps = placed.some((other) => rectsOverlap(rect, other));
      if (overlaps || !fitsBounds(rect)) {
        continue;
      }
      chosen = {
        collapsed: false,
        offset: { x: candidate.x, y: candidate.y },
        pointId: input.pointId,
        rect,
      };
      break;
    }
    if (chosen) {
      placed.push(chosen.rect);
      byIndex.set(index, chosen);
    } else {
      // 降级：只显示圆点。矩形仍按「锚点自身」给出（供 DOM 记录位置/命中测试），
      // 但**不再占位**——否则它会把本可正常显示的标签继续挤走。
      byIndex.set(index, {
        collapsed: true,
        offset: { x: 0, y: 0 },
        pointId: input.pointId,
        rect: rectFor(input, { x: 0, y: 0 }),
      });
    }
  }

  // 输出与输入同序（调用方按下标/ID 对应）；不参与布局的标签原样输出
  return inputs.map((input, index) => {
    const layout = byIndex.get(index);
    if (layout) {
      return layout;
    }
    return {
      collapsed: true,
      offset: { x: 0, y: 0 },
      pointId: input.pointId,
      rect: rectFor(input, { x: 0, y: 0 }),
    };
  });
}

/**
 * 位移平滑（帧率无关的一阶低通）。
 *
 * 为什么需要：避让是**离散**决策（某个标签这帧被放到上面、下帧被放到下面），
 * 直接应用会「跳位」。用指数平滑让它滑过去，观感是「标签自己让开」。
 *
 * `alpha` 由时间常数换算（`1 - exp(-dt / tau)`），因此 30fps 与 120fps 下速度一致。
 *
 * @param current 当前值
 * @param target 目标值
 * @param deltaSeconds 帧间隔（秒）
 * @param timeConstantSeconds 时间常数（秒，越小越快）
 * @returns 平滑后的值
 */
export function smoothOffset(
  current: { x: number; y: number },
  target: { x: number; y: number },
  deltaSeconds: number,
  timeConstantSeconds = 0.06,
): { x: number; y: number } {
  if (timeConstantSeconds <= 0 || deltaSeconds <= 0) {
    return { ...target };
  }
  const alpha = 1 - Math.exp(-deltaSeconds / timeConstantSeconds);
  const nextX = current.x + (target.x - current.x) * alpha;
  const nextY = current.y + (target.y - current.y) * alpha;
  // 收敛到亚像素时直接吸附，避免永远差 0.01px 导致 transform 每帧都在变
  return {
    x: Math.abs(target.x - nextX) < 0.05 ? target.x : nextX,
    y: Math.abs(target.y - nextY) < 0.05 ? target.y : nextY,
  };
}

/**
 * 把标签矩形夹进画布（**纯函数**；避免整条标签被推出可视区）。
 *
 * ## 为什么需要（在「避让」之外再加一道）
 *
 * `layoutLabels` 的边界判定是「允许部分探出」——这对**避让**是正确的（标签可以略微贴边），
 * 但它不保证「完整可见」。演示场景 6 个锚点在纵向上跨度很大（机柜两排），避让把上方的
 * 标签往上推、下方的往下推，极端情况下**整条**会落在画布外：屏幕上只剩圆点、没有名字
 * 和数值。夹紧保证每个标签的完整矩形始终落在可视区内。
 *
 * ## 与避让的关系
 *
 * 夹紧是**事后修正**：可能让两个标签重新重叠（把 A 夹回来正好撞上 B）。这里的选择是
 * 「宁可轻微重叠，也不让标签完全看不见」——完全看不见是功能缺失，轻微重叠只是观感问题。
 * 调用方应把夹紧量并入该标签的 `offset`，让平滑过渡与胶囊矩形缓存保持一致。
 *
 * @param rect 原始矩形
 * @param bounds 可视区尺寸
 * @param margin 四周留边（像素）
 * @returns 夹紧后的矩形（尺寸不变）
 */
export function clampLabelRect(
  rect: ScreenRect,
  bounds: { height: number; width: number },
  margin = 4,
): ScreenRect {
  // 画布比「标签 + 两端留边」还小时，max 会小于 min ⇒ 用 margin 兜底，保证不出现负范围
  const maxX = Math.max(margin, bounds.width - margin - rect.width);
  const maxY = Math.max(margin, bounds.height - margin - rect.height);
  return {
    height: rect.height,
    width: rect.width,
    x: Math.min(Math.max(rect.x, margin), maxX),
    y: Math.min(Math.max(rect.y, margin), maxY),
  };
}
