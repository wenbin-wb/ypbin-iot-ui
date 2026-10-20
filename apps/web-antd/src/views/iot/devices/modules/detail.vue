<script lang="ts" setup>
import type {
  IotAvailabilityApi,
  IotDeviceApi,
  IotEventApi,
  IotShadowApi,
} from '#/api/iot';
import type { IotRealtimeLatestPayload } from '#/api/iot/realtime';

import { computed, onUnmounted, ref } from 'vue';

import { useAccess } from '@vben/access';
import { useVbenDrawer } from '@vben/common-ui';

import {
  Alert,
  Button,
  Empty,
  Select,
  SelectOption,
  Spin,
  Tabs,
  Tag,
  Timeline,
  TimelineItem,
} from 'ant-design-vue';

import {
  getDeviceAvailability,
  getDeviceEvents,
  getDeviceLatest,
  getDeviceShadow,
  getProductDetail,
} from '#/api/iot';
import { alertTouchesDevice, createTrailingDebounce } from '#/api/iot/realtime';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import { formatDateTime, prettyJson } from '../../shared/display';
import PanelErrorBoundary from '../../shared/panel-error-boundary.vue';
import { useIotRealtime } from '../../shared/use-iot-realtime';
import Availability from './availability.vue';
import Credential from './credential.vue';
import DetailAlert from './detail-alert.vue';
import DetailDebug from './detail-debug.vue';
import DetailPoints from './detail-points.vue';
import OverviewBasicCard from './overview-basic-card.vue';
import OverviewEventsCard from './overview-events-card.vue';
import OverviewLatestCard from './overview-latest-card.vue';
import OverviewShadowCard from './overview-shadow-card.vue';
import Series from './series.vue';
import DeviceTags from './tags.vue';
import Trace from './trace.vue';

/**
 * 设备详情：5 个可落地区块 = 概览 / 属性与点位 / 历史曲线 / 事件与断档 / 在线调试（+ 影子状态）。
 *
 * 为什么是抽屉而不是新路由页：路由由后端 `sys_menu.component` 决定（本仓不另立一套路由），
 * 加一个详情页就要加一个「点不开的菜单项」；抽屉从设备台账行点进去即可，且不改菜单与权限。
 *
 * **数据来源全部是既有接口**：最新值 = 新增的最新值端点、可用率/断档 =
 * `GET /devices/{id}/availability`、影子 = `GET /devices/{id}/shadow`、
 * 点位与物模型属性 = `/devices/{id}/points` + `/products/{id}/services`。
 * 「历史曲线」与「可用率」两块**直接复用台账已有的抽屉组件**，不重画一套图表逻辑。
 * 「在线调试」（段 C）复用同一个 `DetailDebug` 组件，只走既有的 commands 三个端点。
 */
const deviceId = ref('');

/** 抽屉数据就是设备台账行（`GET /iot/devices` 的行对象），字段与列表页一致。 */
const device = ref<IotDeviceApi.DeviceResp>();

/** 最新值：命中 / 空 / 失败三态分别展示，禁把失败显示成「没有数据」。 */
const latest = ref<IotDeviceApi.LatestValueResp[]>([]);

const latestError = ref('');

const availability = ref<IotAvailabilityApi.AvailabilityResp>();

const availabilityError = ref('');

const shadow = ref<IotShadowApi.ShadowResp>();

const shadowError = ref('');

/** 运行期事件：命中 / 空 / 失败三态分别展示，禁把失败显示成「没有事件」。 */
const events = ref<IotEventApi.EventLogResp[]>([]);

/** 事件总数（可能大于本页条数：抽屉只取一页，事件页签据此提示收窄条件）。 */
const eventsTotal = ref(0);

const eventsError = ref('');

/** 事件页签的级别过滤（空=全部）。概览区的「最近事件」固定看最新，不受它影响。 */
const eventLevel = ref('');

/** 一次取多少条：后端单页上限 100，抽屉里取 20 条足够。 */
const EVENT_PAGE_SIZE = 20;

/** 产品名（只有绑了产品才查；「看不出关联」最直观的一处：设备到底属于哪个产品）。 */
const productName = ref('');

