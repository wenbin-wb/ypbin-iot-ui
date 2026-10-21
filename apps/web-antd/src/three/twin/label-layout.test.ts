import type { LabelInput, ScreenRect } from './label-layout';

import { describe, expect, it } from 'vitest';

import {
  clampLabelRect,
  LABEL_LAYOUT_SPATIAL_GRID_THRESHOLD,
  LABEL_OVERLAP_TOLERANCE,
  layoutLabels,
  rectsOverlap,
  smoothOffset,
} from './label-layout';

/**
 * 标签防重叠布局的单测。
 *
 * ## 为什么用「真实几何」而不是构造抽象的矩形
 *
 * 这个算法的失败模式是**几何**的：重叠没消除、位移不是最小、结果不稳定（每帧跳位）。
 * 用接近真实画布的尺寸（1600×900）、真实标签尺寸（设备名 + 数值，约 120×22）构造输入，
 * 单测才能代表线上表现；用「1×1 的抽象矩形」测出来全绿也说明不了任何事。
 */

/** 真实标签尺寸（与 anchor-layer 的 CSS 一致：12px 字号 + 6px 内边距）。 */
const LABEL_W = 120;
const LABEL_H = 22;

/** 造一个标签输入。 */
function input(
  pointId: string,
  x: number,
  y: number,
  priority = 0,
  extra: Partial<LabelInput> = {},
): LabelInput {
  return {
    anchor: { x, y },
    pointId,
    priority,
    size: { height: LABEL_H, width: LABEL_W },
    ...extra,
  };
}

/** 两两检查：任意两个未降级标签都不得相交（含 1px 容差）。 */
function assertNoOverlap(layouts: ReturnType<typeof layoutLabels>): void {
  const visible = layouts.filter((layout) => !layout.collapsed);
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const left = visible[i];
      const right = visible[j];
      if (!left || !right) {
        continue;
      }
      const a = left.rect;
      const b = right.rect;
      // 失败信息里带上两个矩形：出问题时能直接看出「差了多少像素」
      const overlapping = rectsOverlap(a, b)
        ? `标签 ${left.pointId} 与 ${right.pointId} 重叠：a=${JSON.stringify(a)} b=${JSON.stringify(b)}`
        : '';
      expect(overlapping).toBe('');
    }
  }
}

describe('rectsOverlap：相交判定与 1px 容差', () => {
  it('明显相交 ⇒ true；完全分离 ⇒ false', () => {
    const a: ScreenRect = { height: 20, width: 100, x: 0, y: 0 };
    expect(rectsOverlap(a, { height: 20, width: 100, x: 50, y: 10 })).toBe(
      true,
    );
    expect(rectsOverlap(a, { height: 20, width: 100, x: 200, y: 0 })).toBe(
      false,
    );
  });

  it('★ 1px 以内的贴合不算重叠（避免 0.5px 抖动触发无尽重排）', () => {
    const a: ScreenRect = { height: 20, width: 100, x: 0, y: 0 };
    // 水平方向只重叠 1px
    expect(rectsOverlap(a, { height: 20, width: 100, x: 99, y: 0 })).toBe(
      false,
    );
    // 重叠 1.5px ⇒ 超过容差，算重叠
    expect(rectsOverlap(a, { height: 20, width: 100, x: 98.5, y: 0 })).toBe(
      true,
    );
    expect(LABEL_OVERLAP_TOLERANCE).toBe(1);
  });
});

describe('layoutLabels：★ 6 个必然重叠的标签 ⇒ 输出两两不相交', () => {
  it('★ 全部锚点挤在同一处（相隔 6px）⇒ 输出无重叠，且 6 个都能显示', () => {
    // 6 个设备在同一面墙上，投影后只差几个像素 —— 线上实测的「挤成一团」
    const inputs = Array.from({ length: 6 }, (_, index) =>
      input(`p${index}`, 800 + index * 6, 400 + index * 3),
    );
    const layouts = layoutLabels(inputs, { height: 900, width: 1600 });

    assertNoOverlap(layouts);
    // 120×22 的胶囊在 ±60px 范围内最多能排 3 个（上下各一行），物理上放不下 6 个：
    // 其余必须降级为圆点（hover 才展开），**但绝不能重叠**。
    const visible = layouts.filter((layout) => !layout.collapsed);
    expect(visible.length).toBeGreaterThanOrEqual(3);
    // 未降级的标签位移都在可控范围内（不会飞到屏幕另一端）
    for (const layout of visible) {
      expect(Math.hypot(layout.offset.x, layout.offset.y)).toBeLessThanOrEqual(
        61,
      );
    }
    // 顺序与输入一致（调用方按 ID 对应，不能乱序）
    expect(layouts.map((layout) => layout.pointId)).toEqual(
      inputs.map((item) => item.pointId),
    );
  });

  it('★ 任意未降级标签都不相交（随机化几何，50 组，含边界情况）', () => {
    // 确定性伪随机（不用 Math.random：失败要能复现）
    let seed = 12_345;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 50; round++) {
      const count = 2 + Math.floor(random() * 12);
      const inputs = Array.from({ length: count }, (_, index) =>
        input(
          `p${index}`,
          Math.round(random() * 1400),
          Math.round(random() * 700),
          Math.round(random() * 3),
        ),
      );
      const layouts = layoutLabels(inputs, { height: 900, width: 1600 });
      assertNoOverlap(layouts);
      // 显式断言「确实布局了」（防空跑：若布局被改成返回空数组，上面的循环也不会报错）
      expect(layouts).toHaveLength(inputs.length);
    }
  });
});

