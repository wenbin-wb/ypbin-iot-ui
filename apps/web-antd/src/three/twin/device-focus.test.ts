import { describe, expect, it } from 'vitest';

import {
  collectStandardMaterials,
  createDeviceFocus,
  DIM_OTHERS_AMOUNT,
  findNodesByPointName,
  normalizeNodeName,
  pickHighlightNodes,
} from './device-focus';

/**
 * 设备聚焦（选中/悬停高亮）。
 *
 * ## 为什么这些用例是「需求验收」而不是「实现细节测试」
 *
 * 用户的原话是「不要圆点，直接选中设备，要有高光」。这句话拆成三条可验证的不变量：
 * 1. **点位能对上模型节点**（否则「选中某个柜子」根本无从高亮）；
 * 2. **选中真的让那个柜子变亮**（否则就是「点了没反应」）；
 * 3. **取消选中/换场景真的恢复原样**（否则会残留「一直亮着」或「换个场景进来就是亮的」）。
 *
 * 替身约定：替身与 three 的真实类型不兼容（只实现本模块用到的字段），
 * 因此统一在**调用处**用 `as never` 断言。
 */

/** 替身颜色（three 的 `Color` 最小形状）。 */
interface FakeColor {
  b: number;
  g: number;
  r: number;
  clone: () => FakeColor;
  copy: (other: FakeColor) => FakeColor;
  multiplyScalar: (factor: number) => FakeColor;
  set: (value: string) => FakeColor;
}

/** 造一个替身颜色。 */
function createColor(red: number): FakeColor {
  const color: FakeColor = {
    b: red,
    clone: () => createColor(color.r),
    copy: (other) => {
      color.r = other.r;
      color.g = other.g;
      color.b = other.b;
      return color;
    },
    g: red,
    multiplyScalar: (factor) => {
      color.r *= factor;
      color.g *= factor;
      color.b *= factor;
      return color;
    },
    r: red,
    set: () => color,
  };
  return color;
}

/** 替身材质（只含本模块读写到的字段）。 */
interface FakeMaterial {
  color: FakeColor;
  dispose: () => void;
  emissive: FakeColor;
  emissiveIntensity: number;
  needsUpdate: boolean;
}

/** 造一个替身 Standard 材质。 */
function material(red = 0.5): FakeMaterial {
  return {
    color: createColor(red),
    dispose: () => undefined,
    emissive: createColor(0),
    emissiveIntensity: 0,
    needsUpdate: false,
  };
}

/** 替身节点（只含本模块用到的字段）。 */
interface FakeNode {
  children: FakeNode[];
  geometry: { boundingSphere: null | { center: FakeColor } };
  isMesh: boolean;
  material: FakeMaterial;
  name: string;
  scale: { clone: () => object; copy: () => void; multiplyScalar: () => void };
  traverse: (callback: (item: FakeNode) => void) => void;
  userData: Record<string, unknown>;
}

/** 造一个替身 mesh。 */
function mesh(name: string, mat: FakeMaterial = material()): FakeNode {
  const object: FakeNode = {
    children: [],
    geometry: { boundingSphere: null },
    isMesh: true,
    material: mat,
    name,
    scale: {
      clone: () => ({}),
      copy: () => undefined,
      multiplyScalar: () => undefined,
    },
    traverse: (callback) => {
      callback(object);
      for (const child of object.children) {
        child.traverse(callback);
      }
    },
    userData: {},
  };
  return object;
}

/** 造一个替身模型根（cabinet + conveyor 两个设备）。 */
function buildModel() {
  const cabinetMaterial = material(0.5);
  const conveyorMaterial = material(0.2);
  const cabinet = mesh('Cabinet_A', cabinetMaterial);
  const conveyor = mesh('Conveyor_01', conveyorMaterial);
  const root = mesh('Root', material(0.9));
  root.children.push(cabinet, conveyor);
  return { cabinet, cabinetMaterial, conveyor, conveyorMaterial, root };
}

describe('normalizeNodeName：宽松匹配口径', () => {
  it('★ 忽略大小写与分隔符（导出工具改写节点名很常见）', () => {
    expect(normalizeNodeName('cabinetA')).toBe(normalizeNodeName('Cabinet_A'));
    expect(normalizeNodeName('Cabinet-A')).toBe(normalizeNodeName('cabinet_a'));
    expect(normalizeNodeName(' Cabinet A ')).toBe(
      normalizeNodeName('cabinet_a'),
    );
  });

  it('空名/空串不抛错', () => {
    expect(normalizeNodeName('')).toBe('');
    expect(normalizeNodeName()).toBe('');
    expect(normalizeNodeName(null)).toBe('');
  });
});