const loading = ref(false);

/**
 * 「在线调试」页签的门禁：需要 `iot:debug:get`（查询下发/回执记录）。
 *
 * 页签本身用 `v-if` 隐藏（`v-access` 只能摘掉元素，摘不掉 Tabs 的页签头 ⇒ 会留下一个点得动但空白的页签）；
 * 页签**内部**的下发按钮与重发按钮另用 `v-access:code="['iot:debug:send']"` 把门（两者权限码不同）。
 */
const { hasAccessByCodes } = useAccess();

const canViewDebug = computed(() => hasAccessByCodes(['iot:debug:get']));

/**
 * 「消息跟踪」页签的门禁：**与「在线调试」同一个权限码 `iot:debug:get`**。
 *
 * 刻意不复用 `iot:device:list`：本页签展示下行的命令标识、归因码与"设备回执"入口，
 * 属命令侧读能力；`iot:device:list` 是设备列表页的菜单级权限，范围宽得多，
 * 用它把关等于**权限降级**（与后端 `DeviceTraceController` 同一决定）。
 */
const canViewTrace = computed(() => hasAccessByCodes(['iot:debug:get']));

/**
 * 「告警」页签的门禁：需要 `iot:alert:list`。
 *
 * 页签本身用 `v-if` 隐藏（`v-access` 只能摘掉元素，摘不掉 Tabs 的页签头 ⇒ 会留下一个点得动但空白的页签）。
 * 页签内部的「确认 / 静默」按钮另用 `v-if + computed(canAck)` 把门（两者权限码不同）。
 */
const canViewAlert = computed(() => hasAccessByCodes(['iot:alert:list']));

const {
  error: realtimeError,
  onEvent: onRealtimeEvent,
  state: realtimeState,
} = useIotRealtime();

/** 断线/重连中才提示；首次 connecting 不闪提示。 */
const realtimeDisconnected = computed(
  () => realtimeState.value === 'reconnecting',
);

/** alert 事件去抖窗口：一次批量恢复/确认可能连发多条。 */
const REALTIME_ALERT_DEBOUNCE_MS = 500;

/**
 * 告警页签的重挂载键：SSE `alert` 到达时 +1 ⇒ DetailAlert 重新拉取。
 *
 * 为什么用 key 而不是调子组件方法：`DetailAlert` 是既有组件，其 `reload()` 未
 * `defineExpose`；本任务写权限只到 detail.vue，用重挂载达到「刷新告警页签」的同等效果。
 */
const alertRefreshKey = ref(0);

const refreshAlertTabOnRealtime = createTrailingDebounce(() => {
  alertRefreshKey.value += 1;
}, REALTIME_ALERT_DEBOUNCE_MS);

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

/**
 * SSE `latest`：命中当前设备时**就地更新**最新值行（不整表重查）。
 *
 * 高频上报下整表重查会把 `/devices/{id}/latest` 打爆；行内更新是幂等的
 * （按 `propertyId` upsert），新点位则追加。格式化交给既有表格渲染。
 */
function upsertLatestValue(payload: IotRealtimeLatestPayload) {
  const propertyId =
    typeof payload.propertyId === 'string' ? payload.propertyId : '';
  if (propertyId === '') {
    return;
  }
  const next: IotDeviceApi.LatestValueResp = {
    propertyId,
    quality: payload.quality,
    ts: payload.ts,
    value: payload.value,
  };
  const index = latest.value.findIndex(
    (item) => item.propertyId === propertyId,
  );
  latest.value =
    index === -1
      ? [...latest.value, next]
      : latest.value.map((item, itemIndex) =>
          itemIndex === index ? next : item,
        );
}

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
    // 后端 `total` 是 `long` ⇒ 全局序列化成**字符串**（`"17"`）；此处是计数与比较语义 ⇒ 必须显式转数
    eventsTotal.value = toBackendNumber(result.total);
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
      // 先取值再取成员（oxlint `no-await-expression-member`）：`(await f()).x` 可读性差，
      // 且报错行号会指向「取成员」这一行而不是真正失败的那次 await。
      const product = await getProductDetail(boundProductId);
      productName.value = product.productName;
    } catch (error) {
      // 产品名只是「锦上添花」，取不到时展示裸 ID（不静默吞掉：记在控制台便于排查）
      console.warn('[iot] 产品名查询失败，回落展示产品 ID', error);
    }
  }
  loading.value = false;
}

