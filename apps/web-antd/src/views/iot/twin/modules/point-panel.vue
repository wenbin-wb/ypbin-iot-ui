<script lang="ts" setup>
import type { IotTwinApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';
import { Plus } from '@vben/icons';

import { Button, Empty, message, Popconfirm, Spin, Tag } from 'ant-design-vue';

import { deleteTwinPoint } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import ListErrorAlert from '../../shared/list-error-alert.vue';
import PointForm from './point-form.vue';

/**
 * 当前场景的点位列表（含失效绑定提示）。
 *
 * ## 为什么列表里必须显示 `stale` 绑定
 *
 * 绑定指向的属性会被 TSL 重新导入**物理删除**。若列表静默隐藏失效绑定，用户看到的是
 * 「这个点位配了 3 个属性」但运行态只显示 2 个值，且无从知道第 3 个去哪了。
 * 这里把它标红并在 tooltip 里说明「请重新选择属性」。
 */
const props = defineProps<{
  /** 当前正在编辑的点位 id（高亮用）。 */
  editingPointId: null | string;
  /** 加载失败原因（空串 = 无错）。 */
  error: string;
  /** 加载中。 */
  loading: boolean;
  /** 是否有未保存的草稿。 */
  pending: boolean;
  /** 点位列表。 */
  points: IotTwinApi.PointResp[];
  /** 当前场景 id。 */
  sceneId: string;
}>();

const emit = defineEmits<{
  /** 点位变更（保存/删除后刷新）。 */
  refresh: [];
  /** 选中某个点位。 */
  select: [pointId: string];
}>();

const { hasAccessByCodes } = useAccess();
const canCreate = computed(() => hasAccessByCodes(['iot:twin:create']));
const canUpdate = computed(() => hasAccessByCodes(['iot:twin:update']));
const canDelete = computed(() => hasAccessByCodes(['iot:twin:delete']));

/** 表单显隐与编辑对象。 */
const formOpen = ref(false);
const formPoint = ref<IotTwinApi.PointResp | undefined>(undefined);

/** 每个点位的失效绑定数（> 0 时标红提示）。 */
const staleCountByPoint = computed(() => {
  const map = new Map<string, number>();
  for (const point of props.points) {
    const count = point.bindings.filter((binding) => binding.stale).length;
    if (count > 0) {
      map.set(point.id, count);
    }
  }
  return map;
});

/** 新增点位。 */
function onCreate(): void {
  formPoint.value = undefined;
  formOpen.value = true;
}

/**
 * 编辑点位。
 *
 * @param point 点位
 */
function onEdit(point: IotTwinApi.PointResp): void {
  formPoint.value = point;
  formOpen.value = true;
}

/**
 * 删除点位（连同其绑定）。
 *
 * @param point 点位
 */
async function onDelete(point: IotTwinApi.PointResp): Promise<void> {
  try {
    await deleteTwinPoint(props.sceneId, point.id);
    message.success($t('common.success'));
    emit('refresh');
  } catch (deleteError) {
    message.error(
      extractErrorMessage(deleteError, $t('page.iot.twin.pointDeleteFailed')),
    );
  }
}

/** 表单保存成功。 */
function onFormSuccess(): void {
  formOpen.value = false;
  formPoint.value = undefined;
  emit('refresh');
}

/**
 * 主展示属性的展示文本（`温度 ℃` 形式；无绑定时给明确文案而不是空白）。
 *
 * @param point 点位
 * @returns 展示文本
 */
function primaryText(point: IotTwinApi.PointResp): string {
  const primary =
    point.bindings.find((binding) => binding.displayRole === 'primary') ??
    point.bindings[0];
  if (!primary) {
    return $t('page.iot.twin.noBinding');
  }
  const unit = primary.unit ? ` ${primary.unit}` : '';
  return `${primary.propertyName}${unit}`;
}
</script>

<template>
  <div class="flex h-full flex-col rounded-lg border border-border">
    <div
      class="flex items-center justify-between border-b border-border px-3 py-2"
    >
      <span class="text-sm font-medium">
        {{ $t('page.iot.twin.pointList') }}
        <span class="text-muted-foreground">（{{ points.length }}）</span>
      </span>
      <Button
        v-if="canCreate"
        :disabled="!sceneId"
        size="small"
        type="primary"
        @click="onCreate"
      >
        <Plus class="size-4" />
        {{ $t('common.create') }}
      </Button>
    </div>

    <ListErrorAlert
      v-if="error"
      :message="error"
      :title="$t('page.iot.twin.pointLoadFailed')"
    />

    <div class="min-h-0 flex-1 overflow-auto p-2">
      <Spin v-if="loading" />
      <Empty
        v-else-if="points.length === 0"
        :description="$t('page.iot.twin.noPoint')"
      />
      <ul v-else class="space-y-2">
        <li
          v-for="point in points"
          :key="point.id"
          class="cursor-pointer rounded border border-border p-2 text-xs hover:border-primary"
          :class="{ 'border-primary': point.id === editingPointId }"
          @click="emit('select', point.id)"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">
                {{ point.deviceIdName ?? point.deviceId }}
              </div>
              <div class="mt-1 truncate text-muted-foreground">
                {{ primaryText(point) }}
              </div>
              <div class="mt-1 flex flex-wrap gap-1">
                <Tag v-if="point.bindings.length > 1">
                  +{{ point.bindings.length - 1 }}
                </Tag>
                <Tag v-if="point.nodeName" color="blue">
                  {{ point.nodeName }}
                </Tag>
                <Tag
                  v-if="staleCountByPoint.get(point.id)"
                  color="red"
                  :title="$t('page.iot.twin.staleBindingHint')"
                >
                  {{
                    $t('page.iot.twin.staleCount', [
                      staleCountByPoint.get(point.id) ?? 0,
                    ])
                  }}
                </Tag>
              </div>
            </div>
            <div class="flex shrink-0 flex-col gap-1">
              <Button
                v-if="canUpdate"
                size="small"
                type="link"
                @click.stop="onEdit(point)"
              >
                {{ $t('common.edit') }}
              </Button>
              <Popconfirm
                v-if="canDelete"
                :title="
                  $t('ui.actionMessage.deleteConfirm', [
                    point.deviceIdName ?? point.deviceId,
                  ])
                "
                @confirm="onDelete(point)"
              >
                <Button danger size="small" type="link" @click.stop>
                  {{ $t('common.delete') }}
                </Button>
              </Popconfirm>
            </div>
          </div>
        </li>
      </ul>
    </div>

    <PointForm
      v-if="formOpen"
      :point="formPoint"
      :scene-id="sceneId"
      @close="formOpen = false"
      @success="onFormSuccess"
    />
  </div>
</template>
