<script lang="ts" setup>
import type { TabOption } from '@vben/types';

import { computed } from 'vue';
import { useRouter } from 'vue-router';

import {
  AnalysisChartCard,
  AnalysisChartsTabs,
  useVbenDrawer,
} from '@vben/common-ui';
import { LayoutGrid } from '@vben/icons';
import { usePreferences } from '@vben/preferences';

import { Alert, Button, Tag, Tooltip } from 'ant-design-vue';

import { $t } from '#/locales';

import HelpDrawer from '../../iot/shared/help-drawer.vue';
import ListErrorAlert from '../../iot/shared/list-error-alert.vue';
import {
  brandTextColor,
  METRIC_VISUALS,
  metricTextColor,
} from '../shared/metric-visuals';
import NoviceGuideCard from '../shared/novice-guide-card.vue';
import { useDashboardRealtime } from '../shared/use-dashboard-realtime';
import { useIotOverview } from '../shared/use-iot-overview';
import AnalyticsAlertTrend from './analytics-alert-trend.vue';
import AnalyticsDeviceGrowth from './analytics-device-growth.vue';
import AnalyticsRuleTop from './analytics-rule-top.vue';
import AnalyticsTrends from './analytics-trends.vue';
import AnalyticsVisitsData from './analytics-visits-data.vue';
import AnalyticsVisitsSales from './analytics-visits-sales.vue';
import AnalyticsVisitsSource from './analytics-visits-source.vue';
import AnalyticsVisits from './analytics-visits.vue';
import BoardDrawer from './board/board-drawer.vue';

// ---- 统一视觉（与工作台同一套语言；色值见 shared/metric-visuals.ts）----
const { isDark } = usePreferences();

const router = useRouter();
// failed / notice 必须接：失败态常驻可见 + 可重试，演示兜底常驻标注（见 04 §P0-1）
const { load, loading, notice, overview, usingDemo } = useIotOverview();

// SSE 实时刷新：latest/device-status/alert 去抖后重拉总览；断线/鉴权失败都要可见提示
const {
  authError,
  error: realtimeError,
  state: realtimeState,
} = useDashboardRealtime(() => void load());

// 术语词典抽屉：与工作台/接入向导共用同一份内容（view 层只负责打开）
const [HelpDrawerContainer, helpDrawerApi] = useVbenDrawer({
  connectedComponent: HelpDrawer,
});

// 组态看板：本页入口，布局/数据/实时订阅都在 board-drawer 内部（不改后端菜单）
const [BoardDrawerContainer, boardDrawerApi] = useVbenDrawer({
  connectedComponent: BoardDrawer,
});

/** 演示数据兜底时页面数据可能为 null，模板统一走空对象口径 */
const data = computed(() => overview.value);

/**
 * 数组字段容错：趋势增强字段（alertTrend/deviceGrowthTrend/alertRuleTop）与后端并行上线，
 * 新旧后端并存时旧响应可能没有这些数组。统一按「缺失 = 空数组」进图表，
 * 让空态兜住，而不是在 `.length` 上炸掉整页。
 */
function asArray<T>(value?: null | T[]): T[] {
  return Array.isArray(value) ? value : [];
}

const alertTrendPoints = computed(() => asArray(data.value?.alertTrend));
const deviceGrowthPoints = computed(() =>
  asArray(data.value?.deviceGrowthTrend),
);
const alertRuleTopItems = computed(() => asArray(data.value?.alertRuleTop));

const dayBadges = computed(() => {
  const d = data.value;
  if (!d) return [];
  return [
    {
      label: $t('page.dashboard.deviceTotal'),
      value: d.deviceTotal.toLocaleString(),
    },
    {
      label: $t('page.dashboard.onlineRate'),
      value: `${d.onlineRate}%`,
    },
    {
      label: $t('page.dashboard.messageToday'),
      value: formatCompact(d.messageToday),
    },
    {
      label: $t('page.dashboard.alertPending'),
      value: String(d.alertPending),
    },
  ];
});

