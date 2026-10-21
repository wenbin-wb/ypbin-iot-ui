/**
 * 悬浮卡片的定位（**纯函数，可单测**）。
 *
 * ## 三条必须做对的规则
 *
 * 1. **跟随 3D 锚点**：卡片锚定在锚点的屏幕投影位置上方（与图标之间留一点空隙），
 *    相机一动卡片就跟着动 —— 它是「这个锚点的属性」，不是页面级弹窗。
 * 2. **不超出画布边界**：贴近右/左边缘时翻转方向，上/下放不下时翻转上下，
 *    翻转后仍不够就夹紧到边界内。**绝不能**让卡片被裁掉一半（被裁掉的正好是数值列）。
 * 3. **不遮挡被检视的锚点**：卡片默认在锚点上方；上方空间不足时翻到下方。
 *
 * 这里只算几何，不碰 DOM：输入是「锚点屏幕坐标 + 画布/卡片尺寸」，输出是 `left/top`。
 * 这样可以在 Node 里穷举边界情况做单测（浏览器里很难稳定复现贴边场景）。
 */

/** 画布与卡片的几何输入（全部单位：CSS 像素）。 */
export interface CardPlacementInput {
  /** 画布（容器）尺寸。 */
  canvas: { height: number; width: number };
  /** 卡片尺寸（**渲染后实测**的尺寸；未知时传估算值）。 */
  card: { height: number; width: number };
  /** 锚点在画布内的屏幕坐标（相对画布左上角）。 */
  anchor: { x: number; y: number };
  /** 卡片与锚点之间的空隙。 */
  gap?: number;
  /** 卡片与画布边缘的最小留白。 */
  margin?: number;
}

/** 卡片放置结果。 */
export interface CardPlacement {
  /** 卡片相对画布左上角的 left。 */
  left: number;
  /** 卡片相对画布左上角的 top。 */
  top: number;
  /** 实际朝向（`above` = 卡片在锚点上方；`below` = 下方）。 */
  side: 'above' | 'below';
  /** 是否发生了水平翻转（卡片原本会超出左右边界）。 */
  flippedHorizontally: boolean;
  /** 是否被夹紧（空间不足时的兜底，宁可贴边也不要溢出）。 */
  clamped: boolean;
}

/** 默认空隙（像素）。 */
export const CARD_DEFAULT_GAP = 14;

/** 默认边缘留白（像素）。 */
export const CARD_DEFAULT_MARGIN = 8;

/**
 * 把数值夹到 `[min, max]`。
 *
 * @param value 值
 * @param min 下界
 * @param max 上界
 * @returns 夹紧后的值
 */
function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    // 卡片比可用空间还大：优先保证左上可见（读表格从第一行开始）
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * 计算卡片位置。
 *
 * 策略（顺序即优先级）：
 * 1. 垂直：优先放锚点**上方**（`top = anchor.y - gap - card.height`）；
 *    上方空间不足则放**下方**（`top = anchor.y + gap`）；
 * 2. 水平：以锚点为中心（`left = anchor.x - card.width / 2`）；
 *    左边越界则放到锚点右侧，右边越界则放到锚点左侧（即「翻转」）；
 * 3. 兜底：以上两步后仍越界（卡片比画布还大）⇒ 夹紧到 `[margin, size - margin]`。
 *
 * @param input 几何输入
 * @returns 放置结果
 */
export function placeCard(input: CardPlacementInput): CardPlacement {
  const gap = input.gap ?? CARD_DEFAULT_GAP;
  const margin = input.margin ?? CARD_DEFAULT_MARGIN;
  const { canvas, card, anchor } = input;

  // ---- 垂直 ----
  const aboveTop = anchor.y - gap - card.height;
  const belowTop = anchor.y + gap;
  let top: number;
  let side: 'above' | 'below';
  if (aboveTop >= margin) {
    top = aboveTop;
    side = 'above';
  } else if (belowTop + card.height <= canvas.height - margin) {
    top = belowTop;
    side = 'below';
  } else {
    // 上下都放不下（卡片太高 / 画布很矮）：选空间更大的一侧，再夹紧
    const spaceAbove = anchor.y;
    const spaceBelow = canvas.height - anchor.y;
    side = spaceAbove >= spaceBelow ? 'above' : 'below';
    top = side === 'above' ? aboveTop : belowTop;
  }
  const maxTop = canvas.height - margin - card.height;
  const clampedTop = clamp(top, margin, maxTop);
  const clamped = clampedTop !== top;
  top = clampedTop;

  // ---- 水平 ----
  const centeredLeft = anchor.x - card.width / 2;
  const rightAlignedLeft = anchor.x - card.width;
  const leftAlignedLeft = anchor.x + gap;
  let left = centeredLeft;
  let flippedHorizontally = false;
  if (centeredLeft < margin) {
    // 贴近左边缘：翻转成「卡片在锚点右侧」
    left = leftAlignedLeft;
    flippedHorizontally = true;
  } else if (centeredLeft + card.width > canvas.width - margin) {
    // 贴近右边缘：翻转成「卡片在锚点左侧」
    left = rightAlignedLeft;
    flippedHorizontally = true;
  }
  const maxLeft = canvas.width - margin - card.width;
  const clampedLeft = clamp(left, margin, maxLeft);
  const horizontalClamped = clampedLeft !== left;
  left = clampedLeft;

  return {
    clamped: clamped || horizontalClamped,
    flippedHorizontally,
    left,
    side,
    top,
  };
}

/**
 * 锚点屏幕坐标是否在画布内（用于隐藏已经飞出画面的卡片）。
 *
 * @param anchor 锚点屏幕坐标
 * @param canvas 画布尺寸
 * @param slack 允许的越界余量（像素；标签图标本身有尺寸）
 * @returns 是否可见
 */
export function isAnchorVisible(
  anchor: { x: number; y: number },
  canvas: { height: number; width: number },
  slack = 24,
): boolean {
  return (
    anchor.x >= -slack &&
    anchor.x <= canvas.width + slack &&
    anchor.y >= -slack &&
    anchor.y <= canvas.height + slack
  );
}
