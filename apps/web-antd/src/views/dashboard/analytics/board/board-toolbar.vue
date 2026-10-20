<script lang="ts" setup>
import type { BoardConfigSource } from './board-utils';

import type { RealtimeConnectionState } from '#/api/iot/realtime';

import { Plus } from '@vben/icons';

import { Alert, Button, Tag, Tooltip } from 'ant-design-vue';

import { $t } from '#/locales';

/**
 * 看板工具栏 + 顶部提示区（从 board-drawer.vue 抽出，纯展示：不改数据、只 emit 动作）。
 *
 * 为什么单独拆：抽屉宿主此前把「3 个按钮 + 6 条 Alert」和拖拽/实时/持久化混在一个文件里，
 * 700 行里近 100 行是这块纯展示模板。拆出后宿主只负责装配，模板结构也更容易和
 * 其它页面的「提示区」对齐。
 *
 * 口径（与抽出前一致）：
 * - 保存按钮在空看板时禁用，且**必须说明原因**（禁用按钮不触发 mouseenter，用外层 span 承接 Tooltip）；
 * - 「本地草稿」「坏配置被重置」「保存失败」「设备列表失败」「部分序列失败」「实时断线」
 *   六条提示都常驻可见，**不静默降级**，可关闭的只让用户关辅助信息。
 */
withDefaults(
  defineProps<{
    /** 本地配置损坏被重置（需让用户知道旧布局为什么没了）。 */
    configInvalid?: boolean;
    /** 设备列表加载失败原因（展示增强失败，不阻塞看板）。 */
    deviceOptionsError?: string;
    /** 是否处于「本地草稿（未同步到平台）」状态。 */
    isLocalDraft?: boolean;
    /** 刷新按钮 loading。 */
    loading?: boolean;
    /** 实时连接错误原文（断线提示的 description）。 */
    realtimeError?: string;
    /** 实时连接状态。 */
    realtimeState?: RealtimeConnectionState;
    /** 实时状态徽标（颜色 + 文案）。 */
    realtimeTag?: { color: string; text: string };
    /** 最近一次保存/存储失败原因。 */
    saveError?: string;
    /** 保存按钮 loading。 */
    saving?: boolean;
    /** 部分点位历史读取失败的原因。 */
    seriesWarning?: string;
    /** 配置来源：平台 / 本地草稿 / 空。 */
    source?: BoardConfigSource;
    /** 当前组件数量（决定保存是否可用、是否显示「已同步平台」徽标）。 */
    widgetCount?: number;
  }>(),
  {
    configInvalid: false,
    deviceOptionsError: '',
    isLocalDraft: false,
    loading: false,
    realtimeError: '',
    realtimeState: 'closed',
    realtimeTag: () => ({ color: 'default', text: '' }),
    saveError: '',
    saving: false,
    seriesWarning: '',
    source: 'empty',
    widgetCount: 0,
  },
);

/** 六个动作都无载荷，合成一条签名（拆成六条会被 oxlint 的 unified-signatures 判错）。 */
const emit = defineEmits<{
  (
    e:
      | 'add'
      | 'closeConfigInvalid'
      | 'closeSaveError'
      | 'closeSeriesWarning'
      | 'refresh'
      | 'save',
  ): void;
}>();
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="text-sm text-muted-foreground">
      {{ $t('page.iot.board.desc') }}
    </p>
    <div class="flex flex-wrap items-center gap-2">
      <Tag :color="realtimeTag.color">{{ realtimeTag.text }}</Tag>
      <Tag v-if="source === 'platform'" color="success">
        {{ $t('page.iot.board.sourcePlatform') }}
      </Tag>
      <Tag v-else-if="isLocalDraft" color="warning">
        {{ $t('page.iot.board.sourceLocalDraft') }}
      </Tag>
      <Button :loading="loading" size="small" @click="emit('refresh')">
        {{ $t('page.iot.board.refresh') }}
      </Button>
      <!--
        空看板时「保存到平台」禁用：必须说明原因，否则用户会误以为是权限或网络问题。
        禁用按钮不触发 mouseenter，故用外层 span 承接 Tooltip。
      -->
      <Tooltip
        :title="
          widgetCount === 0
            ? $t('page.iot.board.empty')
            : $t('page.iot.board.saveToPlatform')
        "
      >
        <span class="inline-flex">
          <Button
            :disabled="widgetCount === 0"
            :loading="saving"
            @click="emit('save')"
          >
            {{ $t('page.iot.board.saveToPlatform') }}
          </Button>
        </span>
      </Tooltip>
      <Button type="primary" @click="emit('add')">
        <Plus class="size-4" />
        {{ $t('page.iot.board.addWidget') }}
      </Button>
    </div>
  </div>

  <!-- 本地草稿（未同步到平台）：必须如实标注，不让用户以为已经共享 -->
  <Alert
    v-if="isLocalDraft"
    show-icon
    type="warning"
    :message="$t('page.iot.board.localDraftNotice')"
  />
  <!-- 坏配置被重置：必须让用户知道旧布局为什么没了 -->
  <Alert
    v-if="configInvalid"
    closable
    show-icon
    type="warning"
    :message="$t('page.iot.board.configInvalid')"
    @close="emit('closeConfigInvalid')"
  />
  <Alert
    v-if="saveError"
    closable
    show-icon
    type="warning"
    :message="saveError"
    @close="emit('closeSaveError')"
  />
  <Alert
    v-if="deviceOptionsError"
    show-icon
    type="warning"
    :message="deviceOptionsError"
  />
  <Alert
    v-if="seriesWarning"
    closable
    show-icon
    type="warning"
    :message="seriesWarning"
    @close="emit('closeSeriesWarning')"
  />
  <!-- 断线必须可见：Tag 变黄 + 原因 Alert，不得让看板静止而用户以为设备没上报 -->
  <Alert
    v-if="realtimeState === 'reconnecting'"
    show-icon
    type="warning"
    :description="realtimeError || undefined"
    :message="$t('page.iot.board.realtimeReconnectingDesc')"
  />
</template>