/**
 * 实时事件接线：
 * - `latest` 且 deviceId 匹配当前设备 ⇒ 就地更新最新值列表；
 * - `alert` 触及当前设备 ⇒ 去抖后刷新告警页签（见 `alertRefreshKey`）。
 * `device-status` 本轮设备详情不需要（在线状态仍以打开抽屉时的查询为准）。
 */
onRealtimeEvent('latest', (payload) => {
  if (!deviceId.value || String(payload.deviceId ?? '') !== deviceId.value) {
    return;
  }
  upsertLatestValue(payload);
});

onRealtimeEvent('alert', (payload) => {
  if (!alertTouchesDevice(payload, deviceId.value)) {
    return;
  }
  refreshAlertTabOnRealtime();
});

onUnmounted(() => {
  refreshAlertTabOnRealtime.cancel();
});

const [Drawer, drawerApi] = useVbenDrawer<IotDeviceApi.DeviceResp | null>({
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
  <Drawer class="w-[92vw] max-w-[1560px]">
    <Spin :spinning="loading">
      <!-- 实时流断线必须可见（不阻塞页面：各区块仍可手动刷新/重开抽屉） -->
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
      <Tabs :animated="false">
        <!-- ===== 概览 ===== -->
        <Tabs.TabPane key="overview" :tab="$t('page.iot.device.tabOverview')">
          <!--
            渲染错误边界：概览页签是**默认激活**的页签，且数据全部来自设备上报/影子（不可信）。
            历史事故形态：异常上报值（如 1e-999999999 影子比对补零 RangeError）或 i18n 消息编译
            异常会让整个抽屉渲染中断/整块空白。四个页签必须同一防线（此前只有 debug/trace/alert 有）。
          -->
          <PanelErrorBoundary title-key="page.iot.device.overviewRenderFailed">
            <div class="space-y-4" data-section="overview">
              <!--
                概览拆成 4 张窄 props 卡片（见 05 报告 §2.4）：设备档案 / 最新值+可用率 / 最近事件 / 设备影子。
                每张卡只拿 1-6 个数据字段、自身无状态；数据加载与失败态仍由本页持有并原样透传。
                卡片分组必须服从既有布局契约：最新值与可用率原本就是同一个 `md:grid-cols-2` 网格的两个子项，
                影子两块同理 ⇒ 按「同网格同卡」切分，避免改变网格直系子项数量/顺序（视觉零漂移）。
              -->
              <OverviewBasicCard :device="device" :product-name="productName" />

              <OverviewLatestCard
                :availability="availability"
                :availability-error="availabilityError"
                :human="human"
                :latest="latest"
                :latest-error="latestError"
                :loading="loading"
                @open-availability="onOpenAvailability"
                @open-series="onOpenSeries()"
              />

              <OverviewEventsCard
                :event-color="eventColor"
                :event-level-text="eventLevelText"
                :events="events"
                :events-error="eventsError"
                :events-total="eventsTotal"
              />

              <OverviewShadowCard
                :device-id="deviceId"
                :shadow="shadow"
                :shadow-error="shadowError"
                @saved="load"
              />

              <!-- 标签 + 凭据：两卡响应式并排（组件自带标题，外层只负责卡片容器） -->
              <div class="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
                <section
                  class="rounded-xl border border-border/80 bg-card p-4"
                  data-section="overview-tags"
                >
                  <DeviceTags :device-id="deviceId" />
                </section>
                <section
                  class="rounded-xl border border-border/80 bg-card p-4"
                  data-section="overview-credential"
                >
                  <Credential :device-id="deviceId" />
                </section>
              </div>
            </div>
          </PanelErrorBoundary>
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
          <div class="space-y-4">
            <section class="rounded-xl border border-border/80 bg-card p-4">
              <div
                class="mb-3 flex flex-wrap items-center justify-between gap-2"
              >
                <h3 class="text-sm font-semibold">
                  {{ $t('page.iot.device.runtimeEvents') }}
                </h3>
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
                    <div class="flex flex-wrap items-center gap-2">
                      <Tag :color="eventColor(event.level)">
                        {{ eventLevelText(event.level) }}
                      </Tag>
                      <span class="font-medium">
                        {{ event.eventName || event.eventCode }}
                      </span>
                      <span class="text-xs text-muted-foreground">
                        {{ formatDateTime(event.eventTs) }}
                      </span>
                    </div>
                    <div
                      v-if="event.params"
                      class="mt-1 text-xs break-all whitespace-pre-wrap text-muted-foreground"
                    >
                      {{ $t('page.iot.event.params') }}:
                      {{ prettyJson(event.params) }}
                    </div>
                  </TimelineItem>
                </Timeline>
              </template>
            </section>

            <section class="rounded-xl border border-border/80 bg-card p-4">
              <h3 class="mb-3 text-sm font-semibold">
                {{ $t('page.iot.availability.outages') }}
              </h3>
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
                    <tr
                      v-for="outage in availability?.outages ?? []"
                      :key="outage.id"
                      class="border-b border-border/60 last:border-b-0"
                    >
                      <td class="py-1.5 pr-3 whitespace-nowrap">
                        {{ formatDateTime(outage.startTs) }}
                      </td>
                      <td class="py-1.5 pr-3 whitespace-nowrap">
                        {{
                          outage.endTs
                            ? formatDateTime(outage.endTs)
                            : $t('page.iot.availability.ongoing')
                        }}
                      </td>
                      <td class="py-1.5 pr-3 whitespace-nowrap">
                        {{ human(outage.durationSec) }}
                      </td>
                      <td class="py-1.5">{{ outage.reason || '-' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="mt-3">
                <Button size="small" @click="onOpenAvailability">
                  {{ $t('page.iot.device.openAvailability') }}
                </Button>
              </div>
            </section>
          </div>
        </Tabs.TabPane>

        <!-- ===== 在线调试（段 C）：MQTT 下行/命令调试（下发 → 轮询看状态与回执） ===== -->
        <Tabs.TabPane
          v-if="canViewDebug"
          key="debug"
          :tab="$t('page.iot.debug.title')"
        >
          <!--
            渲染错误边界：该页签曾因 i18n 文案里的字面 `{` `}`（vue-i18n 消息编译期 SyntaxError）
            整块空白。边界把 setup/render 异常截住并用 Alert 原样展示，绝不画成空白。
          -->
          <PanelErrorBoundary>
            <DetailDebug
              :device-id="deviceId"
              :product-id="device?.productId"
            />
          </PanelErrorBoundary>
        </Tabs.TabPane>
        <!-- ===== 消息跟踪：设备消息时序 + 失败项的「定位建议」 ===== -->
        <Tabs.TabPane
          v-if="canViewTrace"
          key="trace"
          :tab="$t('page.iot.device.trace.title')"
        >
          <!-- 渲染错误边界：与「在线调试」「告警」同款防线（渲染期异常必须可见，不得整块空白） -->
          <PanelErrorBoundary title-key="page.iot.device.trace.renderFailed">
            <Trace :device-id="deviceId" />
          </PanelErrorBoundary>
        </Tabs.TabPane>
        <!-- ===== 告警（段 C1/C2）：活动告警 + 历史告警 + 一键确认/静默 ===== -->
        <Tabs.TabPane
          v-if="canViewAlert"
          key="alert"
          :tab="$t('page.iot.alert.title')"
        >
          <!-- 渲染错误边界：与「在线调试」同款防线（i18n/渲染期异常必须可见，不得整块空白） -->
          <PanelErrorBoundary title-key="page.iot.alert.renderFailed">
            <DetailAlert
              :key="alertRefreshKey"
              :device-id="deviceId"
              :product-id="device?.productId"
            />
          </PanelErrorBoundary>
        </Tabs.TabPane>
      </Tabs>
    </Spin>

    <SeriesDrawer />
    <AvailabilityDrawer />
  </Drawer>
</template>