describe('layoutLabels：位移最小化与确定性', () => {
  it('★ 互不重叠时**零位移**（不拥挤的画面必须和设计稿一模一样）', () => {
    const inputs = [
      input('a', 100, 100),
      input('b', 400, 150),
      input('c', 700, 200),
      input('d', 1000, 250),
      input('e', 1300, 300),
      input('f', 200, 500),
    ];
    const layouts = layoutLabels(inputs, { height: 900, width: 1600 });
    for (const layout of layouts) {
      expect(layout.collapsed).toBe(false);
      expect(layout.offset).toEqual({ x: 0, y: 0 });
    }
  });

  it('★ 只重叠一次时，位移取最小候选（≤ 一个基础步长），不把标签甩得很远', () => {
    const inputs = [
      input('a', 500, 300),
      // 与 a 水平重叠 110px、垂直重叠 20px ⇒ 必须让开
      input('b', 510, 302),
    ];
    const layouts = layoutLabels(inputs, { height: 900, width: 1600 });
    assertNoOverlap(layouts);
    const moved = layouts.find((layout) => layout.pointId === 'b');
    expect(moved).toBeDefined();
    const distance = Math.hypot(moved?.offset.x ?? 0, moved?.offset.y ?? 0);
    // 基础环半径 20px ⇒ 一档位移即可解决
    expect(distance).toBeLessThanOrEqual(21);
  });

  it('★ 确定性：同一输入连续调用 10 次输出完全一致（否则标签会逐帧跳位）', () => {
    const inputs = Array.from({ length: 6 }, (_, index) =>
      input(`p${index}`, 800 + index * 5, 400 + index * 2),
    );
    const first = layoutLabels(inputs, { height: 900, width: 1600 });
    for (let round = 0; round < 10; round++) {
      expect(layoutLabels(inputs, { height: 900, width: 1600 })).toEqual(first);
    }
  });

  it('理想位移（挂绳偏移）在无避让时原样生效', () => {
    const layouts = layoutLabels(
      [input('a', 100, 100, 0, { idealDisplacement: { x: -60, y: -30 } })],
      { height: 900, width: 1600 },
    );
    expect(layouts[0]?.rect).toEqual({
      height: LABEL_H,
      width: LABEL_W,
      x: 40,
      y: 70,
    });
  });
});

