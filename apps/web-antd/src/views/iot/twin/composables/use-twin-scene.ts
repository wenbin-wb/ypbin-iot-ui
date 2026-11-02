import { computed, ref } from 'vue';

import { getTwinSceneList, IotTwinApi } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

/** 场景树节点（后端 `SceneResp` + 前端组树后的 children）。 */
export interface SceneTreeNode extends IotTwinApi.SceneResp {
  children: SceneTreeNode[];
  /** 树深度（根为 1），用于判断还能否加子场景。 */
  depth: number;
}

/** 根场景的 parentId 哨兵值（与后端一致）。 */
export const ROOT_PARENT_ID = '0';

/**
 * 场景树数据域：拉取、组树、增删改、按 id 找节点与祖先链。
 *
 * ## 为什么组树在前端而不是后端
 *
 * 后端 `GET /iot/twin/scenes` 返回**平铺列表**（按 parentId/sort/id 排序）。理由：
 * - 平铺列表是「全量」的：前端要同时用它做树渲染、祖先链计算、父场景下拉候选
 *   （需要「排除自己与自己的后代」），树形结构反而不便于这些计算；
 * - 树的形状是展示决策（要不要折叠、要不要显示点数），不该固化进接口。
 *
 * ## 失败语义
 *
 * 加载失败时 `error` 非空、`scenes` 保持**上一次的成功数据**（不置空）：
 * 置空会让用户看到「一棵空树」，误以为配置全丢了。这与设备台账的失败态口径一致。
 */
export function useTwinScene() {
  const scenes = ref<IotTwinApi.SceneResp[]>([]);
  const loading = ref(false);
  /** 加载失败原因（空串 = 无错）。 */
  const error = ref('');
  /**
   * 请求世代号（竞态守卫，工单 #132）。
   *
   * 每次 `load()` 自增并记下本次世代；`await` 回来后若世代已变，说明期间又发起了更新的
   * 请求（或已切场景）⇒ **丢弃本次结果**，不覆盖较新的数据。
   * 不用 `AbortController`：本仓 requestClient 的取消语义未统一，而「丢弃过期结果」
   * 已足以保证界面正确，且不会因取消失败而残留 pending 状态。
   */
  let sceneLoadGeneration = 0;

  /** 组树后的根节点列表。 */
  const tree = computed<SceneTreeNode[]>(() => buildTree(scenes.value));

  /** id → 场景索引（供祖先链与查找用）。 */
  const byId = computed(() => {
    const map = new Map<string, IotTwinApi.SceneResp>();
    for (const scene of scenes.value) {
      map.set(scene.id, scene);
    }
    return map;
  });

  /** 重新拉取场景列表。 */
  async function load(): Promise<void> {
    const generation = ++sceneLoadGeneration;
    loading.value = true;
    try {
      const data = await getTwinSceneList();
      // 过期响应：期间有更新的加载或已卸载，丢弃（否则旧数据会覆盖新场景）
      if (generation !== sceneLoadGeneration) {
        return;
      }
      scenes.value = data;
      error.value = '';
    } catch (loadError) {
      if (generation !== sceneLoadGeneration) {
        return;
      }
      // 保留上一次数据：清空会让用户误以为配置丢了
      error.value = extractErrorMessage(
        loadError,
        $t('page.iot.twin.sceneLoadFailed'),
      );
      throw loadError;
    } finally {
      // 只有最新世代才收起 loading：否则旧请求结束会把新请求的 loading 提前关掉
      if (generation === sceneLoadGeneration) {
        loading.value = false;
      }
    }
  }

  /** 按 id 查场景（找不到返回 undefined，不抛）。 */
  function findScene(id?: null | string): IotTwinApi.SceneResp | undefined {
    if (!id) {
      return undefined;
    }
    return byId.value.get(id);
  }

  /**
   * 取从根到指定场景的祖先链（**含自身**，按根→叶顺序）。
   *
   * 这是世界坐标链的数据来源：`scene-manager` 用它逐级左乘锚点矩阵。
   * 链断裂（父场景已被删除）时**截断到能取到的部分**并返回 `broken: true`，
   * 由页面显式提示——静默返回不完整的链会让模型位置偏移而无从察觉。
   */
  function ancestryOf(sceneId: string): {
    broken: boolean;
    chain: IotTwinApi.SceneResp[];
  } {
    const chain: IotTwinApi.SceneResp[] = [];
    let cursor = byId.value.get(sceneId);
    const seen = new Set<string>();
    let broken = false;
    while (cursor) {
      if (seen.has(cursor.id)) {
        // 数据成环（后端有校验，这里防御）：立刻停止，避免无限循环
        broken = true;
        break;
      }
      seen.add(cursor.id);
      chain.unshift(cursor);
      if (cursor.parentId === ROOT_PARENT_ID) {
        return { broken, chain };
      }
      const parent = byId.value.get(cursor.parentId);
      if (!parent) {
        broken = true;
        break;
      }
      cursor = parent;
    }
    return { broken, chain };
  }

  /** 计算某场景的深度（根为 1）。找不到场景时返回 0。 */
  function depthOf(sceneId: string): number {
    return ancestryOf(sceneId).chain.length;
  }

  /** 是否还能给某场景加子场景（深度上限）。 */
  function canAddChild(sceneId: string): boolean {
    return depthOf(sceneId) < IotTwinApi.TWIN_LIMITS.maxSceneDepth;
  }

  /**
   * 父场景下拉候选：排除自身与自身的全部后代（否则会形成环）。
   *
   * @param excludeSceneId 正在编辑的场景 id（新建时传 undefined）
   */
  function parentOptions(
    excludeSceneId?: string,
  ): Array<{ label: string; value: string }> {
    const excluded = new Set<string>();
    if (excludeSceneId) {
      // 用「谁的祖先链包含 excludeSceneId」判定后代
      for (const scene of scenes.value) {
        const { chain } = ancestryOf(scene.id);
        if (chain.some((item) => item.id === excludeSceneId)) {
          excluded.add(scene.id);
        }
      }
    }
    return scenes.value
      .filter((scene) => !excluded.has(scene.id))
      .map((scene) => ({
        label: `${indent(depthOf(scene.id))}${scene.sceneName}（${scene.sceneCode}）`,
        value: scene.id,
      }));
  }

  return {
    ancestryOf,
    byId,
    canAddChild,
    depthOf,
    error,
    findScene,
    load,
    loading,
    parentOptions,
    scenes,
    tree,
  };
}

