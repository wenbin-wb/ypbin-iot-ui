<script lang="ts" setup>
import type { IotAlertApi } from '#/api/iot';

import { Tag } from 'ant-design-vue';

import { $t } from '#/locales';

import { formatDateTime } from '../../shared/display';
import { channelLabel } from '../channel';
import {
  eventLabelKey,
  notifyStatusLabelKey,
  reasonLabelKey,
  stateColor,
  stateLabelKey,
} from '../data';
import InstanceCurve from './instance-curve.vue';

/**
 * 告警实例的**展开行**内容（触发值 / 阈值 / 时间线 / 投递记录 / 该点位近期曲线缩略）。
 *
 * 从 `index.vue` 拆出的原因（拆分批次 5-D）：约 100 行纯只读渲染，输入只有一个 `row`；
 * 它此前夹在 `<InstanceGrid>` 的 slot 里，是页面模板最长的一段，且与表格接线（勾选/分页/守卫）
 * 毫无关系。抽成组件后，页面模板的 slot 只剩一行，展开内容可以单独加用例。
 *
 * 纪律：这里全部是**原样展示**（后端 message/字段不翻译成「更友好的说法」），
 * 码值→文案统一走 `../data` 的映射函数，未知码保留原码（不伪造已知值）。
 */
defineProps<{ row: IotAlertApi.InstanceResp }>();
</script>

<template>
  <div class="grid grid-cols-1 gap-4 p-2 text-sm sm:grid-cols-2 md:grid-cols-3">
    <div class="space-y-1">
      <div>
        <span class="text-muted-foreground">
          {{ $t('page.iot.alert.triggerValue') }}:
        </span>
        <span class="font-medium">{{ row.triggerValue ?? '-' }}</span>
      </div>
      <div>
        <span class="text-muted-foreground">
          {{ $t('page.iot.alert.threshold') }}:
        </span>
        <span class="font-medium">{{ row.thresholdSnapshot ?? '-' }}</span>
      </div>
      <div>
        <span class="text-muted-foreground">
          {{ $t('page.iot.alert.stateField') }}:
        </span>
        <Tag :color="stateColor(row.state)">
          {{ $t(stateLabelKey(row.state)) }}
        </Tag>
      </div>
    </div>
    <div class="space-y-1">
      <div>
        {{ $t('page.iot.alert.startTs') }}:
        {{ formatDateTime(row.startTs) }}
      </div>
      <div>
        {{ $t('page.iot.alert.firingTs') }}:
        {{ formatDateTime(row.firingTs) }}
      </div>
      <div>
        {{ $t('page.iot.alert.resolvedTs') }}:
        {{ formatDateTime(row.resolvedTs) }}
      </div>
      <div v-if="row.reason">
        {{ $t('page.iot.alert.reasonField') }}:
        {{ $t(reasonLabelKey(row.reason)) }}
      </div>
      <div v-if="row.silenceUntil">
        {{ $t('page.iot.alert.silenceUntil') }}:
        {{ formatDateTime(row.silenceUntil) }}
      </div>
    </div>
    <div>
      <div class="mb-1 text-muted-foreground">
        {{ $t('page.iot.alert.curve.title') }}
      </div>
      <InstanceCurve
        :device-id="row.deviceId"
        :property-id="row.propertyId"
        :threshold-snapshot="row.thresholdSnapshot"
      />
    </div>
  </div>
  <div class="p-2 text-sm">
    <div class="mb-1 text-muted-foreground">
      {{ $t('page.iot.alert.notify.title') }}
      ({{ row.notifyCount ?? 0 }})
    </div>
    <div
      v-if="(row.notifications?.length ?? 0) === 0"
      class="text-xs text-muted-foreground"
    >
      {{ $t('page.iot.alert.notify.none') }}
    </div>
    <table v-else class="w-full text-xs">
      <thead>
        <tr class="text-left text-muted-foreground">
          <th>{{ $t('page.iot.alert.notify.channel') }}</th>
          <th>{{ $t('page.iot.alert.notify.target') }}</th>
          <th>{{ $t('page.iot.alert.notify.event') }}</th>
          <th>{{ $t('page.iot.alert.notify.status') }}</th>
          <th>{{ $t('page.iot.alert.notify.attempt') }}</th>
          <th>{{ $t('page.iot.alert.notify.error') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="record in row.notifications" :key="record.id">
          <td>{{ channelLabel(record.channel) }}</td>
          <td>{{ record.target || '-' }}</td>
          <td>{{ $t(eventLabelKey(record.event)) }}</td>
          <td>{{ $t(notifyStatusLabelKey(record.notifyStatus)) }}</td>
          <td>{{ record.attempt ?? 0 }}</td>
          <td class="break-all text-destructive-text">
            {{ record.lastError || '-' }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