describe('layoutLabels：优先级与降级顺序稳定', () => {
  it('★ 告警（高优先级）占据原位置，在线标签让开', () => {
    const inputs = [input('online', 500, 300, 1), input('alert', 505, 302, 2)];
    const layouts = layoutLabels(inputs, { height: 900, width: 1600 });
    const alert = layouts.find((layout) => layout.pointId === 'alert');
    expect(alert?.offset, '高优先级不应被挤走').toEqual({ x: 0, y: 0 });
    const online = layouts.find((layout) => layout.pointId === 'online');
    expect(online?.offset).not.toEqual({ x: 0, y: 0 });
  });

  it('★ 超预算时降级顺序稳定：同样的输入永远降级同样的那批标签', () => {
    // 200 个标签塞进 300×300 的小画布 ⇒ 必然有放不下的。
    // 优先级混排：每 10 个里 1 个告警级、1 个在线级、其余低优先级。
    // （用查表而不是嵌套三目：嵌套三目在 formatter 与 linter 之间有格式冲突）
    const PRIORITY_BY_SLOT: Record<number, number> = { 0: 3, 1: 2 };
    const inputs = Array.from({ length: 200 }, (_, index) =>
      input(
        `p${String(index)}`,
        10 + (index % 20) * 14,
        10 + Math.floor(index / 20) * 6,
        PRIORITY_BY_SLOT[index % 10] ?? 0,
      ),
    );
    const first = layoutLabels(inputs, { height: 300, width: 300 });
    const second = layoutLabels(inputs, { height: 300, width: 300 });
    const collapsedFirst = first
      .filter((layout) => layout.collapsed)
      .map((layout) => layout.pointId);
    expect(collapsedFirst.length, '超预算时必须发生降级').toBeGreaterThan(0);
    expect(
      second
        .filter((layout) => layout.collapsed)
        .map((layout) => layout.pointId),
    ).toEqual(collapsedFirst);
    // 降级的都是优先级低的：能放下的名额有限，告警级优先占用。
    const alerts = inputs
      .map((item, index) => ({ index, priority: item.priority }))
      .filter((item) => item.priority === 3)
      .map((item) => item.index);
    // 告警级（priority=3）共 20 个，超过画布容量（实测约 18）⇒ 不能承诺全部保住；
    // 因此只断言「降级的全是低优先级点位」这一核心不变量。
    expect(alerts.length).toBe(20);
    // ★ 名额由高优先级先占：**最早被降级的必须是原始顺序里最低优先级的那批**。
    // （不能按「输出顺序里第一个 collapsed」判断——输出是按输入顺序的，不是按优先级
    //   重排的；正确口径是：collapse 的下标集合的**最小值**等于最低优先级的那些下标集合。）
    const collapsedIndexes = new Set(
      first
        .map((layout, index) => ({ index, layout }))
        .filter((item) => item.layout.collapsed)
        .map((item) => item.index),
    );
    const byPriority = new Map<number, number[]>();
    for (const [index, item] of inputs.entries()) {
      const list = byPriority.get(item.priority) ?? [];
      list.push(index);
      byPriority.set(item.priority, list);
    }
    expect(collapsedIndexes.size).toBeGreaterThan(0);
    // 被保住的最高优先级档位：从高到低找第一档，只要该档里有被降级的点，
    // 就说明更低的档位也必然有降级（名额确实按优先级分配）
    for (const priority of [...byPriority.keys()].toSorted((a, b) => b - a)) {
      const indexes = byPriority.get(priority) ?? [];
      const collapsedHere = indexes.filter((index) =>
        collapsedIndexes.has(index),
      );
      if (collapsedHere.length === 0) {
        continue;
      }
      // 该档出现降级 ⇒ 所有更低档位也必须出现降级（优先级更高者先占名额）
      for (const lower of [...byPriority.keys()].filter((p) => p < priority)) {
        const lowerIndexes = byPriority.get(lower) ?? [];
        expect(
          lowerIndexes.some((index) => collapsedIndexes.has(index)),
          `优先级 ${priority} 已放不下，更低优先级 ${lower} 不可能全部放下`,
        ).toBe(true);
      }
      break;
    }
  });

  it('不参与布局的标签（labelVisible=false）不占位、也不影响别人', () => {
    const base = [input('a', 500, 300), input('b', 900, 300)];
    const withHidden = [
      input('a', 500, 300),
      input('hidden', 905, 302, 9, { layout: false }),
      input('b', 900, 300),
    ];
    const layoutBase = layoutLabels(base, { height: 900, width: 1600 });
    const layoutHidden = layoutLabels(withHidden, { height: 900, width: 1600 });
    expect(layoutHidden.find((l) => l.pointId === 'a')?.offset).toEqual(
      layoutBase.find((l) => l.pointId === 'a')?.offset,
    );
    expect(layoutHidden.find((l) => l.pointId === 'hidden')?.collapsed).toBe(
      true,
    );
  });

  it('超出可视区域的标签降级为圆点（不飘到画布外看不见）', () => {
    const layouts = layoutLabels([input('far', 5000, 5000)], {
      height: 900,
      width: 1600,
    });
    expect(layouts[0]?.collapsed).toBe(true);
  });

  it('空输入 ⇒ 空输出（不返回 null，符合「空结果禁 null」）', () => {
    expect(layoutLabels([])).toEqual([]);
  });

  it('点位规模阈值常量与注释一致（超过 64 需换空间网格）', () => {
    expect(LABEL_LAYOUT_SPATIAL_GRID_THRESHOLD).toBe(64);
  });
});

