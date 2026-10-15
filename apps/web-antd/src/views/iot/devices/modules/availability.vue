<script lang="ts" setup>
import type { IotAvailabilityApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import {
  Descriptions,
  DescriptionsItem,
  Empty,
  Spin,
  Tag,
} from 'ant-design-vue';

import { getDeviceAvailability } from '#/api/iot';
import { $t } from '#/locales';

import {
  displayOrFallback,
  formatDateTime,
  maintenanceSourceLabel,
} from '../../shared/display';

const loading = ref(false);
const data = ref<IotAvailabilityApi.AvailabilityResp>();

/** 抽屉数据：设备行（vben 的 `getData()` 不带类型参数，泛型要写在 useVbenDrawer 上）。 */
interface AvailabilityDrawerData {
  deviceName?: string;
  id: string;
}

const [Drawer, drawerApi] = useVbenDrawer<AvailabilityDrawerData>({
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      return;
    }
    const device = drawerApi.getData();
    drawerApi.setState({
      title: $t('page.iot.availability.title', [
        device?.deviceName ?? device?.id ?? '',
      ]),
    });
    // 没有设备 id 不发请求：否则会打 /iot/devices//availability（后端 404，白跑一趟还留噪音）
    if (!device?.id) {
      data.value = undefined;
      return;
    }
    loading.value = true;
    data.value = undefined;
    try {
      data.value = await getDeviceAvailability(device.id);
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
  <Drawer class="w-[min(920px,96vw)]">
    <Spin :spinning="loading">
      <template v-if="data">
        <Descriptions :column="2" bordered size="small">
          <DescriptionsItem :label="$t('page.iot.availability.window')">
            {{ formatDateTime(data.from) }} ~ {{ formatDateTime(data.to) }}
          </DescriptionsItem>
          <DescriptionsItem :label="$t('page.iot.availability.availability')">
            <span class="text-lg font-semibold">{{ availability }}</span>
            <Tag :color="meets ? 'success' : 'error'" class="ml-2">
              {{
                meets
                  ? $t('page.iot.availability.meetsTarget')
                  : $t('page.iot.availability.notMeetsTarget')
              }}
            </Tag>
          </DescriptionsItem>
          <DescriptionsItem
            :label="$t('page.iot.availability.effectiveWindow')"
          >
            {{ human(data.effectiveWindowSeconds) }}
            <span class="text-gray-400">
              （{{ $t('page.iot.availability.window') }}：{{
                human(data.windowSeconds)
              }}）
            </span>
          </DescriptionsItem>
          <DescriptionsItem
            :label="$t('page.iot.availability.maintenanceSeconds')"
          >
            {{ human(data.maintenanceSeconds) }}
            <span class="text-gray-400">
              （{{ $t('page.iot.availability.outageInMaintenance') }}：{{
                human(data.outageInMaintenanceSeconds)
              }}）
            </span>
          </DescriptionsItem>
          <DescriptionsItem :label="$t('page.iot.availability.outageSeconds')">
            {{ human(data.outageSeconds) }}
          </DescriptionsItem>
          <DescriptionsItem :label="$t('page.iot.availability.longestOutage')">
            {{ human(data.longestOutageSeconds) }}
            <span class="text-gray-400">
              （{{ $t('page.iot.availability.outageCount') }}：{{
                data.outageCount
              }}）
            </span>
          </DescriptionsItem>
        </Descriptions>

        <div class="mt-4 mb-2 font-semibold">
          {{ $t('page.iot.availability.outages') }}
        </div>
        <Empty
          v-if="!data.outages?.length"
          :description="$t('page.iot.availability.noOutage')"
        />
        <div v-else class="overflow-x-auto">
          <table class="w-full min-w-[640px] text-sm">
            <thead>
              <tr
                class="border-b border-border/60 text-left text-xs text-muted-foreground"
              >
                <th class="py-1.5 pr-3 font-medium">
                  {{ $t('page.iot.availability.start') }}
                </th>
                <th class="py-1.5 pr-3 font-medium">
                  {{ $t('page.iot.availability.end') }}
                </th>
                <th class="py-1.5 pr-3 font-medium">
                  {{ $t('page.iot.availability.duration') }}
                </th>
                <th class="py-1.5 font-medium">
                  {{ $t('page.iot.availability.reason') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in data.outages" :key="row.id" class="border-t">
                <td class="py-1">{{ formatDateTime(row.startTs) }}</td>
                <td class="py-1">
                  {{
                    row.endTs
                      ? formatDateTime(row.endTs)
                      : $t('page.iot.availability.ongoing')
                  }}
                </td>
                <td class="py-1">{{ human(row.durationSec) }}</td>
                <td class="py-1">{{ displayOrFallback(row.reason) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="mt-4 mb-2 font-semibold">
          {{ $t('page.iot.maintenance.title') }}
        </div>
        <Empty
          v-if="!data.maintenanceWindows?.length"
          :description="$t('page.iot.maintenance.empty')"
        />
        <div v-else class="overflow-x-auto">
          <table class="w-full min-w-[640px] text-sm">
            <thead>
              <tr
                class="border-b border-border/60 text-left text-xs text-muted-foreground"
              >
                <th class="py-1.5 pr-3 font-medium">
                  {{ $t('page.iot.maintenance.start') }}
                </th>
                <th class="py-1.5 pr-3 font-medium">
                  {{ $t('page.iot.maintenance.end') }}
                </th>
                <th class="py-1.5 pr-3 font-medium">
                  {{ $t('page.iot.maintenance.source') }}
                </th>
                <th class="py-1.5 font-medium">
                  {{ $t('page.iot.maintenance.reason') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in data.maintenanceWindows"
                :key="row.id"
                class="border-t"
              >
                <td class="py-1">{{ formatDateTime(row.startTs) }}</td>
                <td class="py-1">
                  {{
                    row.endTs
                      ? formatDateTime(row.endTs)
                      : $t('page.iot.maintenance.ongoing')
                  }}
                </td>
                <td class="py-1">{{ maintenanceSourceLabel(row.source) }}</td>
                <td class="py-1">{{ displayOrFallback(row.reason) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </Spin>
  </Drawer>
</template>
