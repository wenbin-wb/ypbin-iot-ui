<script lang="ts" setup>
import { computed, ref, watch } from 'vue';

import { useAccess } from '@vben/access';
import { Plus } from '@vben/icons';

import {
  Button,
  Empty,
  message,
  Popconfirm,
  Spin,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import { deleteTwinPoint, IotTwinApi } from '#/api/iot';
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
  /** 画布拾取到的预填坐标（「放置锚点」流程）。 */
  pickedAnchor?: {
    local: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
  };
  /**
   * 拾取草稿表单是否应打开。
   *
   * 由父组件（编辑器状态机）决定：拾取成功 ⇒ true；用户取消 ⇒ false。
   * 本组件不自己推断，避免与状态机产生两套真相。
   */
  placeFormOpen: boolean;
  /** 是否处于「放置锚点」模式（画布接受表面点击）。 */
  placing: boolean;
  /** 点位列表。 */
  points: IotTwinApi.PointResp[];
  /** 当前场景 id。 */
  sceneId: string;
}>();

const emit = defineEmits<{
  /** 取消放置模式。 */
  cancelPlacing: [];
  /** 点位表单已关闭（清掉拾取预填）。 */
  dismissPlace: [];
  /** 打开设备详情（运行态下钻，工单 #127）。 */
  openDevice: [pointId: string];
  /** 点位变更（保存/删除后刷新）。 */
  refresh: [];
  /** 选中某个点位。 */
  select: [pointId: string];
  /** 进入放置锚点模式。 */
  startPlacing: [];
}>();

const { hasAccessByCodes } = useAccess();
const canCreate = computed(() => hasAccessByCodes(['iot:twin:create']));
const canUpdate = computed(() => hasAccessByCodes(['iot:twin:update']));
const canDelete = computed(() => hasAccessByCodes(['iot:twin:delete']));

/** 表单显隐与编辑对象。 */
const formOpen = ref(false);
const formPoint = ref<IotTwinApi.PointResp | undefined>(undefined);

/**
 * 拾取预填是否已消费。
 *
 * 消费后置 true：用户关掉表单再点「新增」时不该再带上一次的拾取坐标
 * （那会让用户以为坐标被记住了）。
 */
const pickedConsumed = ref(false);

/** 有效预填坐标（已消费则为 undefined）。 */
const effectivePicked = computed(() =>
  pickedConsumed.value ? undefined : props.pickedAnchor,
);

/** 每个点位的失效绑定数（> 0 时标红提示）。 */
/**
 * 是否已达单场景点位上���（工单 #128）。
 *
 * 后端有同样的硬上限，但**前端必须先拦**：让用户填完表单、提交后才被后端拒绝，
 * 是最差的体验；而且后端错误文案与前端其它校验风格不一致。
 */
const pointLimitReached = computed(
  () => props.points.length >= IotTwinApi.TWIN_LIMITS.maxPointsPerScene,
);

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
  pickedConsumed.value = true;
  formOpen.value = true;
}

/**
 * 编辑点位。
 *
 * @param point 点位
 */
function onEdit(point: IotTwinApi.PointResp): void {
  formPoint.value = point;
  pickedConsumed.value = true;
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

/** 拾取到新位置 ⇒ 自动打开表单（用户刚在画布上点了一下，立刻能填设备）。 */
watch(
  () => props.placeFormOpen,
  (open) => {
    if (!open) {
      return;
    }
    formPoint.value = undefined;
    pickedConsumed.value = false;
    formOpen.value = true;
  },
);

/**
 * 表单关闭。
 *
 * 放置流程下关闭表单要回到「继续选点」而不是退出放置模式 ——
 * 用户常常点偏了要重新点，直接退出会让他每次都要再点一次按钮。
 */
function onFormClose(): void {
  formOpen.value = false;
  // 拾取草稿已消费（或用户主动关掉），通知状态机收起表单标志
  emit('dismissPlace');
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
      <div v-if="canCreate" class="flex items-center gap-1">
        <!-- 「放置锚点」是在 3D 里点位置（比手填坐标直观得多），与「新增」并列 -->
        <Button
          v-if="!placing"
          :disabled="!sceneId || pointLimitReached"
          size="small"
          @click="emit('startPlacing')"
        >
          {{ $t('page.iot.twin.placeAnchor') }}
        </Button>
        <Button v-else danger size="small" @click="emit('cancelPlacing')">
          {{ $t('page.iot.twin.cancelPlace') }}
        </Button>
        <Tooltip
          :title="
            pointLimitReached
              ? $t('page.iot.twin.pointLimitReached', [
                  IotTwinApi.TWIN_LIMITS.maxPointsPerScene,
                ])
              : ''
          "
        >
          <Button
            :disabled="!sceneId || pointLimitReached"
            size="small"
            type="primary"
            @click="onCreate"
          >
            <Plus class="size-4" />
            {{ $t('common.create') }}
          </Button>
        </Tooltip>
      </div>
    </div>

    <ListErrorAlert
      v-if="error"
      :error="error"
      :retry-text="$t('page.iot.twin.retry')"
      :title="$t('page.iot.twin.pointLoadFailed')"
      @retry="emit('refresh')"
    />

    <!-- 放置模式提示：告诉用户「去画布点一下」，否则用户不知道该做什么 -->
    <div
      v-if="placing"
      class="mx-2 mt-2 rounded border border-primary/40 bg-primary/5 px-2 py-1 text-xs text-primary"
    >
      {{ $t('page.iot.twin.clickSurfaceHint') }}
    </div>

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
          :data-twin-point-row="point.id"
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
            <!--
              操作区必须 shrink-0 且不换行：此前未给 shrink-0 时，窄屏（1600 宽 + 右栏 320px）
              下三个 type="link" 按钮被 flex 压成三行竖排（实测截图），把行高撑到 3 倍。
            -->
            <div class="flex shrink-0 items-center gap-1">
              <!-- 运行态下钻：从锚点直接跳到设备详情（工单 #127） -->
              <Button
                size="small"
                type="link"
                @click.stop="emit('openDevice', point.id)"
              >
                {{ $t('page.iot.twin.openDevice') }}
              </Button>
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
      :picked-anchor="effectivePicked"
      :point="formPoint"
      :scene-id="sceneId"
      @close="onFormClose"
      @success="onFormSuccess"
    />
  </div>
</template>
