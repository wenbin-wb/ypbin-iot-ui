<script lang="ts" setup>
import type { IotAlertApi } from '#/api/iot';

import { Alert, Space, Tag } from 'ant-design-vue';

import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';

import { isTenantContextError } from '../list-state';

/**
 * 告警列表页签的**表格之上**状态区（入口提示 / 摘要 / 实时断线 / 列表失败 / 租户上下文引导）。
 *
 * 从 `index.vue` 拆出的原因（拆分批次 5-D）：这五块全部是「只读状态展示 + 一个关闭动作」，
 * 与表格查询/守卫无关；留在页面里会把人推向「状态区与表格失败态混成一处」的误读
 * —— 而本页已经踩过「失败画成空态」的坑。
 *
 * 🔴 纪律：失败提示**必须挂在表格之外**（不只是 `#empty` 槽）：真实 vxe 只在表体无行时才渲染
 * 该槽 ⇒ 「已有数据后刷新失败」时槽不渲染、提示会消失、页面继续展示过期数据。
 */
withDefaults(
  defineProps<{
    /** 列表加载失败原因（后端 message 原样展示）。 */
    listError?: string;
    /** 从设备台账带过来的设备过滤（空串 = 无过滤）。 */
    presetDeviceId?: string;
    /** 入口提示里展示的设备名/ID。 */
    presetDeviceLabel?: string;
    /** 实时流断线提示（reconnecting 才 true）。 */
    realtimeDisconnected?: boolean;
    /** 最近一次实时连接错误（原样展示，不猜原因）。 */
    realtimeError?: string;
    /** 顶部计数（未加载/加载失败时为空）。 */
    summary?: IotAlertApi.SummaryResp;
    /** 摘要加载失败原因。 */
    summaryError?: string;
    /** 时间范围校验失败原因（起点晚于终点）：阻止查询的同时必须给出可见原因。 */
    timeRangeError?: string;
  }>(),
  {
    listError: '',
    presetDeviceId: '',
    presetDeviceLabel: '',
    realtimeDisconnected: false,
    realtimeError: '',
    summary: undefined,
    summaryError: '',
    timeRangeError: '',
  },
);

const emit = defineEmits<{ clearDeviceFilter: [] }>();
</script>

<template>
  <!-- 可关闭：否则用户无法在界面上解除「从设备台账带过来的设备过滤」（只能离开页面重进） -->
  <Alert
    v-if="presetDeviceId"
    class="mb-2"
    closable
    :message="$t('page.iot.alert.fromDeviceEntry', [presetDeviceLabel])"
    show-icon
    type="info"
    @close="emit('clearDeviceFilter')"
  />
  <Alert
    v-if="summaryError"
    class="mb-2"
    :description="summaryError"
    :message="$t('page.iot.alert.summaryLoadFailed')"
    show-icon
    type="error"
  />
  <div v-else-if="summary" class="mb-2 text-sm">
    <Space>
      <Tag color="error">
        {{
          $t('page.iot.alert.summaryActive', [
            toBackendNumber(summary.activeCount),
          ])
        }}
      </Tag>
      <Tag color="warning">
        {{
          $t('page.iot.alert.summaryCritical', [
            toBackendNumber(summary.criticalCount),
          ])
        }}
      </Tag>
      <Tag color="processing">
        {{
          $t('page.iot.alert.summaryAcked', [
            toBackendNumber(summary.ackedCount),
          ])
        }}
      </Tag>
      <Tag color="success">
        {{
          $t('page.iot.alert.summaryResolved24h', [
            toBackendNumber(summary.resolvedLast24h),
          ])
        }}
      </Tag>
    </Space>
  </div>

  <!--
    实时流断线必须可见（不阻塞页面）：标题 + 最近错误原因都在，
    避免用户以为页面数据仍是实时的。
  -->
  <Alert
    v-if="realtimeDisconnected"
    class="mb-2"
    :description="
      $t('page.iot.realtime.disconnectedHint', [realtimeError || '-'])
    "
    :message="$t('page.iot.realtime.disconnected')"
    show-icon
    type="warning"
  />
  <!--
    「首次越界时间」非法（起点 > 终点）：查询被表单校验拦下时，屏幕上看不到任何变化，
    必须显式说明原因（compact 表单的错误气泡只在字段旁 hover 才可见）。
  -->
  <Alert
    v-if="timeRangeError"
    class="mb-2"
    data-testid="time-range-error"
    :message="timeRangeError"
    show-icon
    type="error"
  />
  <Alert
    v-if="listError"
    class="mb-2"
    :description="listError"
    :message="$t('page.iot.alert.listLoadFailed')"
    show-icon
    type="error"
  />
  <!-- 失败若是「没有租户上下文」⇒ 给一条能照着做的引导（不弹原始码、不只是报错） -->
  <Alert
    v-if="isTenantContextError(listError)"
    class="mb-2"
    :message="$t('page.iot.alert.noTenantHint')"
    show-icon
    type="warning"
  />
</template>
