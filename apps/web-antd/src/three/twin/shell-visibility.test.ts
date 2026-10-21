import type * as THREE_NS from 'three';

import { describe, expect, it } from 'vitest';

import {
  applyShellVisibility,
  collectShellNodes,
  isShellNodeName,
  SHELL_HIDDEN_NAME_PREFIXES,
} from './shell-visibility';

/**
 * 「剖切 / 完整」外观：按节点名隐藏屋顶与近侧墙。
 *
 * ## 为什么用替身场景树
 *
 * 这个功能唯一的失败形态是「藏错了东西」：把机柜藏了、把锚点藏了、或者一个都没藏到
 * （`isShellSupported()` 撒谎 ⇒ 页面显示一个点了没反应的开关）。因此用一棵最小但
 * **包含全部关键类别**的树来断言「该藏的藏了、不该藏的都在」。
 */

/** 造一个替身 Object3D（只含本功能用到的字段）。 */
function node(
  name: string,
  children: THREE_NS.Object3D[] = [],
): THREE_NS.Object3D {
  const object = {
    children,
    name,
    userData: {} as Record<string, unknown>,
    visible: true,
  } as unknown as THREE_NS.Object3D;
  return object;
}

/** 锚点节点（与 anchor-layer 同口径：userData.isTwinAnchor=true）。 */
function anchorNode(name: string): THREE_NS.Object3D {
  const object = node(name);
  object.userData.isTwinAnchor = true;
  return object;
}

/** 造一棵「完整封闭厂房」的树：屋顶/桁架/四面墙 + 机柜 + 锚点。 */
function buildFactory(): {
  anchors: THREE_NS.Object3D[];
  cabinets: THREE_NS.Object3D[];
  root: THREE_NS.Object3D;
  shells: THREE_NS.Object3D[];
} {
  const anchors = [anchorNode('Sprite'), anchorNode('CSS2DObject')];
  const cabinets = [node('Cabinet_A'), node('Cabinet_B'), node('Cabinet_C')];
  const shells = [
    node('Roof_Panel'),
    node('Roof_Ridge'),
    node('Roof_Skylights'),
    node('Wall_North'),
    node('Wall_South'),
    node('Wall_East'),
    node('Wall_West'),
    node('Wall_Wainscot'),
    node('Wall_RollUpDoors'),
    node('Truss_Steelwork'),
  ];
  const firstCabinet = cabinets[0];
  const root = node('Root', [
    ...shells,
    ...cabinets,
    // 锚点挂在机柜下面（真实结构：锚点是模型的子节点）
    node('CabinetRoot', firstCabinet ? [firstCabinet, ...anchors] : anchors),
  ]);
  return { anchors, cabinets, root, shells };
}

describe('isShellNodeName：按命名约定判定外壳节点', () => {
  it('★ 屋顶/墙/桁架命中（忽略大小写）', () => {
    for (const name of [
      'Roof_Panel',
      'roof_ridge',
      'Ceiling_01',
      'Wall_North',
      'wall_south',
      'Wall_East',
      'Wall_West',
      'Wall_Wainscot',
      'Wall_RollUpDoors',
      'Wall_DoorHazardBands',
      'Truss_Steelwork',
    ]) {
      expect(isShellNodeName(name), `${name} 应被识别为外壳`).toBe(true);
    }
  });

  it('★ 机柜/产线/锚点等业务节点不命中', () => {
    for (const name of [
      'Cabinet_A',
      'Conveyor_01',
      'Pipe_X',
      'Floor_Slab',
      'Sprite',
      'CSS2DObject',
      'DoorMain',
      '',
    ]) {
      expect(isShellNodeName(name), `${name} 不应被识别为外壳`).toBe(false);
    }
  });

  it('前缀清单是具名常量且非空（不在别处散落魔法字符串）', () => {
    expect(Array.isArray(SHELL_HIDDEN_NAME_PREFIXES)).toBe(true);
    expect(SHELL_HIDDEN_NAME_PREFIXES.length).toBeGreaterThanOrEqual(5);
    // 桁架必须在清单里：屋顶隐藏后它仍是最大遮挡源
    expect(SHELL_HIDDEN_NAME_PREFIXES).toContain('Truss');
  });
});

describe('collectShellNodes：收集外壳，绝不误伤', () => {
  it('★ 收集到全部 roof/wall/truss，机柜与锚点一个都不收', () => {
    const { anchors, cabinets, root, shells } = buildFactory();
    const { nodes } = collectShellNodes(root);
    expect(nodes).toHaveLength(shells.length);
    for (const shell of shells) {
      expect(nodes).toContain(shell);
    }
    for (const cabinet of cabinets) {
      expect(nodes, '机柜不能被当作外壳').not.toContain(cabinet);
    }
    for (const anchor of anchors) {
      expect(nodes, '★ 锚点绝不能出现在外壳节点里').not.toContain(anchor);
    }
  });

  it('★ 带 isTwinAnchor 的节点即使叫 Roof_* 也不收（防误伤）', () => {
    const disguised = anchorNode('Roof_Anchor_Sprite');
    const root = node('Root', [disguised]);
    const { nodes } = collectShellNodes(root);
    expect(nodes).toHaveLength(0);
  });

  it('同名子树只取最外层（不把子网格逐个塞进状态表）', () => {
    const inner = node('Roof_Detail');
    const roof = node('Roof_Panel', [inner]);
    const root = node('Root', [roof]);
    const { nodes } = collectShellNodes(root);
    expect(nodes).toEqual([roof]);
  });

  it('无 roof/wall 节点的模型 ⇒ 空集合（isShellSupported 据此返回 false）', () => {
    const root = node('Root', [node('Cabinet_A'), anchorNode('Sprite')]);
    expect(collectShellNodes(root).nodes).toHaveLength(0);
  });
});

