import type * as THREE_NS from 'three';

/**
 * 设备聚焦（**选中 / 悬停高亮**）——「设备呈现方式重做」的核心。
 *
 * ## 为什么要重做（用户原话）
 *
 * > 「现在都是在设备上标记一个圆点，默认显示设备的名称显得页面有点混乱，我不想要这种表现形式」
 * > 「可以不要圆点吗？直接选择具体的设备，会有选中效果，比如具体选中某个柜子，会有高光，
 * > 然后显示设备详情卡片之类的效果」
 *
 * 旧形态是「一排圆点 + 一排胶囊」的常驻标注：设备一多就糊成一片，而且**圆点本身不是设备**——
 * 用户想看的是「这个柜子」，不是「柜子上方那个点」。
 *
 * 新形态：
 * - **默认**：画布上什么标注都没有，设备就是模型本身；
 * - **悬停**：该设备的模型节点亮起来（自发光，弱）；
 * - **选中**：自发光加强 + 轻微放大 + **其余设备压暗**，页面弹出详情卡片。
 *
 * ## 为什么用「自发光 + 压暗」而不是 OutlinePass
 *
 * `OutlinePass` 要对**整个场景**做一次法线/深度二次渲染，再按屏幕空间做边缘检测：
 * 在建筑级模型（几十万面）上是明确的帧率成本，而且它画出的是「屏幕空间描边」——
 * 对「柜子被选中」这种语义，**材质自发光 + 周围压暗**的观感更接近真实照明，
 * 也更省（只改材质 uniform，不增加 draw call）。
 *
 * ## 匹配口径（点位 → 模型节点）
 *
 * 优先精确名，其次**宽松匹配**：忽略大小写、忽略 `_`/`-`/空格/`.`（导出工具的常见差异，
 * 如 `CabinetA` / `cabinet_a` / `Cabinet-A` 应视为同一节点）。
 * 宽松匹配可能命中多个节点 ⇒ 全部高亮（例如柜体与柜门分开命名但同前缀）。
 */

/** 宽松匹配时从名字里剔除的字符（全部替换为空串后再比较）。 */
const NAME_IGNORED_PATTERN = /[\s_\-.]/gu;

/**
 * 规范化节点名（忽略大小写、分隔符）。
 *
 * @param name 原始节点名
 * @returns 规范化后的键（空名返回空串）
 */
export function normalizeNodeName(name?: null | string): string {
  if (!name) {
    return '';
  }
  return name.trim().toLowerCase().replaceAll(NAME_IGNORED_PATTERN, '');
}

/** 在模型里按节点名找对象的结果。 */
export interface NodeMatchResult {
  /** 精确名命中（优先）。 */
  exact: THREE_NS.Object3D[];
  /** 宽松匹配命中（精确名没命中时才使用）。 */
  loose: THREE_NS.Object3D[];
}

/**
 * 把一个点位绑定的节点名拆成**候选名列表**。
 *
 * 为什么支持多候选：模型资产的命名不一定与「业务点位」一一对应。例如
 * 点位 `camera_pole_0000` 在 `smart-park-3d` 里可能只渲染成 `camera_pole`（共享几何），
 * 也可能拆成 `camera_pole_0000` / `cam_1` 多个子节点。允许用 `|` 写多个候选：
 * `camera_pole_0000|camera_pole`，匹配时**任一命中即可**（精确优先）。
 *
 * 分隔符选 `|` 而不是逗号：节点名里出现逗号的概率远高于竖线（`Wall,1` 这类导出常见），
 * 且 `|` 在 URL/JSON 里都安全。
 *
 * @param nodeName 点位绑定的节点名
 * @returns 候选名列表（去空、去重、保留顺序）
 */
