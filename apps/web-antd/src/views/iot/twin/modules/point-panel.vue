<script lang="ts" setup>
import { computed, ref, watch } from 'vue';

import { useAccess } from '@vben/access';
import { IconifyIcon, Plus } from '@vben/icons';

import {
  Button,
  Empty,
  message,
  Popconfirm,
  Spin,
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
            :aria-label="$t('common.create')"
            :disabled="!sceneId || pointLimitReached"
            :title="$t('common.create')"
            size="small"
            type="primary"
            @click="onCreate"
          >
            <Plus class="size-3.5" />
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
      <!--
        紧凑列表（本轮布局改版）：
        · 每行主信息 = 设备名 +「主属性 · 当前值」一行，次信息（节点名/Tag）降为小字；
        · 三个文字按钮改为 **hover/选中才出现** 的图标操作 —— 常态下每行只有一个信息块，
          视觉噪声从「一屏 18 个按钮」降到 0（可用性靠 hover + 键盘 Tab 保证）；
        · 选中行用左侧色条 + 轻底色标识，不再用粗边框（边框会与卡片边界打架）。
      -->
      <ul v-else class="space-y-0.5">
        <li
          v-for="point in points"
          :key="point.id"
          :data-twin-point-row="point.id"
          class="group relative cursor-pointer rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/50"
          :class="{ 'bg-muted/60': point.id === editingPointId }"
          @click="emit('select', point.id)"
        >
          <span
            v-if="point.id === editingPointId"
            class="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary"
            aria-hidden="true"
          ></span>
          <div class="flex items-center gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate font-medium">
                  {{ point.deviceIdName ?? point.deviceId }}
                </span>
                <span
                  v-if="staleCountByPoint.get(point.id)"
                  class="size-1.5 shrink-0 rounded-full bg-destructive"
                  :title="$t('page.iot.twin.staleBindingHint')"
                ></span>
              </div>
              <div
                class="mt-0.5 flex items-center gap-1 truncate text-muted-foreground"
              >
                <span class="truncate">{{ primaryText(point) }}</span>
                <span
                  v-if="point.bindings.length > 1"
                  class="shrink-0 text-[10px] opacity-70"
                >
                  +{{ point.bindings.length - 1 }}
                </span>
                <span
                  v-if="point.nodeName"
                  class="shrink-0 truncate text-[10px] opacity-60"
                >
                  · {{ point.nodeName }}
                </span>
              </div>
            </div>
            <!-- 操作：默认隐藏，hover/键盘聚焦时出现；图标按钮带 aria-label -->
            <div
              class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
            >
              <Button
                :aria-label="$t('page.iot.twin.openDevice')"
                :title="$t('page.iot.twin.openDevice')"
                size="small"
                type="text"
                @click.stop="emit('openDevice', point.id)"
              >
                <IconifyIcon class="size-3.5" icon="lucide:external-link" />
              </Button>
              <Button
                v-if="canUpdate"
                :aria-label="$t('common.edit')"
                :title="$t('common.edit')"
                size="small"
                type="text"
                @click.stop="onEdit(point)"
              >
                <IconifyIcon class="size-3.5" icon="lucide:pencil" />
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
                <Button
                  :aria-label="$t('common.delete')"
                  :title="$t('common.delete')"
                  danger
                  size="small"
                  type="text"
                  @click.stop
                >
                  <IconifyIcon class="size-3.5" icon="lucide:trash-2" />
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
