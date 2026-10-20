<script lang="ts" setup>
import type { IotDeviceApi } from '#/api/iot';

import { computed } from 'vue';

import { Descriptions, DescriptionsItem, Tag, Tooltip } from 'ant-design-vue';

import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';

import CopyText from '../../shared/copy-text.vue';
import {
  EMPTY_TEXT,
  formatDateTime,
  formatRelativeTime,
  onlineStatusColor,
  onlineStatusLabel,
  protocolLabel,
} from '../../shared/display';
/**
 * 概览 · 设备档案卡（基本信息 9 字段）。
 *
 * 只承载只读档案信息：标签/凭据是**独立的两卡并排网格**，仍留在 detail.vue 的概览容器里，
 * 不并入本卡——否则会改变该网格的直系子项/区块顺序（视觉契约必须零漂移）。
 * 卡片自身无状态，`device/productName` 由父组件透传。
 * 布局契约：基本信息 `:column="{ sm: 1, md: 2, xl: 3 }"`。
 */
const props = defineProps<{
  /** 设备台账行（详情抽屉的数据源）。 */
  device?: IotDeviceApi.DeviceResp;
  /** 产品名（解析失败时父组件传空，模板回落显示产品 id）。 */
  productName?: string;
}>();

/**
 * 启停位是否为「启用」。
 *
 * 判据与列表页一致：只有显式等于 1 才算启用，`null/undefined` 按启用处理（与 DB 默认值对齐）。
 * 口径只写在这一处，不在模板里内联比较裸数字。
 */
const isDeviceEnabled = computed(
  () => toBackendNumber(props.device?.status ?? 1) === 1,
);
</script>

<template>
  <!-- 基本信息：编码/名称/产品/协议/端点/启停/在线/最近在线/备注 -->
  <section
    class="rounded-xl border border-border/80 bg-card p-4"
    data-section="overview-basic"
  >
    <h3 class="mb-3 text-sm font-semibold">
      {{ $t('page.iot.device.basicInfo') }}
    </h3>
    <Descriptions :column="{ sm: 1, md: 2, xl: 3 }" bordered size="small">
      <DescriptionsItem :label="$t('page.iot.device.code')">
        <CopyText :value="device?.deviceCode" />
      </DescriptionsItem>
      <DescriptionsItem :label="$t('page.iot.device.name')">
        {{ device?.deviceName ?? EMPTY_TEXT }}
      </DescriptionsItem>
      <DescriptionsItem :label="$t('page.iot.device.product')">
        <template v-if="device?.productId">
          {{ productName || device?.productId }}
          <span v-if="device?.productVersion" class="text-muted-foreground">
            （{{ device?.productVersion }}）
          </span>
        </template>
        <template v-else>
          <span class="text-warning-text">
            {{ $t('page.iot.device.noProduct') }}
          </span>
        </template>
      </DescriptionsItem>
      <DescriptionsItem :label="$t('page.iot.device.protocol')">
        {{ protocolLabel(device?.protocol) }}
      </DescriptionsItem>
      <DescriptionsItem :label="$t('page.iot.device.endpoint')">
        <CopyText :value="device?.endpoint" :wrap="true" />
      </DescriptionsItem>
      <!--
        启停位：与在线状态相邻但语义不同——
        「在线状态」是设备现在连没连上的**观测值**，本行是运维**意图**；
        停用后接入侧会解绑并撤销点位订阅 ⇒ 采集停止，故给出后果说明。
      -->
      <DescriptionsItem :label="$t('page.iot.device.status')">
        <Tag :color="isDeviceEnabled ? 'success' : 'default'">
          {{
            isDeviceEnabled
              ? $t('page.iot.device.enabled')
              : $t('page.iot.device.disabled')
          }}
        </Tag>
        <span v-if="!isDeviceEnabled" class="ml-2 text-warning-text">
          {{ $t('page.iot.device.statusHint') }}
        </span>
      </DescriptionsItem>
      <DescriptionsItem :label="$t('page.iot.device.onlineStatus')">
        <Tag :color="onlineStatusColor(device?.onlineStatus)">
          {{ onlineStatusLabel(device?.onlineStatus) }}
        </Tag>
      </DescriptionsItem>
      <DescriptionsItem :label="$t('page.iot.device.lastSeenAt')">
        <!-- 绝对时间为主、相对时间为辅：只看「3 分钟前」判断不了跨天/时钟口径 -->
        <Tooltip :title="formatRelativeTime(device?.lastSeenAt)">
          {{ formatDateTime(device?.lastSeenAt) }}
        </Tooltip>
      </DescriptionsItem>
      <DescriptionsItem :label="$t('page.iot.device.remark')">
        {{ device?.remark || EMPTY_TEXT }}
      </DescriptionsItem>
    </Descriptions>
  </section>
</template>