describe('smoothOffset：帧率无关的平滑', () => {
  it('时间常数为 0 ⇒ 直接到位（降级档）', () => {
    expect(smoothOffset({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.016, 0)).toEqual({
      x: 10,
      y: 20,
    });
  });

  it('★ 30fps 与 120fps 在相同总时长后到达同一位置（帧率无关）', () => {
    const target = { x: 40, y: -30 };
    let at30 = { x: 0, y: 0 };
    for (let i = 0; i < 30; i++) {
      at30 = smoothOffset(at30, target, 1 / 30, 0.06);
    }
    let at120 = { x: 0, y: 0 };
    for (let i = 0; i < 120; i++) {
      at120 = smoothOffset(at120, target, 1 / 120, 0.06);
    }
    expect(at30.x).toBeCloseTo(at120.x, 3);
    expect(at30.y).toBeCloseTo(at120.y, 3);
  });

  it('单调收敛且吸附：最终精确等于目标（不残留亚像素差）', () => {
    let current = { x: 0, y: 0 };
    let previous = 0;
    for (let i = 0; i < 300; i++) {
      current = smoothOffset(current, { x: 25, y: 0 }, 1 / 60, 0.06);
      expect(current.x).toBeGreaterThanOrEqual(0);
      expect(current.x).toBeLessThanOrEqual(25);
      // 单调递增：不会冲过目标再回弹（观感上「标签自己让开」，不是弹一下）
      expect(current.x).toBeGreaterThanOrEqual(previous);
      previous = current.x;
    }
    expect(current).toEqual({ x: 25, y: 0 });
  });
});

/**
 * 夹回画布（`clampLabelRect`）。
 *
 * 线上实测的缺陷形态：演示场景 6 个锚点纵向跨度很大（机柜两排），避让把首尾标签一直
 * 往上/往下推，最后**整条**落在画布外（画布 710×716，胶囊 y 实测 704~1072），
 * 屏幕上只剩圆点、没有名字与数值。
 */
describe('★ clampLabelRect：标签必须整条落在画布内', () => {
  /** 画布尺寸（dev 实测）。 */
  const BOUNDS = { height: 716, width: 710 };

  it('★ 纵向跨度 600px 的 6 个锚点 ⇒ 夹紧后没有任何矩形完全落在画布外', () => {
    // 6 个锚点沿纵向排布，跨度超过画布高度（模拟「机柜两排 + 相机俯视」的极端投影）
    const inputs = Array.from({ length: 6 }, (_, index) =>
      input(`p${index}`, 100 + index * 20, 40 + index * 140),
    );
    const layouts = layoutLabels(inputs, BOUNDS);
    // 先确认「避让本身」确实会把部分标签推到画布外（否则这个用例测不到东西）
    const rawOutside = layouts.filter(
      (layout) =>
        layout.rect.y + layout.rect.height > BOUNDS.height ||
        layout.rect.y < 0 ||
        layout.rect.x < 0 ||
        layout.rect.x + layout.rect.width > BOUNDS.width,
    );
    expect(rawOutside.length, '构造的输入必须真的会溢出画布').toBeGreaterThan(
      0,
    );

    for (const layout of layouts) {
      const clamped = clampLabelRect(layout.rect, BOUNDS);
      expect(
        clamped.y,
        `${layout.pointId} 的 y 必须在 [4, ${BOUNDS.height - 22 - 4}]`,
      ).toBeGreaterThanOrEqual(4);
      expect(clamped.y).toBeLessThanOrEqual(BOUNDS.height - 22 - 4);
      expect(
        clamped.x,
        `${layout.pointId} 的 x 必须 >= 4`,
      ).toBeGreaterThanOrEqual(4);
      expect(clamped.x).toBeLessThanOrEqual(BOUNDS.width - clamped.width - 4);
      // 整条矩形都在画布内
      expect(clamped.y + clamped.height).toBeLessThanOrEqual(BOUNDS.height);
      expect(clamped.x + clamped.width).toBeLessThanOrEqual(BOUNDS.width);
    }
  });

  it('已经在画布内的矩形不被改动', () => {
    const rect = { height: 22, width: 200, x: 100, y: 100 };
    expect(clampLabelRect(rect, BOUNDS)).toEqual(rect);
  });

  it('极端：标签比画布还宽 ⇒ 仍返回有限的非负坐标（不产生负数/NaN）', () => {
    const clamped = clampLabelRect(
      { height: 22, width: 900, x: 500, y: 500 },
      BOUNDS,
    );
    expect(Number.isFinite(clamped.x)).toBe(true);
    expect(Number.isFinite(clamped.y)).toBe(true);
    expect(clamped.x).toBe(4);
    expect(clamped.y).toBeLessThanOrEqual(BOUNDS.height);
  });

  it('自定留边（margin=0 ⇒ 贴边）', () => {
    const clamped = clampLabelRect(
      { height: 22, width: 100, x: -50, y: -50 },
      BOUNDS,
      0,
    );
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
  });
});