describe('findNodesByPointName：点位 → 模型节点', () => {
  it('★ 精确名命中（主路径）', () => {
    const { root } = buildModel();
    const result = findNodesByPointName(root as never, 'Cabinet_A');
    expect(result.exact).toHaveLength(1);
    expect(result.exact[0]?.name).toBe('Cabinet_A');
  });

  it('★ 名字不一致（大小写/下划线）时走宽松匹配', () => {
    const { root } = buildModel();
    const result = findNodesByPointName(root as never, 'cabinetA');
    expect(result.exact).toHaveLength(0);
    expect(result.loose).toHaveLength(1);
    expect(pickHighlightNodes(result)[0]?.name).toBe('Cabinet_A');
  });

  it('点位未绑节点名 ⇒ 空结果（hasNodeForPoint 返回 false）', () => {
    const { root } = buildModel();
    expect(findNodesByPointName(root as never, null)).toEqual({
      exact: [],
      loose: [],
    });
    expect(findNodesByPointName(root as never, '  ')).toEqual({
      exact: [],
      loose: [],
    });
  });

  it('★ 锚点图标（isTwinAnchor）绝不参与高亮', () => {
    const { root } = buildModel();
    const anchor = mesh('Cabinet_A');
    anchor.userData.isTwinAnchor = true;
    root.children.push(anchor);
    const result = findNodesByPointName(root as never, 'Cabinet_A');
    expect(result.exact).toHaveLength(1);
    expect(result.exact[0]?.userData.isTwinAnchor).toBeUndefined();
  });

  it('精确名命中时优先于宽松匹配（不混用两套结果）', () => {
    const { root } = buildModel();
    root.children.push(mesh('cabinet_a'));
    const picked = pickHighlightNodes(
      findNodesByPointName(root as never, 'Cabinet_A'),
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]?.name).toBe('Cabinet_A');
  });
});

describe('★ createDeviceFocus：选中高亮 / 悬停弱高亮 / 取消恢复', () => {
  it('★ 选中 ⇒ 目标材质自发光加强，其余设备压暗', () => {
    const { cabinet, cabinetMaterial, conveyorMaterial, root } = buildModel();
    const focus = createDeviceFocus({} as never);

    focus.focus([cabinet as never], 'selected', [root as never]);

    expect(
      cabinetMaterial.emissiveIntensity,
      '★ 选中的设备必须真的变亮（否则「点了没反应」）',
    ).toBeGreaterThan(0);
    expect(focus.isActive()).toBe(true);
    expect(conveyorMaterial.color.r, '其余设备应被压暗').toBeLessThan(0.2);
    expect(DIM_OTHERS_AMOUNT).toBeGreaterThan(0);
  });

  it('★ 悬停 ⇒ 只提自发光，不压暗其余设备', () => {
    const { cabinet, cabinetMaterial, conveyorMaterial, root } = buildModel();
    const focus = createDeviceFocus({} as never);

    focus.focus([cabinet as never], 'hover', [root as never]);

    expect(cabinetMaterial.emissiveIntensity).toBeGreaterThan(0);
    expect(conveyorMaterial.color.r, '悬停不压暗').toBe(0.2);
  });

  it('★ 取消选中 ⇒ 材质完全恢复原样', () => {
    const { cabinet, cabinetMaterial, conveyorMaterial, root } = buildModel();
    const focus = createDeviceFocus({} as never);
    const originalEmissive = cabinetMaterial.emissiveIntensity;

    focus.focus([cabinet as never], 'selected', [root as never]);
    focus.clear();

    expect(cabinetMaterial.emissiveIntensity).toBe(originalEmissive);
    expect(conveyorMaterial.color.r).toBe(0.2);
    expect(focus.isActive()).toBe(false);
  });

  it('★ 切换选中（A → B）不残留：A 必须回到原样', () => {
    const { cabinet, cabinetMaterial, conveyor, conveyorMaterial, root } =
      buildModel();
    const focus = createDeviceFocus({} as never);
    const originalEmissive = cabinetMaterial.emissiveIntensity;

    focus.focus([cabinet as never], 'selected', [root as never]);
    expect(cabinetMaterial.emissiveIntensity).toBeGreaterThan(0);

    focus.focus([conveyor as never], 'selected', [root as never]);

    expect(
      cabinetMaterial.emissiveIntensity,
      '★ 上一台必须恢复，否则「点过的地方都亮着」',
    ).toBe(originalEmissive);
    expect(conveyorMaterial.emissiveIntensity).toBeGreaterThan(0);
  });

  it('空节点列表 ⇒ 清空高亮（不抛错）', () => {
    const { root } = buildModel();
    const focus = createDeviceFocus({} as never);
    expect(() => focus.focus([], 'selected', [root as never])).not.toThrow();
    expect(focus.isActive()).toBe(false);
  });

  it('共享材质只处理一次（多个 mesh 共享同一材质时不重复叠加）', () => {
    const shared = material();
    const a = mesh('A', shared);
    const b = mesh('B', shared);
    const root = mesh('Root', material());
    root.children.push(a, b);
    const focus = createDeviceFocus({} as never);

    focus.focus([a as never, b as never], 'hover', [root as never]);

    // base(0) 被视为 1 ⇒ 只加一次 0.28（重复开会是 1.56）
    expect(shared.emissiveIntensity).toBeCloseTo(1.28, 5);
  });
});

describe('collectStandardMaterials：压暗/恢复的快照口径', () => {
  it('按材质对象去重（共享材质只收一份）', () => {
    const shared = material();
    const root = mesh('Root', material());
    root.children.push(mesh('A', shared), mesh('B', shared));
    const snapshots = collectStandardMaterials(root as never);
    // Root 自己的材质 + 共享材质 = 2
    expect(snapshots.size).toBe(2);
  });
});
