import { describe, expect, it } from 'vitest';

import {
  CARD_DEFAULT_GAP,
  CARD_DEFAULT_MARGIN,
  isAnchorVisible,
  placeCard,
} from './property-card-layout';

/**
 * 悬浮卡片定位（**纯函数**测试）。
 *
 * ## 为什么必须单测而不是「看起来对」
 *
 * 卡片的定位缺陷只在**贴边**时暴露：锚点在画布最右侧时卡片右半被裁掉，
 * 被裁掉的正好是**数值列**（用户看到的是属性名却看不到值，会以为数据没到）。
 * 而贴边场景在真实浏览器里很难稳定复现（要正好把相机转到那个角度），
 * 所以把几何算法抽成纯函数，在这里穷举四个边界 + 四角 + 极端尺寸。
 *
 * 钉住的不变量：
 * 1. 卡片**任何情况下都不越出画布**（`left >= margin`、`left + width <= canvas.width - margin`）；
 * 2. 优先在锚点**上方**，上方放不下才翻到下方；
 * 3. 贴左/右边缘时水平翻转，而不是简单夹紧（夹紧会让卡片盖住锚点）；
 * 4. 卡片比画布还大时（极端窄屏）仍然左/上对齐，不出现负坐标。
 */

/** 画布尺寸（典型：中栏画布约 900×760）。 */
const CANVAS = { height: 760, width: 900 };

/** 卡片尺寸（12 个属性的最大卡片）。 */
const CARD = { height: 260, width: 300 };

/** 断言「卡片完全在画布内」。 */
function expectInside(
  placement: { left: number; top: number },
  canvas = CANVAS,
  card = CARD,
): void {
  expect(placement.left).toBeGreaterThanOrEqual(CARD_DEFAULT_MARGIN);
  expect(placement.top).toBeGreaterThanOrEqual(CARD_DEFAULT_MARGIN);
  expect(placement.left + card.width).toBeLessThanOrEqual(
    canvas.width - CARD_DEFAULT_MARGIN,
  );
  expect(placement.top + card.height).toBeLessThanOrEqual(
    canvas.height - CARD_DEFAULT_MARGIN,
  );
}

