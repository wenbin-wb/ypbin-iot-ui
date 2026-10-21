import type * as THREE_NS from 'three';

/**
 * 「剖切 / 完整」外观（按节点名隐藏屋顶与近侧墙）。
 *
 * ## 要解决的问题（用户确认的 B 方案）
 *
 * 程序化生成的演示厂房 GLB 是**完整封闭厂房**：屋顶、桁架、四面墙俱全，而 6 个设备锚点
 * 在机柜内部（y=3.2）。相机在外围俯视 ⇒ **锚点全被屋顶挡住**，画面上只有几个圆点挂在
 * 白色屋面上，看不出「里面是什么设备」。
 *
 * 参考图（冷链大屏）的做法就是**隐藏屋顶 + 桁架**，让俯视视角直接看到内部产线。
 *
 * ## 实现口径（三条，缺一不可）
 *
 * 1. **按节点名前缀匹配**，不猜几何：只看 `name`，不问尺寸/材质/位置。
 *    这是与**资产制作的命名约定**（见 {@link SHELL_HIDDEN_NAME_PREFIXES}）；
 * 2. **只改 `visible`，不 dispose**：用户随时可能切回「完整」，dispose 后无法恢复；
 * 3. **绝不误伤**：锚点 sprite/CSS2D 对象（`userData.isTwinAnchor`）与所有非 roof/wall 的
 *    业务节点（机柜、产线）必须保持可见——把锚点藏掉等于把整个功能藏掉。
 *
 * ## 为什么 `Truss*` 也在隐藏清单里
 *
 * 桁架（钢结构屋架）在俯视时**遮挡面积最大**：即使屋顶隐藏了，密集的桁架梁也会把内部
 * 切成一格一格。参考图的「高级感」正来自「屋顶没了、结构还在但变稀」，所以桁架一起隐藏。
 */

/**
 * 剖切时要隐藏的节点**名前缀**（忽略大小写）。
 *
 * ⚠️ 这是**与模型资产的命名约定**：建模/导出时屋顶类节点必须以 `Roof`/`Ceiling` 开头、
 * 墙体以 `Wall_方向` 开头、桁架以 `Truss` 开头。约定变了就改这里（唯一真相），
 * 不要在别处散落字符串。
 */
export const SHELL_HIDDEN_NAME_PREFIXES = [
  // 屋顶与天花板（俯视时遮挡面积最大）
  'Roof',
  'Ceiling',
  // 四面墙：俯视时近侧墙会挡住内部，远侧墙保留仍能看出体量
  'Wall_North',
  'Wall_South',
  'Wall_East',
  'Wall_West',
  // 墙饰面/卷帘门/警示带：贴墙的构件，一起隐藏才不会留下「浮在半空的贴片」
  'Wall_Wainscot',
  'Wall_RollUpDoors',
  'Wall_DoorHazardBands',
  // 桁架：屋顶隐藏后它仍是最大的遮挡源（见文件头注释）
  'Truss',
] as const;

/** 判断某个节点名是否属于「外壳」（剖切时隐藏）。 */
export function isShellNodeName(name: string): boolean {
  if (!name) {
    return false;
  }
  const lower = name.toLowerCase();
  return SHELL_HIDDEN_NAME_PREFIXES.some((prefix) =>
    lower.startsWith(prefix.toLowerCase()),
  );
}

/** 收集到的外壳节点（由 `collectShellNodes` 产出）。 */
export interface ShellNodes {
  /** 可隐藏的外壳节点（roof/wall/truss）。 */
  nodes: THREE_NS.Object3D[];
}

/**
 * 在模型根下收集「外壳节点」。
 *
 * 排除规则：
 * - `userData.isTwinAnchor` 的节点（锚点图标/标签）——它们可能被挂在模型节点下面，
 *   隐藏父级时会连带消失；
 * - 已经是 `visible=false` 的子树**不再深入**（那部分是模型作者本就不想显示的）。
 *
 * 只统计「有名字且命中前缀」的**最外层**节点：一个 `Roof_Panel` 下面的子网格不必逐个
 * 处理（隐藏父级就够了），逐个子节点处理只会让开销与状态数变大。
 *
 * @param modelRoot 模型根
 * @returns 外壳节点集合
 */
export function collectShellNodes(modelRoot: THREE_NS.Object3D): ShellNodes {
  const nodes: THREE_NS.Object3D[] = [];
  const visit = (object: THREE_NS.Object3D): void => {
    const { isTwinAnchor } = object.userData as { isTwinAnchor?: boolean };
    // 锚点绝不能被当作外壳（反向变异点：去掉这行会让锚点一起消失）
    if (isTwinAnchor === true) {
      return;
    }
    if (object !== modelRoot && isShellNodeName(object.name)) {
      nodes.push(object);
      // 整棵子树都属于外壳：不再深入，避免把子网格也塞进状态表
      return;
    }
    for (const child of object.children) {
      visit(child);
    }
  };
  visit(modelRoot);
  return { nodes };
}

/**
 * 应用「剖切 / 完整」。
 *
 * @param shell 收集到的外壳节点
 * @param visible true = 完整（全部显示）；false = 剖切（全部隐藏）
 * @param modelRoot 模型根（可选：用于把锚点从被隐藏的父级下「救出来」）
 */
export function applyShellVisibility(
  shell: ShellNodes,
  visible: boolean,
  modelRoot?: THREE_NS.Object3D,
): void {
  for (const node of shell.nodes) {
    node.visible = visible;
  }
  if (visible || !modelRoot) {
    return;
  }
  rescueAnchors(modelRoot, shell.nodes);
}

/**
 * 把挂在「即将隐藏的外壳」下的锚点移到模型根上。
 *
 * 为什么需要：锚点是模型的子节点（`attach` 时 `modelRoot.add(sprite)`），但如果模型作者
 * 把某个锚点挂在了 `Roof_*` 之类的节点下面（点位「贴」在屋顶上时很自然），
 * 隐藏外壳会**连带隐藏锚点**——用户在剖切视图下会看到「这台设备凭空消失」。
 * 移到模型根只改变父级、不改变世界坐标（`attach` 时用的是**模型局部坐标**，
 * 模型根就是那个坐标系，因此移动后位置完全不变）。
 *
 * @param modelRoot 模型根
 * @param hidden 即将隐藏的外壳节点
 */
function rescueAnchors(
  modelRoot: THREE_NS.Object3D,
  hidden: THREE_NS.Object3D[],
): void {
  const hiddenSet = new Set(hidden);
  const toRescue: THREE_NS.Object3D[] = [];
  modelRoot.traverse((object) => {
    const { isTwinAnchor } = object.userData as { isTwinAnchor?: boolean };
    if (isTwinAnchor !== true) {
      return;
    }
    // 找它最近的、属于外壳的祖先
    let parent = object.parent;
    while (parent && parent !== modelRoot) {
      if (hiddenSet.has(parent)) {
        toRescue.push(object);
        return;
      }
      parent = parent.parent;
    }
  });
  for (const anchor of toRescue) {
    // `attach` 时锚点坐标就是模型局部坐标（modelRoot 的坐标系）⇒ reparent 不改变位置
    modelRoot.add(anchor);
  }
}