/**
 * 平铺列表 → 树。
 *
 * 父节点不存在的节点（父场景被删除）**挂到根**并保留：丢掉它会让用户完全看不到这条配置，
 * 而「挂在根上 + 可编辑修复」才是可操作的。这是刻意的容错，与「静默降级」的区别在于：
 * 页面会通过 `ancestryOf().broken` 标注「父场景已不存在」。
 *
 * @param scenes 平铺场景列表
 * @returns 树根节点列表
 */
function buildTree(scenes: IotTwinApi.SceneResp[]): SceneTreeNode[] {
  const nodeMap = new Map<string, SceneTreeNode>();
  for (const scene of scenes) {
    nodeMap.set(scene.id, { ...scene, children: [], depth: 1 });
  }
  const roots: SceneTreeNode[] = [];
  for (const node of nodeMap.values()) {
    const parent = nodeMap.get(node.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      // parentId === '0' 或父场景已不存在 ⇒ 挂根
      roots.push(node);
    }
  }
  const assignDepth = (nodes: SceneTreeNode[], depth: number): void => {
    for (const node of nodes) {
      node.depth = depth;
      assignDepth(node.children, depth + 1);
    }
  };
  assignDepth(roots, 1);
  // 排序：按 sort 升序、再按 id（与后端返回顺序一致，避免前端排序抖动）
  const sortNodes = (nodes: SceneTreeNode[]): void => {
    nodes.sort(
      (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id.localeCompare(b.id),
    );
    for (const node of nodes) {
      sortNodes(node.children);
    }
  };
  sortNodes(roots);
  return roots;
}

/**
 * 生成树形缩进（全角空格，保证在下拉选项里对齐）。
 *
 * @param depth 深度（根为 1）
 * @returns 缩进字符串
 */
function indent(depth: number): string {
  return '　'.repeat(Math.max(0, depth - 1));
}
