<script lang="ts" setup>
import type {
  IotAvailabilityApi,
  IotDeviceApi,
  IotEventApi,
  IotShadowApi,
} from '#/api/iot';

import { computed, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import {
  Alert,
  Button,
  Descriptions,
  DescriptionsItem,
  Empty,
  Select,
  SelectOption,
  Spin,
  Tabs,
  Tag,
  Timeline,
  TimelineItem,
} from 'ant-design-vue';
import dayjs from 'dayjs';

import {
  getDeviceAvailability,
  getDeviceEvents,
  getDeviceLatest,
  getDeviceShadow,
  getProductDetail,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import Availability from './availability.vue';
import DetailPoints from './detail-points.vue';
import Series from './series.vue';

/**
 * 设备详情（F1）：4 个可落地区块 = 概览 / 属性与点位 / 历史曲线 / 事件与断档（+ 影子状态）。
 *
 * 为什么是抽屉而不是新路由页：路由由后端 `sys_menu.component` 决定（本仓不另立一套路由），
 * 加一个详情页就要加一个「点不开的菜单项」；抽屉从设备台账行点进去即可，且不改菜单与权限。
 *
 * **数据来源全部是既有接口**：最新值 = G1 新端点、可用率/断档 =
 * `GET /devices/{id}/availability`、影子 = `GET /devices/{id}/shadow`、
 * 点位与物模型属性 = `/devices/{id}/points` + `/products/{id}/services`。
 * 「历史曲线」与「可用率」两块**直接复用台账已有的抽屉组件**，不重画一套图表逻辑。
 */
const deviceId = ref('');

/** 抽屉数据就是设备台账行（`GET /iot/devices` 的行对象），字段与列表页一致。 */
const device = ref<IotDeviceApi.DeviceResp>();

/** 最新值（G1）：命中 / 空 / 失败三态分别展示，禁把失败显示成「没有数据」。 */
const latest = ref<IotDeviceApi.LatestValueResp[]>([]);

const latestError = ref('');

const availability = ref<IotAvailabilityApi.AvailabilityResp>();

const availabilityError = ref('');

const shadow = ref<IotShadowApi.ShadowResp>();

const shadowError = ref('');

/** 运行期事件（G6）：命中 / 空 / 失败三态分别展示，禁把失败显示成「没有事件」。 */
const events = ref<IotEventApi.EventLogResp[]>([]);

/** 事件总数（可能大于本页条数：抽屉只取一页，事件页签据此提示收窄条件）。 */
const eventsTotal = ref(0);

const eventsError = ref('');

/** 事件页签的级别过滤（空=全部）。概览区的「最近事件」固定看最新，不受它影响。 */
const eventLevel = ref('');

/** 一次取多少条：后端单页上限 100，抽屉里取 20 条足够。 */
const EVENT_PAGE_SIZE = 20;

/** 概览区只展示最近几条（完整时间线在「事件与断档」页签）。 */
const RECENT_EVENT_SIZE = 3;

/** 产品名（只有绑了产品才查；「看不出关联」最直观的一处：设备到底属于哪个产品）。 */
const productName = ref('');

const loading = ref(false);

/** 用 `Series`/`Availability` 各自的抽屉组件：曲线与可用率口径只有一份实现。 */
const [SeriesDrawer, SeriesDrawerApi] = useVbenDrawer({
  connectedComponent: Series,
});

const [AvailabilityDrawer, AvailabilityDrawerApi] = useVbenDrawer({
  connectedComponent: Availability,
});

function onOpenSeries(propertyId?: string) {
  if (!deviceId.value) {
    return;
  }
  SeriesDrawerApi.setData({
    deviceName: device.value?.deviceName ?? device.value?.deviceCode,
    id: deviceId.value,
    productId: device.value?.productId,
    propertyId,
  }).open();
}

function onOpenAvailability() {
  if (!deviceId.value) {
    return;
  }
  AvailabilityDrawerApi.setData({
    deviceName: device.value?.deviceName ?? device.value?.deviceCode,
    id: deviceId.value,
  }).open();
}

/** 后端 `ts` 为 epoch 毫秒（Long 序列化成字符串）⇒ 展示前 `Number()`。 */
function toMillis(ts?: null | number | string): null | number {
  if (ts === null || ts === undefined || ts === '') {
    return null;
  }
  const millis = Number(ts);
  return Number.isFinite(millis) ? millis : null;
}

function formatTs(ts?: null | number | string): string {
  const millis = toMillis(ts);
  return millis === null
    ? '-'
    : dayjs(millis).format('YYYY-MM-DD HH:mm:ss.SSS');
}

/** 秒 → 可读时长（与可用率抽屉同一算法口径，只做展示）。 */
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

const latestLoaded = computed(
  () => latestError.value === '' && !loading.value,
);

/** 概览卡片：可用率/断档都取自同一个可用率响应，避免两处数字对不上。 */
const availabilityText = computed(() => {
  const raw = availability.value?.availability;
  if (raw === null || raw === undefined || raw === '') {
    return '-';
  }
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? String(raw) : parsed.toFixed(4);
});

const ongoingOutageCount = computed(
  () => availability.value?.outages.filter((item) => !item.endTs).length ?? 0,
);

/** 概览区的「最近事件」（时间线已按发生时刻倒序，直接取前几条）。 */
const recentEvents = computed(() =>
  events.value.slice(0, RECENT_EVENT_SIZE),
);

/** 是否还有更多事件没在本页展示（提示用户去页签或用级别/时间收窄）。 */
const eventsTruncated = computed(() => eventsTotal.value > events.value.length);

/** a-timeline 的颜色：错误=红、告警=橙、其余=蓝（与 Tag 同色，避免两处口径不一致）。 */
function eventColor(level?: string): string {
  if (level === 'error') {
    return 'red';
  }
  if (level === 'warn') {
    return 'orange';
  }
  return 'blue';
}

/** 级别码 → 文案（后端只回码，文案在前端 i18n）。 */
function eventLevelText(level?: string): string {
  if (level === 'error') {
    return $t('page.iot.event.levelError');
  }
  if (level === 'warn') {
    return $t('page.iot.event.levelWarn');
  }
  return $t('page.iot.event.levelInfo');
}

/**
 * 重新拉取事件（初始加载与级别过滤共用）。
 *
 * 失败必须落到 `eventsError` 上单独展示：把「查询失败」显示成「没有事件」会让用户
 * 以为设备从没报过事件（与最新值/影子区块同一口径）。
 */
async function reloadEvents() {
  if (!deviceId.value) {
    events.value = [];
    eventsTotal.value = 0;
    return;
  }
  try {
    const result = await getDeviceEvents(deviceId.value, {
      level: eventLevel.value === '' ? undefined : eventLevel.value,
      page: 1,
      pageSize: EVENT_PAGE_SIZE,
    });
    events.value = result.items ?? [];
    eventsTotal.value = result.total ?? 0;
    eventsError.value = '';
  } catch (error) {
    events.value = [];
    eventsTotal.value = 0;
    eventsError.value = extractErrorMessage(
      error,
      $t('page.iot.event.loadFailed'),
    );
  }
}

/** 打平影子键值（键=属性标识），供表格渲染。 */
function shadowRows(map?: Record<string, unknown>) {
  return Object.entries(map ?? {}).map(([key, value]) => ({
    key,
    value: value === null || value === undefined ? '' : String(value),
  }));
}

async function load() {
  loading.value = true;
  latest.value = [];
  latestError.value = '';
  availability.value = undefined;
  availabilityError.value = '';
  shadow.value = undefined;
  shadowError.value = '';
  events.value = [];
  eventsTotal.value = 0;
  eventsError.value = '';
  productName.value = '';
  if (!deviceId.value) {
    loading.value = false;
    return;
  }
  const id = deviceId.value;
  // 只读接口互不依赖：并发发出去，各自独立报错（一处失败不影响其它区块展示）
  const [latestResult, availabilityResult, shadowResult] =
    await Promise.allSettled([
      getDeviceLatest(id),
      getDeviceAvailability(id),
      getDeviceShadow(id),
    ]);
  // 事件单独走 reloadEvents（它还要被级别过滤复用），失败语义与上面三块一致：独立错误态
  await reloadEvents();

  if (latestResult.status === 'fulfilled') {
    latest.value = latestResult.value ?? [];
  } else {
    latestError.value = extractErrorMessage(
      latestResult.reason,
      $t('page.iot.device.latestLoadFailed'),
    );
  }
  if (availabilityResult.status === 'fulfilled') {
    availability.value = availabilityResult.value;
  } else {
    availabilityError.value = extractErrorMessage(
      availabilityResult.reason,
      $t('page.iot.availability.loadFailed'),
    );
  }
  if (shadowResult.status === 'fulfilled') {
    shadow.value = shadowResult.value;
  } else {
    shadowError.value = extractErrorMessage(
      shadowResult.reason,
      $t('page.iot.shadow.loadFailed'),
    );
  }

  const boundProductId = device.value?.productId;
  if (boundProductId) {
    try {
      productName.value = (await getProductDetail(boundProductId)).productName;
    } catch (error) {
      // 产品名只是「锦上添花」，取不到时展示裸 ID（不静默吞掉：记在控制台便于排查）
      console.warn('[iot] 产品名查询失败，回落展示产品 ID', error);
    }
  }
  loading.value = false;
}

const [Drawer, drawerApi] = useVbenDrawer<null | IotDeviceApi.DeviceResp>({
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      return;
    }
    const data = drawerApi.getData();
    device.value = data ?? undefined;
    deviceId.value = data?.id ?? '';
    drawerApi.setState({
      title: `${$t('page.iot.device.detail')} - ${data?.deviceName ?? data?.deviceCode ?? deviceId.value}`,
    });
    await load();
  },
});
</script>
<template>
  <Drawer class="w-[1100px]">
    <Spin :spinning="loading">
      <Tabs :animated="false">
        <!-- ===== 概览 ===== -->
        <Tabs.TabPane key="overview" :tab="$t('page.iot.device.tabOverview')">
          <Descriptions :column="2" bordered size="small">
            <DescriptionsItem :label="$t('page.iot.device.code')">
              {{ device?.deviceCode ?? '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.device.name')">
              {{ device?.deviceName ?? '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.device.onlineStatus')">
              <Tag :color="device?.onlineStatus === 'online' ? 'success' : 'default'">
                {{ device?.onlineStatus ?? 'unknown' }}
              </Tag>
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.device.lastSeenAt')">
              {{ device?.lastSeenAt ?? '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.device.product')">
              <template v-if="device?.productId">
                {{ productName || device?.productId }}
                <span v-if="device?.productVersion" class="text-gray-400">
                  （{{ device?.productVersion }}）
                </span>
              </template>
              <template v-else>
                <span class="text-amber-600">
                  {{ $t('page.iot.device.noProduct') }}
                </span>
              </template>
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.device.protocol')">
              {{ device?.protocol ?? '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.device.endpoint')" :span="2">
              {{ device?.endpoint ?? '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.device.remark')" :span="2">
              {{ device?.remark || '-' }}
            </DescriptionsItem>
          </Descriptions>

          <div class="mt-4 grid grid-cols-2 gap-4">
            <div>
              <div class="mb-2 font-semibold">
                {{ $t('page.iot.device.latestValues') }}
                <span class="text-xs text-muted-foreground">
                  （{{ $t('page.iot.device.latestHint') }}）
                </span>
              </div>
              <Alert
                v-if="latestError"
                :message="latestError"
                show-icon
                type="error"
              />
              <Empty
                v-else-if="latestLoaded && latest.length === 0"
                :description="$t('page.iot.device.latestEmpty')"
              />
              <table v-else class="w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-500">
                    <th class="py-1">{{ $t('page.iot.device.propertyId') }}</th>
                    <th class="py-1">{{ $t('page.iot.series.value') }}</th>
                    <th class="py-1">{{ $t('page.iot.series.quality') }}</th>
                    <th class="py-1">{{ $t('page.iot.series.ts') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="item in latest"
                    :key="item.propertyId"
                    class="border-t"
                  >
                    <td class="py-1">{{ item.propertyId }}</td>
                    <td class="py-1">{{ item.value ?? '-' }}</td>
                    <td class="py-1">{{ item.quality ?? '-' }}</td>
                    <td class="py-1">{{ formatTs(item.ts) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div>
              <div class="mb-2 font-semibold">
                {{ $t('page.iot.availability.title', ['']) }}
              </div>
              <Alert
                v-if="availabilityError"
                :message="availabilityError"
                show-icon
                type="error"
              />
              <Descriptions v-else :column="1" bordered size="small">
                <DescriptionsItem
                  :label="$t('page.iot.availability.availability')"
                >
                  <span class="text-lg font-semibold">
                    {{ availabilityText }}
                  </span>
                </DescriptionsItem>
                <DescriptionsItem
                  :label="$t('page.iot.availability.outageSeconds')"
                >
                  {{ human(availability?.outageSeconds) }}
                </DescriptionsItem>
                <DescriptionsItem
                  :label="$t('page.iot.availability.outageCount')"
                >
                  {{ availability?.outageCount ?? '-' }}
                  <span v-if="ongoingOutageCount > 0" class="ml-2 text-red-600">
                    （{{ $t('page.iot.availability.ongoing') }}
                    {{ ongoingOutageCount }}）
                  </span>
                </DescriptionsItem>
              </Descriptions>
              <div class="mt-2 flex gap-2">
                <Button size="small" @click="onOpenAvailability">
                  {{ $t('page.iot.device.openAvailability') }}
                </Button>
                <Button size="small" @click="onOpenSeries()">
                  {{ $t('page.iot.series.title') }}
                </Button>
              </div>
            </div>
          </div>

          <!-- 最近事件（G6）：有数据给时间线，无数据给空态，查询失败单独报错 -->
          <div class="mt-4">
            <div class="mb-2 font-semibold">
              {{ $t('page.iot.device.recentEvents') }}
            </div>
            <Alert
              v-if="eventsError"
              :message="eventsError"
              show-icon
              type="error"
            />
            <Empty
              v-else-if="recentEvents.length === 0"
              :description="$t('page.iot.event.empty')"
            />
            <template v-else>
              <Timeline>
                <TimelineItem
                  v-for="event in recentEvents"
                  :key="event.id"
                  :color="eventColor(event.level)"
                >
                  <div class="flex items-center gap-2">
                    <Tag :color="eventColor(event.level)">
                      {{ eventLevelText(event.level) }}
                    </Tag>
                    <span class="font-medium">
                      {{ event.eventName || event.eventCode }}
                    </span>
                  </div>
                  <div class="text-xs text-muted-foreground">
                    {{ event.eventTs ?? '-' }}
                  </div>
                </TimelineItem>
              </Timeline>
              <div
                v-if="eventsTruncated"
                class="text-xs text-muted-foreground"
              >
                {{ $t('page.iot.event.goToTab') }}
              </div>
            </template>
          </div>

          <div class="mt-4 grid grid-cols-2 gap-4">
            <div>
              <div class="mb-2 font-semibold">
                {{ $t('page.iot.shadow.reported') }}
              </div>
              <Alert
                v-if="shadowError"
                :message="shadowError"
                show-icon
                type="error"
              />
              <template v-else>
                <Alert
                  :message="$t('page.iot.shadow.reportedDisabled')"
                  show-icon
                  type="info"
                />
                <Empty
                  v-if="shadowRows(shadow?.reported).length === 0"
                  :description="$t('page.iot.shadow.empty')"
                />
                <table v-else class="w-full text-sm">
                  <tbody>
                    <tr
                      v-for="row in shadowRows(shadow?.reported)"
                      :key="row.key"
                      class="border-t"
                    >
                      <td class="py-1">{{ row.key }}</td>
                      <td class="py-1">{{ row.value }}</td>
                    </tr>
                  </tbody>
                </table>
                <div class="mt-1 text-xs text-muted-foreground">
                  {{ $t('page.iot.shadow.reportTs') }}:
                  {{ shadow?.reportTs ?? '-' }}
                </div>
              </template>
            </div>
            <div>
              <div class="mb-2 font-semibold">
                {{ $t('page.iot.shadow.desired') }}
              </div>
              <Empty
                v-if="shadowRows(shadow?.desired).length === 0"
                :description="$t('page.iot.shadow.empty')"
              />
              <table v-else class="w-full text-sm">
                <tbody>
                  <tr
                    v-for="row in shadowRows(shadow?.desired)"
                    :key="row.key"
                    class="border-t"
                  >
                    <td class="py-1">{{ row.key }}</td>
                    <td class="py-1">{{ row.value }}</td>
                  </tr>
                </tbody>
              </table>
              <div class="mt-1 text-xs text-muted-foreground">
                {{ $t('page.iot.shadow.desiredTs') }}:
                {{ shadow?.desiredTs ?? '-' }}
              </div>
            </div>
          </div>
        </Tabs.TabPane>

        <!-- ===== 属性与点位 ===== -->
        <Tabs.TabPane key="points" :tab="$t('page.iot.device.tabPoints')">
          <DetailPoints
            :device-id="deviceId"
            :product-id="device?.productId"
            @open-series="onOpenSeries"
          />
        </Tabs.TabPane>

        <!-- ===== 历史曲线 ===== -->
        <Tabs.TabPane key="series" :tab="$t('page.iot.series.title')">
          <Alert
            :message="$t('page.iot.device.seriesReuseHint')"
            show-icon
            type="info"
          />
          <div class="mt-3">
            <Button type="primary" @click="onOpenSeries()">
              {{ $t('page.iot.device.openSeries') }}
            </Button>
          </div>
        </Tabs.TabPane>

        <!-- ===== 事件与断档 ===== -->
        <Tabs.TabPane key="events" :tab="$t('page.iot.device.tabEvents')">
          <div class="mb-2 flex items-center justify-between">
            <div class="font-semibold">
              {{ $t('page.iot.device.runtimeEvents') }}
            </div>
            <div class="flex items-center gap-2">
              <Select
                v-model:value="eventLevel"
                :placeholder="$t('page.iot.event.allLevels')"
                size="small"
                style="width: 130px"
                @change="reloadEvents"
              >
                <SelectOption value="">
                  {{ $t('page.iot.event.allLevels') }}
                </SelectOption>
                <SelectOption value="info">
                  {{ $t('page.iot.event.levelInfo') }}
                </SelectOption>
                <SelectOption value="warn">
                  {{ $t('page.iot.event.levelWarn') }}
                </SelectOption>
                <SelectOption value="error">
                  {{ $t('page.iot.event.levelError') }}
                </SelectOption>
              </Select>
              <Button size="small" @click="reloadEvents">
                {{ $t('page.iot.event.refresh') }}
              </Button>
            </div>
          </div>
          <Alert
            v-if="eventsError"
            :message="eventsError"
            show-icon
            type="error"
          />
          <Empty
            v-else-if="events.length === 0"
            :description="$t('page.iot.event.empty')"
          />
          <template v-else>
            <div class="mb-1 text-xs text-muted-foreground">
              {{ $t('page.iot.event.total', [eventsTotal]) }}
              <span v-if="eventsTruncated">
                · {{ $t('page.iot.event.truncated', [EVENT_PAGE_SIZE]) }}
              </span>
            </div>
            <Timeline>
              <TimelineItem
                v-for="event in events"
                :key="event.id"
                :color="eventColor(event.level)"
              >
                <div class="flex items-center gap-2">
                  <Tag :color="eventColor(event.level)">
                    {{ eventLevelText(event.level) }}
                  </Tag>
                  <span class="font-medium">
                    {{ event.eventName || event.eventCode }}
                  </span>
                  <span class="text-xs text-muted-foreground">
                    {{ event.eventTs ?? '-' }}
                  </span>
                </div>
                <div
                  v-if="event.params"
                  class="mt-1 text-xs break-all text-muted-foreground"
                >
                  {{ $t('page.iot.event.params') }}: {{ event.params }}
                </div>
              </TimelineItem>
            </Timeline>
          </template>

          <div class="mt-4 mb-2 font-semibold">
            {{ $t('page.iot.availability.outages') }}
          </div>
          <Alert
            v-if="availabilityError"
            :message="availabilityError"
            show-icon
            type="error"
          />
          <Empty
            v-else-if="(availability?.outages.length ?? 0) === 0"
            :description="$t('page.iot.availability.noOutage')"
          />
          <table v-else class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-500">
                <th class="py-1">{{ $t('page.iot.availability.start') }}</th>
                <th class="py-1">{{ $t('page.iot.availability.end') }}</th>
                <th class="py-1">{{ $t('page.iot.availability.duration') }}</th>
                <th class="py-1">{{ $t('page.iot.availability.reason') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="outage in availability?.outages ?? []"
                :key="outage.id"
                class="border-t"
              >
                <td class="py-1">{{ outage.startTs }}</td>
                <td class="py-1">
                  {{ outage.endTs || $t('page.iot.availability.ongoing') }}
                </td>
                <td class="py-1">{{ human(outage.durationSec) }}</td>
                <td class="py-1">{{ outage.reason }}</td>
              </tr>
            </tbody>
          </table>
          <div class="mt-2 flex gap-2">
            <Button size="small" @click="onOpenAvailability">
              {{ $t('page.iot.device.openAvailability') }}
            </Button>
          </div>
        </Tabs.TabPane>
      </Tabs>
    </Spin>

    <SeriesDrawer />
    <AvailabilityDrawer />
  </Drawer>
</template>