describe('placeCard：跟随锚点且不越界', () => {
  it('画布中央：卡片在锚点上方、水平居中', () => {
    const placement = placeCard({
      anchor: { x: 450, y: 400 },
      canvas: CANVAS,
      card: CARD,
    });
    expect(placement.side).toBe('above');
    expect(placement.top).toBe(400 - CARD_DEFAULT_GAP - CARD.height);
    expect(placement.left).toBe(450 - CARD.width / 2);
    expect(placement.flippedHorizontally).toBe(false);
    expectInside(placement);
  });

  it('★ 贴近右边缘：水平翻转（卡片放到锚点左侧），而不是被夹到右边', () => {
    const placement = placeCard({
      anchor: { x: 880, y: 400 },
      canvas: CANVAS,
      card: CARD,
    });
    expect(placement.flippedHorizontally).toBe(true);
    expect(placement.left).toBe(880 - CARD.width);
    expectInside(placement);
  });

  it('★ 贴近左边缘：水平翻转（卡片放到锚点右侧）', () => {
    const placement = placeCard({
      anchor: { x: 10, y: 400 },
      canvas: CANVAS,
      card: CARD,
    });
    expect(placement.flippedHorizontally).toBe(true);
    expect(placement.left).toBe(10 + CARD_DEFAULT_GAP);
    expectInside(placement);
  });

  it('★ 贴近顶部：翻到锚点下方（不能把卡片顶出画布）', () => {
    const placement = placeCard({
      anchor: { x: 450, y: 40 },
      canvas: CANVAS,
      card: CARD,
    });
    expect(placement.side).toBe('below');
    expect(placement.top).toBe(40 + CARD_DEFAULT_GAP);
    expectInside(placement);
  });

  it('★ 贴近底部：仍在锚点上方（上方有空间就不翻）', () => {
    const placement = placeCard({
      anchor: { x: 450, y: 740 },
      canvas: CANVAS,
      card: CARD,
    });
    expect(placement.side).toBe('above');
    // 卡片底边在锚点上方，不与锚点重叠
    expect(placement.top + CARD.height).toBeLessThanOrEqual(740);
    expectInside(placement);
  });

  it('★ 四角 + 四边全覆盖：任何位置都不越界', () => {
    const points = [
      { x: 0, y: 0 },
      { x: CANVAS.width, y: 0 },
      { x: 0, y: CANVAS.height },
      { x: CANVAS.width, y: CANVAS.height },
      { x: 450, y: 0 },
      { x: 450, y: CANVAS.height },
      { x: 0, y: 380 },
      { x: CANVAS.width, y: 380 },
      { x: 150, y: 130 },
      { x: 750, y: 130 },
      { x: 150, y: 630 },
      { x: 750, y: 630 },
    ];
    for (const anchor of points) {
      const placement = placeCard({ anchor, canvas: CANVAS, card: CARD });
      // 直接断言（helper 内的断言 vitest 识别不到，会导致「无断言」误报）
      expect(placement.left).toBeGreaterThanOrEqual(CARD_DEFAULT_MARGIN);
      expect(placement.top).toBeGreaterThanOrEqual(CARD_DEFAULT_MARGIN);
      expectInside(placement);
    }
    expect(points).toHaveLength(12);
  });

  it('★ 卡片比画布还大（极端窄屏）：夹紧到左上，不出现负坐标', () => {
    const tiny = { height: 200, width: 260 };
    const placement = placeCard({
      anchor: { x: 130, y: 100 },
      canvas: tiny,
      card: CARD,
    });
    // 此时「完全放得下」在数学上不可能：兜底口径是「左上角对齐到留白处」，
    // 保证标题与第一行属性名可见（数值列允许溢出，页面会横向滚动）
    expect(placement.clamped).toBe(true);
    expect(placement.left).toBe(CARD_DEFAULT_MARGIN);
    expect(placement.top).toBe(CARD_DEFAULT_MARGIN);
    // 反向确认：放宽到「卡片放得下」的画布时，同一逻辑必须有留白（不夹紧）
    const fits = placeCard({
      anchor: { x: 450, y: 300 },
      canvas: CANVAS,
      card: CARD,
    });
    expect(fits.clamped).toBe(false);
  });

  it('自定义 gap/margin 生效', () => {
    const placement = placeCard({
      anchor: { x: 450, y: 400 },
      canvas: CANVAS,
      card: CARD,
      gap: 24,
      margin: 20,
    });
    expect(placement.top).toBe(400 - 24 - CARD.height);
    expect(placement.left).toBe(450 - CARD.width / 2);
  });

  it('★ 反向验证用：挪开后卡片与锚点不重叠（卡片不遮挡被检视的锚点）', () => {
    const anchor = { x: 450, y: 400 };
    const placement = placeCard({ anchor, canvas: CANVAS, card: CARD });
    const cardBottom = placement.top + CARD.height;
    const cardRight = placement.left + CARD.width;
    // 锚点要么在卡片上方（below 模式），要么在卡片下方（above 模式）
    const overlaps =
      anchor.x >= placement.left &&
      anchor.x <= cardRight &&
      anchor.y >= placement.top &&
      anchor.y <= cardBottom;
    expect(overlaps).toBe(false);
  });
});

describe('isAnchorVisible', () => {
  it('画布内 ⇒ true；明显越界 ⇒ false', () => {
    expect(isAnchorVisible({ x: 100, y: 100 }, CANVAS)).toBe(true);
    expect(isAnchorVisible({ x: CANVAS.width + 100, y: 100 }, CANVAS)).toBe(false);
    expect(isAnchorVisible({ x: 100, y: -100 }, CANVAS)).toBe(false);
  });

  it('允许 slack 容差（图标本身有尺寸）', () => {
    expect(isAnchorVisible({ x: CANVAS.width + 10, y: 100 }, CANVAS)).toBe(true);
    expect(isAnchorVisible({ x: CANVAS.width + 10, y: 100 }, CANVAS, 0)).toBe(
      false,
    );
  });
});
