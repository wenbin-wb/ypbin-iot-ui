<script lang="ts" setup>
import type { DataNode } from 'ant-design-vue/es/tree';

import type { SceneTreeNode } from '../composables/use-twin-scene';
import type { SceneBadge } from './scene-badges';

import type { IotTwinApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';
import { useVbenDrawer } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import { Button, Empty, message, Popconfirm, Spin, Tree } from 'ant-design-vue';

import { deleteTwinScene } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import SceneForm from './scene-form.vue';

/**
 * 场景树（含新增/编辑/删除/下钻）。
 *
 * 用 antd `Tree` 而不是 vben 表格/树：本区块只做「展开 + 点选 + 行内操作」，
 * 属纯展示/导航用途（`vben-ui-dev` 铁律 2 的例外条款允许直接用 antd 展示类组件）。
 *
 * `treeData` 里的 `key`/`title` 是 **antd Tree 的协议字段**，不是「字段改名」：
 * 后端字段 `id`/`sceneName` 原样保留在节点对象上。
 */
const props = defineProps<{
  /**
   * 场景角标（点位数 / 告警数 / 是否有模型）。
   *
   * 由父组件用 `computeSceneBadges` 算好传入：本组件只渲染，不自己统计
   * （统计口径要能单测，且必须与 KPI 条同源）。
   */
  badges?: Map<string, SceneBadge>;
  /** 是否还能给该场景加子场景（深度上限）。 */
  canAddChild: (sceneId: string) => boolean;
  /** 当前场景 ID。 */
  currentSceneId: string;
  /** 计算场景深度。 */
  depthOf: (sceneId: string) => number;
  /** 加载失败原因（空串 = 无错）。 */
  error: string;
  /** 加载中。 */
  loading: boolean;
  /** 父场景候选（按当前编辑行排除自身与后代）。 */
  parentOptions: (excludeSceneId?: string) => Array<{
    label: string;
    value: string;
  }>;
  /** 平铺场景列表（表单回填用）。 */
  scenes: IotTwinApi.SceneResp[];
  /** 组树后的数据。 */
  tree: SceneTreeNode[];
}>();

const emit = defineEmits<{
  /** 进入场景。 */
  enter: [sceneId: string];
  /** 数据已变更，需要刷新。 */
  refresh: [];
}>();

/** 权限门禁（#129）：点位与模型都有权限判断，此前独缺场景树这一层。 */
const { hasAccessByCodes } = useAccess();
const canCreate = computed(() => hasAccessByCodes(['iot:twin:create']));
const canUpdate = computed(() => hasAccessByCodes(['iot:twin:update']));
const canDelete = computed(() => hasAccessByCodes(['iot:twin:delete']));

/** 展开的节点 key（受控：新增子场景后自动展开父节点）。 */
const expandedKeys = ref<string[]>([]);

/** 选中节点由 `currentSceneId` 驱动（URL 是唯一事实来源）。 */
const selectedKeys = computed(() => [props.currentSceneId]);

const [FormDrawer, formDrawerApi] = useVbenDrawer({
  connectedComponent: SceneForm,
});

/** antd Tree 的节点数据。 */
/** Tree 节点（在 antd `DataNode` 基础上带出业务字段，供行内操作使用）。 */
interface SceneTreeNodeData extends DataNode {
  modelAssetId?: null | string;
  sceneCode: string;
  sceneName: string;
  sceneType: string;
}

const treeData = computed<SceneTreeNodeData[]>(() =>
  props.tree.map(function toNode(node): SceneTreeNodeData {
    return {
      children: node.children.map(toNode),
      key: node.id,
      modelAssetId: node.modelAssetId,
      sceneCode: node.sceneCode,
      sceneName: node.sceneName,
      sceneType: node.sceneType,
      title: node.sceneName,
    };
  }),
);

/** 新增根场景。 */
function onCreateRoot(): void {
  formDrawerApi
    .setData({ parentOptions: props.parentOptions(), scenes: props.scenes })
    .open();
}

/**
 * 新增子场景（深度到顶时明确拒绝并说明原因）。
 *
 * @param node 父场景节点
 */
function onCreateChild(node: SceneTreeNode): void {
  if (!props.canAddChild(node.id)) {
    message.warning($t('page.iot.twin.depthLimit'));
    return;
  }
  expandNode(node.id);
  formDrawerApi
    .setData({
      parentId: node.id,
      parentOptions: props.parentOptions(),
      scenes: props.scenes,
    })
    .open();
}

/**
 * 编辑场景。
 *
 * @param node 场景节点
 */
function onEdit(node: SceneTreeNode): void {
  formDrawerApi
    .setData({
      parentOptions: props.parentOptions(node.id),
      row: props.scenes.find((item) => item.id === node.id),
      scenes: props.scenes,
    })
    .open();
}

/**
 * 删除场景（失败原因原样展示：后端会说明「还有子场景 / 还有点位」）。
 *
 * @param node 场景节点
 */
async function onDelete(node: SceneTreeNode): Promise<void> {
  try {
    await deleteTwinScene(node.id);
    message.success($t('common.success'));
    emit('refresh');
  } catch (deleteError) {
    message.error(
      extractErrorMessage(deleteError, $t('page.iot.twin.deleteFailed')),
    );
  }
}

/**
 * 树节点点选：进入场景（不是展开）。
 *
 * @param _keys 选中的 key 列表（未使用）
 * @param info 节点信息
 */
function onSelect(
  _keys: (number | string)[],
  info: { node: { key: number | string } },
): void {
  emit('enter', String(info.node.key));
}

/**
 * 展开某节点。
 *
 * @param key 节点 key
 */
function expandNode(key: string): void {
  if (!expandedKeys.value.includes(key)) {
    expandedKeys.value = [...expandedKeys.value, key];
  }
}

defineExpose({ expandNode });
</script>

<template>
  <div class="flex h-full flex-col">
    <div
      class="flex items-center justify-between border-b border-border px-3 py-2"
    >
      <span class="text-sm font-medium">{{
        $t('page.iot.twin.sceneTree')
      }}</span>
      <Button v-if="canCreate" size="small" type="primary" @click="onCreateRoot">
        <Plus class="size-4" />
        {{ $t('common.create') }}
      </Button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-2">
      <Spin v-if="loading && tree.length === 0" />
      <Empty
        v-else-if="tree.length === 0"
        :description="$t('page.iot.twin.noScene')"
      />
      <Tree
        v-else
        v-model:expanded-keys="expandedKeys"
        :selected-keys="selectedKeys"
        :tree-data="treeData"
        block-node
        @select="onSelect"
      >
        <template #title="titleProps">
          <!--
            注意：这里**不能**用插值解构（`{ key, sceneCode, ...node }`）：
            解构后 `node` 会丢掉行内操作需要的业务字段（`id`/`pointCount` 等），
            且 Vue 模板解构不会生成新对象，`as unknown as SceneTreeNode` 会丢失字段。
            统一用 `titleProps` 取字段，类型安全且行为可预测。
          -->
          <div class="group flex items-center justify-between gap-1">
            <span class="flex min-w-0 items-center gap-1">
              <span class="truncate">
                {{ titleProps.sceneName }}（{{ titleProps.sceneCode }}）
              </span>
              <!--
                角标：点位数 + 告警数。**告警数只有当前场景有实时数据**，
                其它场景显示为空心点（未加载），绝不显示 0 —— 0 会被读成「没有告警」。
              -->
              <template
                v-if="badges && badges.get(String(titleProps.key))"
              >
                <span
                  v-if="badges.get(String(titleProps.key))!.pointCount > 0"
                  class="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground"
                  :title="
                    $t('page.iot.twin.badge.points', [
                      badges.get(String(titleProps.key))!.pointCount,
                    ])
                  "
                >
                  {{ badges.get(String(titleProps.key))!.pointCount }}
                </span>
                <span
                  v-if="
                    badges.get(String(titleProps.key))!.alerts !== undefined &&
                    badges.get(String(titleProps.key))!.alerts! > 0
                  "
                  class="shrink-0 rounded bg-destructive/15 px-1 text-[10px] text-destructive"
                  :title="
                    $t('page.iot.twin.badge.alerts', [
                      badges.get(String(titleProps.key))!.alerts!,
                    ])
                  "
                >
                  {{ badges.get(String(titleProps.key))!.alerts }}
                </span>
                <span
                  v-else-if="badges.get(String(titleProps.key))!.hasModel === false"
                  class="size-1.5 shrink-0 rounded-full border border-muted-foreground/50"
                  :title="$t('page.iot.twin.badge.noModel')"
                  aria-hidden="true"
                ></span>
              </template>
            </span>
            <span class="hidden shrink-0 gap-1 group-hover:flex">
              <Button
                v-if="canCreate"
                size="small"
                type="link"
                @click.stop="onCreateChild(titleProps as unknown as SceneTreeNode)"
              >
                {{ $t('common.create') }}
              </Button>
              <Button
                v-if="canUpdate"
                size="small"
                type="link"
                @click.stop="onEdit(titleProps as unknown as SceneTreeNode)"
              >
                {{ $t('common.edit') }}
              </Button>
              <Popconfirm
                v-if="canDelete"
                :title="
                  $t('ui.actionMessage.deleteConfirm', [
                    String(titleProps.sceneName ?? ''),
                  ])
                "
                @confirm="onDelete(titleProps as unknown as SceneTreeNode)"
              >
                <Button danger size="small" type="link">
                  {{ $t('common.delete') }}
                </Button>
              </Popconfirm>
            </span>
          </div>
        </template>
      </Tree>
    </div>

    <FormDrawer @success="emit('refresh')" />
  </div>
</template>