/**
 * 指标卡数据。
 *
 * 数值文字**不再用渐变裁切字**：实测渐变端点对白底卡片只有 2.01:1 / 2.86:1，
 * 连大文本 3:1 都不到，且 `-webkit-text-fill-color: transparent` 在高对比度模式下会让数字消失。
 * 现在数值用「亮/暗各一档、各自 ≥4.5:1」的实色（`shared/metric-visuals.ts` 有回归用例），
 * 渐变只保留在图标块与卡片光斑这些**图形元素**上（判据 3:1）。
 */
const overviewCards = computed(() => {
  const d = data.value;
  if (!d) return [];
  return [
    {
      key: 'device' as const,
      icon: 'i-lucide-cpu',
      title: $t('page.dashboard.deviceTotal'),
      value: d.deviceTotal,
      footLeft: $t('page.dashboard.newDevicesWeek'),
      footRight: `+${d.newDevicesWeek}`,
      ...METRIC_VISUALS.device,
      textColor: metricTextColor('device', isDark.value),
    },
    {
      key: 'online' as const,
      icon: 'i-lucide-wifi',
      title: $t('page.dashboard.onlineRate'),
      value: `${d.onlineRate}%`,
      footLeft: $t('page.dashboard.online'),
      footRight: d.deviceOnline.toLocaleString(),
      ...METRIC_VISUALS.online,
      textColor: metricTextColor('online', isDark.value),
    },
    {
      key: 'message' as const,
      icon: 'i-lucide-radio-tower',
      title: $t('page.dashboard.messageToday'),
      value: formatCompact(d.messageToday),
      footLeft: $t('page.dashboard.downlink'),
      footRight: formatCompact(d.messageDownlinkToday),
      ...METRIC_VISUALS.message,
      textColor: metricTextColor('message', isDark.value),
    },
    {
      key: 'alert' as const,
      icon: 'i-lucide-triangle-alert',
      title: $t('page.dashboard.alertPending'),
      value: d.alertPending,
      footLeft: $t('page.dashboard.alertToday'),
      footRight: String(d.alertToday),
      ...METRIC_VISUALS.alert,
      textColor: metricTextColor('alert', isDark.value),
    },
  ];
});

/** 页头「今日徽章」与指标卡同色（品牌蓝），避免页头与指标卡两套蓝。 */
const badgeTextColor = computed(() => brandTextColor(isDark.value));

/**
 * 实时鉴权失败时的「重新登录」。
 *
 * 动态 import 的理由：`#/api/request` 会拉起 axios 客户端 + Pinia store + 埋点，
 * 而「重新登录」只在用户点那一下才需要 —— 页面首屏与单测都不该为它付加载成本。
 */
async function onRelogin() {
  const { handleSessionExpired } = await import('#/api/request');
  await handleSessionExpired();
}

const chartTabs = computed<TabOption[]>(() => [
  { label: $t('page.dashboard.messageTrend'), value: 'trends' },
  { label: $t('page.dashboard.onlineTrend'), value: 'visits' },
  { label: $t('page.dashboard.alertTrend'), value: 'alertTrends' },
  { label: $t('page.dashboard.deviceGrowth'), value: 'growth' },
]);

/** 最近告警表头与行数据（severity/state 与告警中心同口径翻译） */
const recentAlerts = computed(() => {
  const d = data.value;
  if (!d) return [];
  return d.recentAlerts.map((alert) => ({
    ...alert,
    severityLabel: $t(`page.iot.alert.severity.${alert.severity}`),
    stateLabel: $t(`page.iot.alert.state.${alert.state}`),
  }));
});

/** 级别 → Tag 颜色（与告警中心的语义一致） */
const SEVERITY_TAG_COLORS: Record<string, string> = {
  critical: 'error',
  info: 'processing',
  unknown: 'default',
  warning: 'warning',
};