describe('★ applyShellVisibility：剖切隐藏 / 完整恢复', () => {
  it('★ 剖切：只有外壳 visible=false，机柜与锚点保持可见', () => {
    const { anchors, cabinets, root, shells } = buildFactory();
    const shell = collectShellNodes(root);

    applyShellVisibility(shell, false);

    for (const item of shells) {
      expect(item.visible, `${item.name} 剖切时必须隐藏`).toBe(false);
    }
    for (const item of cabinets) {
      expect(item.visible, `${item.name}（机柜）必须保持可见`).toBe(true);
    }
    for (const item of anchors) {
      expect(item.visible, '★ 锚点必须保持可见（否则整个功能消失）').toBe(true);
    }
  });

  it('★ 切回完整：全部外壳恢复可见（隐藏只是 visible，不是 dispose）', () => {
    const { root, shells } = buildFactory();
    const shell = collectShellNodes(root);

    applyShellVisibility(shell, false);
    applyShellVisibility(shell, true);

    for (const item of shells) {
      expect(item.visible, `${item.name} 必须恢复可见`).toBe(true);
    }
  });

  it('幂等：连续两次同样的调用结果一致', () => {
    const { root, shells } = buildFactory();
    const shell = collectShellNodes(root);
    applyShellVisibility(shell, false);
    applyShellVisibility(shell, false);
    expect(shells.every((item) => !item.visible)).toBe(true);
  });

  it('空集合不抛错（模型没有外壳节点时）', () => {
    expect(() => applyShellVisibility({ nodes: [] }, false)).not.toThrow();
  });
});

/**
 * 锚点挂在**将被隐藏的外壳节点下面**时的处理。
 *
 * 点位「贴在屋顶上」时建模者很自然会把它挂在 `Roof_*` 下面；直接隐藏父级会让锚点
 * 一起消失 ⇒ 用户在剖切视图里看到「这台设备凭空消失」。
 */
describe('applyShellVisibility：挂在被隐藏父级下的锚点必须被「救出来」', () => {
  it('★ 锚点挂在 Roof_Panel 下 ⇒ 剖切后锚点仍在模型根上且可见，位置不变', () => {
    // 替身需要 parent 与 add/removeFromParent 才能验证 reparent
    const makeNode = (name: string): THREE_NS.Object3D => {
      const object = {
        children: [] as THREE_NS.Object3D[],
        name,
        parent: null as null | THREE_NS.Object3D,
        userData: {} as Record<string, unknown>,
        visible: true,
        add(child: THREE_NS.Object3D) {
          child.parent = object as unknown as THREE_NS.Object3D;
          object.children.push(child);
          return object;
        },
        traverse(callback: (item: THREE_NS.Object3D) => void) {
          callback(object as unknown as THREE_NS.Object3D);
          for (const c of object.children) {
            c.traverse?.(callback);
          }
        },
      };
      return object as unknown as THREE_NS.Object3D;
    };
    const roof = makeNode('Roof_Panel');
    const sprite = makeNode('Sprite');
    sprite.userData.isTwinAnchor = true;
    const root = makeNode('Root');
    // 结构：root → roof → sprite（锚点挂在屋顶下）
    root.add(roof);
    roof.add(sprite);

    const shell = collectShellNodes(root);
    expect(shell.nodes).toEqual([roof]);

    applyShellVisibility(shell, false, root);

    expect(roof.visible).toBe(false);
    expect(sprite.visible, '★ 锚点本身不能被隐藏').toBe(true);
    expect(
      sprite.parent,
      '★ 锚点必须被移到模型根下（否则父级隐藏会连带隐藏它）',
    ).toBe(root);
  });

  it('切回完整时不搬动任何节点（repoparent 只在剖切时发生一次）', () => {
    const makeNode = (name: string): THREE_NS.Object3D => {
      const object = {
        children: [] as THREE_NS.Object3D[],
        name,
        parent: null as null | THREE_NS.Object3D,
        userData: {} as Record<string, unknown>,
        visible: true,
        add(child: THREE_NS.Object3D) {
          child.parent = object as unknown as THREE_NS.Object3D;
          object.children.push(child);
          return object;
        },
        traverse(callback: (item: THREE_NS.Object3D) => void) {
          callback(object as unknown as THREE_NS.Object3D);
          for (const c of object.children) {
            c.traverse(callback);
          }
        },
      };
      return object as unknown as THREE_NS.Object3D;
    };
    const roof = makeNode('Roof_Panel');
    const root = makeNode('Root');
    root.add(roof);
    const shell = collectShellNodes(root);
    applyShellVisibility(shell, true, root);
    expect(roof.visible).toBe(true);
    expect(roof.parent).toBe(root);
  });
});
