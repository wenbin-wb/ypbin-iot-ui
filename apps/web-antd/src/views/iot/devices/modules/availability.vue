<script lang="ts" setup>
import type { IotAvailabilityApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import { Descriptions, DescriptionsItem, Empty, Spin, Tag } from 'ant-design-vue';

import { getDeviceAvailability } from '#/api/iot';
import { $t } from '#/locales';

const loading = ref(false);
const data = ref<IotAvailabilityApi.AvailabilityResp>();

const [Drawer, drawerApi] = useVbenDrawer({
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      return;
    }
    const device = drawerApi.getData<{ deviceName?: string; id: string }>();
    drawerApi.setState({
      title: $t('iot.availability.title', [device?.deviceName ?? device?.id ?? '']),
    });
    loading.value = true;
    data.value = undefined;
    try {
      data.value = await getDeviceAvailability(device?.id ?? '');
    } finally {
      loading.value = false;
    }
  },
});

/** 后端 Long/BigDecimal 序列化为字符串 ⇒ 展示前统一转数字（保留 2 位）。 */
function num(value?: number | string): string {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? String(value) : parsed.toFixed(2);
}

/** 秒 → 可读时长。 */
function human(seconds?: number | string): string {
  const value = Number(seconds ?? 0);
  if (Number.isNaN(value) || value <= 0) {
    return '0s';
  }
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.round(value % 60);
  return [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : '', `${s}s`]
    .filter(Boolean)
    .join('');
}

const availability = computed(() => num(data.value?.availability));
const meets = computed(() => data.value?.meetsTarget === true);
</script>
<template>
  <Drawer class="w-[720px]">
    <Spin :spinning="loading">
      <template v-if="data">
        <Descriptions :column="2" bordered size="small">
          <DescriptionsItem :label="$t('iot.availability.window')">
            {{ data.from }} ~ {{ data.to }}
          </DescriptionsItem>
          <DescriptionsItem :label="$t('iot.availability.availability')">
            <span class="text-lg font-semibold">{{ availability }}</span>
            <Tag :color="meets ? 'success' : 'error'" class="ml-2">
              {{
                meets
                  ? $t('iot.availability.meetsTarget')
                  : $t('iot.availability.notMeetsTarget')
              }}
            </Tag>
          </DescriptionsItem>
          <DescriptionsItem :label="$t('iot.availability.effectiveWindow')">
            {{ human(data.effectiveWindowSeconds) }}
            <span class="text-gray-400"
              >（{{ $t('iot.availability.window') }}：{{
                human(data.windowSeconds)
              }}）</span
            >
          </DescriptionsItem>
          <DescriptionsItem :label="$t('iot.availability.maintenanceSeconds')">
            {{ human(data.maintenanceSeconds) }}
            <span class="text-gray-400"
              >（{{ $t('iot.availability.outageInMaintenance') }}：{{
                human(data.outageInMaintenanceSeconds)
              }}）</span
            >
          </DescriptionsItem>
          <DescriptionsItem :label="$t('iot.availability.outageSeconds')">
            {{ human(data.outageSeconds) }}
          </DescriptionsItem>
          <DescriptionsItem :label="$t('iot.availability.longestOutage')">
            {{ human(data.longestOutageSeconds) }}
            <span class="text-gray-400"
              >（{{ $t('iot.availability.outageCount') }}：{{
                data.outageCount
              }}）</span
            >
          </DescriptionsItem>
        </Descriptions>

        <div class="mt-4 mb-2 font-semibold">
          {{ $t('iot.availability.outages') }}
        </div>
        <Empty v-if="!data.outages?.length" :description="$t('iot.availability.noOutage')" />
        <table v-else class="w-full text-sm">
          <thead>
            <tr class="text-left text-gray-500">
              <th class="py-1">{{ $t('iot.availability.start') }}</th>
              <th class="py-1">{{ $t('iot.availability.end') }}</th>
              <th class="py-1">{{ $t('iot.availability.duration') }}</th>
              <th class="py-1">{{ $t('iot.availability.reason') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in data.outages" :key="row.id" class="border-t">
              <td class="py-1">{{ row.startTs }}</td>
              <td class="py-1">{{ row.endTs || $t('iot.availability.ongoing') }}</td>
              <td class="py-1">{{ human(row.durationSec) }}</td>
              <td class="py-1">{{ row.reason }}</td>
            </tr>
          </tbody>
        </table>

        <div class="mt-4 mb-2 font-semibold">
          {{ $t('iot.maintenance.title') }}
        </div>
        <Empty
          v-if="!data.maintenanceWindows?.length"
          :description="$t('iot.maintenance.empty')"
        />
        <table v-else class="w-full text-sm">
          <thead>
            <tr class="text-left text-gray-500">
              <th class="py-1">{{ $t('iot.maintenance.start') }}</th>
              <th class="py-1">{{ $t('iot.maintenance.end') }}</th>
              <th class="py-1">{{ $t('iot.maintenance.source') }}</th>
              <th class="py-1">{{ $t('iot.maintenance.reason') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in data.maintenanceWindows" :key="row.id" class="border-t">
              <td class="py-1">{{ row.startTs }}</td>
              <td class="py-1">{{ row.endTs || $t('iot.maintenance.ongoing') }}</td>
              <td class="py-1">
                {{
                  row.source === 'LEASE_HANDOVER'
                    ? $t('iot.maintenance.sourceHandover')
                    : $t('iot.maintenance.sourceManual')
                }}
              </td>
              <td class="py-1">{{ row.reason || '-' }}</td>
            </tr>
          </tbody>
        </table>
      </template>
    </Spin>
  </Drawer>
</template>