// 页头：当前日期
const now = computed(() => {
  const d = new Date();
  const week = [
    $t('page.dashboard.sunday'),
    $t('page.dashboard.monday'),
    $t('page.dashboard.tuesday'),
    $t('page.dashboard.wednesday'),
    $t('page.dashboard.thursday'),
    $t('page.dashboard.friday'),
    $t('page.dashboard.saturday'),
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${week[d.getDay()]}`;
});

function formatCompact(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function goAlerts() {
  router.push('/iot/alerts');
}

function openHelp() {
  helpDrawerApi.open();
}

function openBoard() {
  boardDrawerApi.open();
}
</script>

<template>
  <div class="p-5">
    <!-- 页头：深色科技底 + 光斑 + 今日关键徽章 -->
    <div
      class="iot-hero relative overflow-hidden rounded-2xl border border-border/70 px-6 py-5"
    >
      <span
        class="pointer-events-none absolute -right-10 -top-12 size-44 rounded-full opacity-40 blur-3xl"
        style="background: hsl(245deg 82% 67% / 35%)"
      ></span>
      <span
        class="pointer-events-none absolute -bottom-14 right-40 size-36 rounded-full opacity-30 blur-3xl"
        style="background: hsl(199deg 89% 48% / 35%)"
      ></span>
      <div
        class="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between"
      >
        <div>
          <p class="text-xs text-muted-foreground">{{ now }}</p>
          <!--
            页面主标题用 <h1>：全站此前 0 个 h1，读屏「按 H 键跳标题」在长表格页完全失效。
            这是本页唯一的 h1，区块标题（最近告警等）保持 h3 的语义层级由卡片组件给。
          -->
          <h1
            class="mt-1 flex items-center gap-2 text-2xl font-bold tracking-tight"
          >
            {{ $t('page.dashboard.analyticsTitle') }}
            <Tooltip v-if="usingDemo" :title="$t('page.dashboard.demoReason')">
              <Tag class="!mr-0 cursor-help" color="orange" tabindex="0">
                {{ $t('page.dashboard.demoBadge') }}
              </Tag>
            </Tooltip>
            <Tag
              v-else-if="realtimeState === 'live'"
              color="success"
              class="!mr-0"
            >
              {{ $t('page.iot.realtime.live') }}
            </Tag>
            <Tag
              v-else-if="realtimeState === 'connecting'"
              color="processing"
              class="!mr-0"
            >
              {{ $t('page.iot.realtime.connecting') }}
            </Tag>
          </h1>
          <p class="mt-1 text-sm text-muted-foreground">
            {{ $t('page.dashboard.analyticsSubtitle') }}
          </p>
        </div>
        <div class="flex flex-wrap gap-3">
          <div
            v-for="b in dayBadges"
            :key="b.label"
            class="rounded-xl border border-border/70 bg-background/70 px-4 py-2 shadow-sm backdrop-blur"
          >
            <p class="text-xs text-muted-foreground">{{ b.label }}</p>
            <p
              class="mt-0.5 text-lg font-bold tabular-nums leading-none"
              :style="{ color: badgeTextColor }"
            >
              {{ b.value }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!--
      常驻提示区（**不再藏在 hover tooltip 里**）：
      ① 总览接口失败 ⇒ 错误态 + 重试（生产环境此时没有任何假数据可看）；
      ② 演示兜底 ⇒ 明确告知「这是演示数据」，且原因写在正文里，触屏/键盘/读屏都能拿到；
      ③ 实时流鉴权失败 ⇒ 单独提示（重连解决不了 token 过期），unauthorized 给「重新登录」。
    -->
    <ListErrorAlert
      v-if="notice"
      class="mt-3"
      :error="notice.error"
      :retry-text="$t('page.dashboard.retry')"
      :title="notice.title"
      :type="notice.type"
      @retry="() => void load()"
    />
    <Alert
      v-if="authError === 'forbidden'"
      class="mt-3"
      :message="$t('page.iot.realtime.forbidden')"
      show-icon
      type="error"
    />
    <Alert
      v-if="authError === 'unauthorized'"
      class="mt-3"
      :message="$t('page.iot.realtime.authFailed')"
      show-icon
      type="error"
    >
      <template #action>
        <Button danger size="small" @click="onRelogin">
          {{ $t('common.login') }}
        </Button>
      </template>
    </Alert>

    <Alert
      v-if="realtimeState === 'reconnecting'"
      class="mt-3"
      :description="$t('page.iot.realtime.disconnectedHint', [realtimeError])"
      :message="$t('page.iot.realtime.disconnected')"
      show-icon
      type="warning"
    />

    <!-- 组态看板入口：自定义组件 + 实时值 -->
    <div class="mt-3 flex justify-end">
      <Button @click="openBoard">
        <LayoutGrid class="size-4" />
        {{ $t('page.iot.board.entry') }}
      </Button>
    </div>

    <!-- 新手快速上手：面向第一次接入的物业/值班人员，术语问题统一走帮助抽屉 -->
    <NoviceGuideCard class="mt-5" @open-help="openHelp" />

    <!--
      指标卡（设备 / 在线率 / 消息 / 告警）。
      骨架**只在「还没有任何数据」的首屏出现**：以前是 `v-if="loading"` 与卡片互斥，
      每轮 SSE 刷新都会把卡片卸载重建 ⇒ `metric-in` 入场动画每 1.2s 重放一次，页面持续闪烁。
    -->
    <div
      v-if="loading && !data"
      aria-hidden="true"
      class="mt-5 h-[132px] animate-pulse rounded-xl bg-card"
    ></div>
    <div
      v-else-if="data"
      class="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      <div
        v-for="(c, i) in overviewCards"
        :key="c.key"
        class="iot-metric-card group relative overflow-hidden rounded-xl border border-border/80 bg-card p-5"
        :style="{ '--glow': c.glow, animationDelay: `${i * 60}ms` }"
      >
        <span
          class="pointer-events-none absolute -right-8 -top-8 size-24 rounded-full opacity-50 blur-2xl transition-opacity duration-300 group-hover:opacity-80"
          :style="{ background: c.grad }"
        ></span>
        <div class="relative flex items-start justify-between">
          <div>
            <p class="text-sm text-muted-foreground">{{ c.title }}</p>
            <p
              class="mt-2 text-3xl font-bold tabular-nums leading-none tracking-tight"
              :style="{ color: c.textColor }"
            >
              {{ c.value }}
            </p>
          </div>
          <span
            class="inline-flex size-10 items-center justify-center rounded-xl text-white shadow-lg"
            :style="{ background: c.grad, boxShadow: `0 8px 20px ${c.glow}` }"
          >
            <span :class="c.icon" class="size-5"></span>
          </span>
        </div>
        <div
          class="relative mt-4 flex items-center justify-between border-t border-border/70 pt-3 text-xs text-muted-foreground"
        >
          <span>{{ c.footLeft }}</span>
          <span class="font-semibold tabular-nums">{{ c.footRight }}</span>
        </div>
      </div>
    </div>

    <!-- 失败态已由上方常驻 ListErrorAlert 承担，这里不再画第二块「加载失败」大框（避免重复噪声） -->
    <AnalysisChartsTabs v-if="!loading && data" :tabs="chartTabs" class="mt-5">
      <template #trends>
        <AnalyticsTrends :points="data.messageTrend" />
      </template>
      <template #visits>
        <AnalyticsVisits :points="data.onlineTrend" />
      </template>
      <template #alertTrends>
        <AnalyticsAlertTrend :points="alertTrendPoints" />
      </template>
      <template #growth>
        <AnalyticsDeviceGrowth :points="deviceGrowthPoints" />
      </template>
    </AnalysisChartsTabs>

    <div v-if="data" class="mt-5 w-full md:flex">
      <AnalysisChartCard
        class="mt-5 md:mt-0 md:mr-4 md:w-1/3"
        :title="$t('page.dashboard.protocolTitle')"
      >
        <AnalyticsVisitsData :items="data.protocolDistribution" />
      </AnalysisChartCard>
      <AnalysisChartCard
        class="mt-5 md:mt-0 md:mr-4 md:w-1/3"
        :title="$t('page.dashboard.severityTitle')"
      >
        <AnalyticsVisitsSource :items="data.severityDistribution" />
      </AnalysisChartCard>
      <AnalysisChartCard
        class="mt-5 md:mt-0 md:w-1/3"
        :title="$t('page.dashboard.productTopTitle')"
      >
        <AnalyticsVisitsSales :items="data.productTop" />
      </AnalysisChartCard>
    </div>

    <!-- 最近告警（与告警中心同口径；查看全部跳转 /iot/alerts）+ 告警最多的规则 -->
    <div v-if="data" class="mt-5 flex w-full flex-col gap-4 xl:flex-row">
      <div class="min-w-0 flex-1 rounded-xl border border-border/80 bg-card">
        <div
          class="flex items-center justify-between border-b border-border/70 px-5 py-4"
        >
          <h3 class="text-sm font-semibold">
            {{ $t('page.dashboard.recentAlerts') }}
          </h3>
          <!-- 改用 Button(type=link)：「查看全部」原先是个无 href 的 <a>，键盘 Tab 不到、读屏也不认作链接 -->
          <Button
            class="px-0 text-xs"
            size="small"
            type="link"
            @click="goAlerts"
          >
            {{ $t('page.dashboard.viewAllAlerts') }} →
          </Button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr
                class="border-b border-border/70 text-left text-xs text-muted-foreground"
              >
                <th class="px-5 py-2.5 font-medium">
                  {{ $t('page.dashboard.colDevice') }}
                </th>
                <th class="px-5 py-2.5 font-medium">
                  {{ $t('page.dashboard.colRule') }}
                </th>
                <th class="px-5 py-2.5 font-medium">
                  {{ $t('page.dashboard.colSeverity') }}
                </th>
                <th class="px-5 py-2.5 font-medium">
                  {{ $t('page.dashboard.colState') }}
                </th>
                <th class="px-5 py-2.5 font-medium">
                  {{ $t('page.dashboard.colTime') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="alert in recentAlerts"
                :key="alert.id"
                class="border-b border-border/50 last:border-b-0 hover:bg-accent/40"
              >
                <td class="px-5 py-2.5 font-medium">
                  {{ alert.deviceName }}
                </td>
                <td class="px-5 py-2.5 text-muted-foreground">
                  {{ alert.ruleName }}
                </td>
                <td class="px-5 py-2.5">
                  <Tag
                    :color="SEVERITY_TAG_COLORS[alert.severity] ?? 'default'"
                    class="!mr-0"
                  >
                    {{ alert.severityLabel }}
                  </Tag>
                </td>
                <td class="px-5 py-2.5 text-muted-foreground">
                  {{ alert.stateLabel }}
                </td>
                <td class="px-5 py-2.5 tabular-nums text-muted-foreground">
                  {{ alert.triggeredAt }}
                </td>
              </tr>
              <tr v-if="recentAlerts.length === 0">
                <td
                  colspan="5"
                  class="px-5 py-8 text-center text-muted-foreground"
                >
                  {{ $t('page.dashboard.noData') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <AnalysisChartCard
        class="xl:w-[340px] xl:shrink-0"
        :title="$t('page.dashboard.ruleTopTitle')"
      >
        <AnalyticsRuleTop :items="alertRuleTopItems" />
      </AnalysisChartCard>
    </div>

    <HelpDrawerContainer />
    <BoardDrawerContainer />
  </div>
</template>

<style scoped>
/*
 * 只剩本页专属的 hero 渐变底色。指标卡（.iot-metric-card）与入场动画已抽到
 * shared/metric-visuals.css —— 那一份同时带 `prefers-reduced-motion` 兜底，
 * 两页共用才不会出现「一页关了动效、一页没关」。
 */
.iot-hero {
  background: linear-gradient(
    120deg,
    hsl(var(--primary) / 10%),
    hsl(245deg 82% 67% / 8%) 50%,
    hsl(199deg 89% 48% / 10%)
  );
}
</style>