export function splitNodeNameCandidates(nodeName?: null | string): string[] {
  if (!nodeName) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of nodeName.split('|')) {
    const name = part.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 在模型根里按节点名查找（**纯函数**，不含高亮副作用）。
 *
 * 为什么不直接用 `modelRoot.getObjectByName(name)`：
 * 1. 它只做**精确**匹配，而 GLB 导出工具常把节点名改写成 `Cabinet_A` / `cabinetA`；
 * 2. 它返回**第一个**命中的对象，而一个「设备」在模型里常常拆成多个网格（柜体+柜门+面板）。
 *
 * @param modelRoot 模型根
 * @param nodeName 点位绑定的节点名
 * @returns 命中结果（两者都为空表示该点位没绑定有效的模型节点）
 */
export function findNodesByPointName(
  modelRoot: THREE_NS.Object3D,
  nodeName?: null | string,
): NodeMatchResult {
  const result: NodeMatchResult = { exact: [], loose: [] };
  const candidates = splitNodeNameCandidates(nodeName);
  if (candidates.length === 0) {
    return result;
  }
  const exactKeys = new Set(candidates);
  const looseKeys = new Set(candidates.map((name) => normalizeNodeName(name)));
  modelRoot.traverse((object) => {
    const name = object.name;
    if (!name || object.userData?.isTwinAnchor) {
      return;
    }
    if (exactKeys.has(name)) {
      result.exact.push(object);
      return;
    }
    if (looseKeys.has(normalizeNodeName(name))) {
      result.loose.push(object);
    }
  });
  // 有精确命中时宽松结果无意义（调用方 pickHighlightNodes 会优先精确），
  // 但保留两者便于调试时观察「宽松匹配命中了哪些多余节点」。
  return result;
}

/** 取最终用于高亮的节点（精确优先，否则宽松匹配）。 */
export function pickHighlightNodes(
  match: NodeMatchResult,
): THREE_NS.Object3D[] {
  return match.exact.length > 0 ? match.exact : match.loose;
}

/** 单个点位的高亮样式（选中 > 悬停）。 */
export type FocusStrength = 'hover' | 'selected';

/**
 * 高亮参数（选中/悬停两档）。
 *
 * - 选中：自发光更强 + 轻微放大 + 其余压暗；
 * - 悬停：只提自发光，不放大、不压暗（否则鼠标一扫画面就整体变暗，很吵）。
 */
export interface FocusStyle {
  /** 自发光强度倍率（相对材质原有 emissiveIntensity）。 */
  emissiveIntensity: number;
  /** 自发光颜色（会被乘到材质上）。 */
  emissiveColor: string;
  /** 缩放倍率（1 = 不放大）。 */
  scale: number;
  /** 是否把其余设备压暗。 */
  dimOthers: boolean;
}

/** 选中态样式。 */
export const SELECTED_FOCUS_STYLE: FocusStyle = {
  dimOthers: true,
  emissiveColor: '#ffffff',
  emissiveIntensity: 0.55,
  scale: 1.02,
};

/** 悬停态样式（更弱：不放大、不压暗）。 */
export const HOVER_FOCUS_STYLE: FocusStyle = {
  dimOthers: false,
  emissiveColor: '#ffffff',
  emissiveIntensity: 0.28,
  scale: 1,
};

/** 其余设备压暗的程度（0 = 不压暗，1 = 全黑）。 */
export const DIM_OTHERS_AMOUNT = 0.55;

/** 被高亮节点的原始材质状态（用于恢复）。 */
interface MaterialSnapshot {
  /** 材质对象（可能是共享材质，必须按对象去重）。 */
  material: THREE_NS.MeshStandardMaterial;
  /** 原始自发光强度。 */
  emissiveIntensity: number;
  /** 原始自发光颜色（保存副本，恢复时写回）。 */
  emissive: THREE_NS.Color;
  /** 原始颜色（压暗用）。 */
  color: THREE_NS.Color;
}

/** 一次高亮的快照（node → 原始状态），用于精确恢复。 */
type FocusSnapshot = Map<
  THREE_NS.Object3D,
  { originalScale: THREE_NS.Vector3 }
>;

/** 材质快照（按材质对象去重：多个 mesh 常共享同一材质）。 */
type MaterialSnapshots = Map<THREE_NS.MeshStandardMaterial, MaterialSnapshot>;

/** 设备聚焦控制器。 */
export interface DeviceFocus {
  /** 清除全部高亮（切场景/销毁时调用）。 */
  clear: () => void;
  /** 当前是否处于高亮状态。 */
  isActive: () => boolean;
  /** 设置选中/悬停高亮。 */
  focus: (
    nodes: THREE_NS.Object3D[],
    strength: FocusStrength,
    allModelNodes: THREE_NS.Object3D[],
  ) => void;
}

/**
 * 收集可加压暗的网格材质（**纯函数**：遍历 + 去重，无副作用）。
 *
 * 只处理 `MeshStandardMaterial`（其它材质没有 emissive，压暗需要改 color 且恢复更麻烦，
 * 收益不大 —— 一般建筑/设备模型都是 Standard）。
 *
 * @param root 模型根
 * @returns 材质快照表
 */
export function collectStandardMaterials(
  root: THREE_NS.Object3D,
): MaterialSnapshots {
  const snapshots: MaterialSnapshots = new Map();
  root.traverse((object) => {
    const mesh = object as THREE_NS.Mesh & { isMesh?: boolean };
    if (!mesh.isMesh || !mesh.material) {
      return;
    }
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    for (const material of materials) {
      const standard = material as THREE_NS.MeshStandardMaterial;
      if (!standard.emissive || snapshots.has(standard)) {
        continue;
      }
      snapshots.set(standard, {
        color: standard.color.clone(),
        emissive: standard.emissive.clone(),
        emissiveIntensity: standard.emissiveIntensity ?? 1,
        material: standard,
      });
    }
  });
  return snapshots;
}

/**
 * 创建设备聚焦控制器。
 *
 * 设计要点：
 * - **按材质快照恢复**，而不是「把 emissive 设回黑色」：模型可能本来就有自发光件（指示灯），
 *   粗暴清零会把它们熄灭；
 * - **共享材质只处理一次**（多个 mesh 共享同一材质时重复乘会叠加）；
 * - 压暗是「减去全部材质颜色的一定比例」，恢复用快照，**幂等**。
 *
 * @param THREE three 命名空间
 * @returns 聚焦控制器
 */
export function createDeviceFocus(THREE: typeof THREE_NS): DeviceFocus {
  let snapshots: MaterialSnapshots | undefined;
  let snapshotRoot: THREE_NS.Object3D | undefined;
  let scaleSnapshot: FocusSnapshot | undefined;
  /**
   * 为「实例级高亮」而复制出来的材质（共享材质的副本）。
   *
   * 结构：mesh → { original, copy }。恢复时把 mesh.material 换回 original 并 dispose copy，
   * 否则反复点选会持续泄漏材质（每点一次复制一份）。
   */
  let materialCopies: Array<{
    copy: THREE_NS.Material | THREE_NS.Material[];
    mesh: THREE_NS.Mesh;
    original: THREE_NS.Material | THREE_NS.Material[];
  }> = [];
  /** 当前模型根（恢复材质副本时用它统计引用）。 */
  let focusRoot: THREE_NS.Object3D | undefined;
  let active = false;

  /** 确保材质快照对应当前模型根（换模型后必须重建快照）。 */
  const ensureSnapshots = (root: THREE_NS.Object3D): MaterialSnapshots => {
    if (!snapshots || snapshotRoot !== root) {
      snapshotRoot = root;
      snapshots = collectStandardMaterials(root);
    }
    return snapshots;
  };

  /** 恢复全部材质与缩放。 */
  const restore = (): void => {
    if (snapshots) {
      for (const snapshot of snapshots.values()) {
        const { material } = snapshot;
        material.emissiveIntensity = snapshot.emissiveIntensity;
        material.emissive.copy(snapshot.emissive);
        material.color.copy(snapshot.color);
        material.needsUpdate = true;
      }
    }
    if (scaleSnapshot) {
      for (const [object, state] of scaleSnapshot) {
        object.scale.copy(state.originalScale);
      }
      scaleSnapshot = undefined;
    }
    // 把克隆出来的材质换回原材质并释放（不释放会随点选次数持续泄漏）
    for (const record of materialCopies) {
      record.mesh.material = record.original as never;
      const copies = Array.isArray(record.copy) ? record.copy : [record.copy];
      for (const copy of copies) {
        copy.dispose();
      }
    }
    materialCopies = [];
    active = false;
  };

  const clear = (): void => {
    restore();
  };

  const focus = (
    nodes: THREE_NS.Object3D[],
    strength: FocusStrength,
    allModelNodes: THREE_NS.Object3D[],
  ): void => {
    // 每次聚焦前先恢复：保证「上一次高亮」不会残留（多次切换选中是常态）
    restore();
    if (nodes.length === 0) {
      return;
    }
    const style =
      strength === 'selected' ? SELECTED_FOCUS_STYLE : HOVER_FOCUS_STYLE;
    const root = allModelNodes[0];
    focusRoot = root;
    const materials = root ? ensureSnapshots(root) : undefined;

    // 1) 压暗其余设备（只对 Standard 材质，按快照恢复，幂等）
    if (style.dimOthers && materials) {
      const highlighted = new Set<THREE_NS.MeshStandardMaterial>();
      for (const node of nodes) {
        node.traverse((child) => {
          const mesh = child as THREE_NS.Mesh & { isMesh?: boolean };
          if (!mesh.isMesh || !mesh.material) {
            return;
          }
          const list = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
          for (const material of list) {
            highlighted.add(material as THREE_NS.MeshStandardMaterial);
          }
        });
      }
      for (const [material, snapshot] of materials) {
        if (highlighted.has(material)) {
          continue;
        }
        material.color
          .copy(snapshot.color)
          .multiplyScalar(1 - DIM_OTHERS_AMOUNT);
        material.needsUpdate = true;
      }
    }

    // 2) 高亮目标节点：自发光 + （选中时）轻微放大
    //
    // ⚠️ **共享材质必须先拆成实例级**（实测缺陷：用户反馈「所有的设备都亮了」）：
    //    资产里同一类设备（10 根监控杆）共享同一个 material 对象，直接改它会把
    //    全部同款设备一起点亮。因此：若某材质被「目标节点之外的 mesh」也引用，
    //    先给目标 mesh 换一份 `material.clone()`，再只点亮这份副本。
    //
    //    判据用 `usedByOthers`（遍历整棵树统计引用），而不是「材质 id 是否见过」——
    //    后者只能防重复改，防不了「改的就是公共材质」。
    const materialUseCount = new Map<THREE_NS.Material, number>();
    focusRoot?.traverse((child) => {
      const mesh = child as THREE_NS.Mesh & { isMesh?: boolean };
      if (!mesh.isMesh || !mesh.material) {
        return;
      }
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]) {
        materialUseCount.set(
          material,
          (materialUseCount.get(material) ?? 0) + 1,
        );
      }
    });

    const focusedMaterials = new Set<THREE_NS.MeshStandardMaterial>();
    scaleSnapshot = new Map();
    for (const node of nodes) {
      node.traverse((child) => {
        const mesh = child as THREE_NS.Mesh & { isMesh?: boolean };
        if (!mesh.isMesh || !mesh.material) {
          return;
        }
        const list = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        const isolated = list.map((material) => {
          // 只被目标节点自己引用 ⇒ 直接改；被别的 mesh 也用着 ⇒ 复制一份独占
          if ((materialUseCount.get(material) ?? 0) <= 1) {
            return material;
          }
          // 测试替身/极简材质可能没有 clone：此时退化为「原材质」（高亮会波及同款，
          // 但至少不崩）；真实 three 材质总有 clone。
          const cloneFn = (
            material as unknown as { clone?: () => THREE_NS.Material }
          ).clone;
          return typeof cloneFn === 'function'
            ? cloneFn.call(material)
            : material;
        });
        if (isolated.some((material, index) => material !== list[index])) {
          const wasArray = Array.isArray(mesh.material);
          const copied = (wasArray ? isolated : isolated[0]) as
            | THREE_NS.Material
            | THREE_NS.Material[];
          const original = (wasArray ? list : list[0]) as
            | THREE_NS.Material
            | THREE_NS.Material[];
          mesh.material = copied as never;
          materialCopies.push({ copy: copied, mesh, original });
        }
        for (const material of isolated) {
          const standard = material as THREE_NS.MeshStandardMaterial;
          if (!standard.emissive || focusedMaterials.has(standard)) {
            continue;
          }
          focusedMaterials.add(standard);
          const base = standard.emissiveIntensity || 1;
          standard.emissive.set(style.emissiveColor);
          standard.emissiveIntensity = base + style.emissiveIntensity;
          standard.needsUpdate = true;
        }
      });
      if (style.scale !== 1) {
        scaleSnapshot.set(node, { originalScale: node.scale.clone() });
        node.scale.multiplyScalar(style.scale);
      }
    }
    active = true;
    void THREE;
  };

  return {
    clear,
    focus,
    isActive: () => active,
  };
}
