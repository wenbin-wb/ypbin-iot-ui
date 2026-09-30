<script lang="ts" setup>
import type { TabOption } from '@vben/types';

import { computed } from 'vue';
import { useRouter } from 'vue-router';

import { AnalysisChartCard, AnalysisChartsTabs } from '@vben/common-ui';

import { Tag } from 'ant-design-vue';

import { $t } from '#/locales';

import { useIotOverview } from '../shared/use-iot-overview';
import AnalyticsTrends from './analytics-trends.vue';
import AnalyticsVisitsData from './analytics-visits-data.vue';
import AnalyticsVisitsSales from './analytics-visits-sales.vue';
import AnalyticsVisitsSource from './analytics-visits-source.vue';
import AnalyticsVisits from './analytics-visits.vue';

// ---- 统一视觉（与工作台同一套语言）----
const BRAND_GRAD =
  'linear-gradient(135deg, hsl(var(--primary)), hsl(245 82% 67%))';

const router = useRouter();
const { loading, overview, usingDemo } = useIotOverview();

/** 演示数据兜底时页面数据可能为 null，模板统一走空对象口径 */
const data = computed(() => overview.value);

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

const overviewCards = computed(() => {
  const d = data.value;
  if (!d) return [];
  return [
    {
      key: 'device',
      icon: 'i-lucide-cpu',
      title: $t('page.dashboard.deviceTotal'),
      value: d.deviceTotal,
      footLeft: $t('page.dashboard.newDevicesWeek'),
      footRight: `+${d.newDevicesWeek}`,
      grad: 'linear-gradient(135deg, hsl(var(--primary)), hsl(245 82% 67%))',
      glow: 'hsl(var(--primary) / 30%)',
    },
    {
      key: 'online',
      icon: 'i-lucide-wifi',
      title: $t('page.dashboard.onlineRate'),
      value: `${d.onlineRate}%`,
      footLeft: $t('page.dashboard.online'),
      footRight: d.deviceOnline.toLocaleString(),
      grad: 'linear-gradient(135deg, hsl(161 90% 43%), hsl(199 89% 48%))',
      glow: 'hsl(161 90% 43% / 30%)',
    },
    {
      key: 'message',
      icon: 'i-lucide-radio-tower',
      title: $t('page.dashboard.messageToday'),
      value: formatCompact(d.messageToday),
      footLeft: $t('page.dashboard.downlink'),
      footRight: formatCompact(d.messageDownlinkToday),
      grad: 'linear-gradient(135deg, hsl(199 89% 48%), hsl(161 90% 43%))',
      glow: 'hsl(199 89% 48% / 30%)',
    },
    {
      key: 'alert',
      icon: 'i-lucide-triangle-alert',
      title: $t('page.dashboard.alertPending'),
      value: d.alertPending,
      footLeft: $t('page.dashboard.alertToday'),
      footRight: String(d.alertToday),
      grad: 'linear-gradient(135deg, hsl(32 95% 44%), hsl(16 90% 50%))',
      glow: 'hsl(32 95% 44% / 30%)',
    },
  ];
});

const chartTabs = computed<TabOption[]>(() => [
  { label: $t('page.dashboard.messageTrend'), value: 'trends' },
  { label: $t('page.dashboard.onlineTrend'), value: 'visits' },
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
          <h2
            class="mt-1 flex items-center gap-2 text-2xl font-bold tracking-tight"
          >
            {{ $t('page.dashboard.analyticsTitle') }}
            <Tag v-if="usingDemo" color="orange" class="!mr-0">
              {{ $t('page.dashboard.demoBadge') }}
            </Tag>
          </h2>
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
              :style="{
                background: BRAND_GRAD,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }"
            >
              {{ b.value }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- 指标卡（设备 / 在线率 / 消息 / 告警） -->
    <div
      v-if="loading"
      class="mt-5 h-[132px] animate-pulse rounded-xl bg-card"
    ></div>
    <div
      v-else
      class="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      <div
        v-for="(c, i) in overviewCards"
        :key="c.key"
        class="metric-card group relative overflow-hidden rounded-xl border border-border/80 bg-card p-5"
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
              :style="{
                background: c.grad,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }"
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

    <AnalysisChartsTabs v-if="!loading && data" :tabs="chartTabs" class="mt-5">
      <template #trends>
        <AnalyticsTrends :points="data.messageTrend" />
      </template>
      <template #visits>
        <AnalyticsVisits :points="data.onlineTrend" />
      </template>
    </AnalysisChartsTabs>
    <div
      v-else-if="!loading"
      class="mt-5 flex h-64 items-center justify-center rounded-xl border border-border/80 bg-card text-sm text-muted-foreground"
    >
      {{ $t('page.dashboard.loadFailed') }}
    </div>

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

    <!-- 最近告警（与告警中心同口径；查看全部跳转 /iot/alerts） -->
    <div v-if="data" class="mt-5 rounded-xl border border-border/80 bg-card">
      <div
        class="flex items-center justify-between border-b border-border/70 px-5 py-4"
      >
        <h3 class="text-sm font-semibold">
          {{ $t('page.dashboard.recentAlerts') }}
        </h3>
        <a class="text-xs text-primary" @click="goAlerts">
          {{ $t('page.dashboard.viewAllAlerts') }} →
        </a>
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
  </div>
</template>

<style scoped>
.iot-hero {
  background: linear-gradient(
    120deg,
    hsl(var(--primary) / 10%),
    hsl(245deg 82% 67% / 8%) 50%,
    hsl(199deg 89% 48% / 10%)
  );
}

.metric-card {
  transition:
    transform 0.25s ease,
    border-color 0.25s ease,
    box-shadow 0.25s ease;
  animation: metric-in 0.4s ease-out both;
}

.metric-card:hover {
  border-color: hsl(var(--primary) / 40%);
  box-shadow:
    0 8px 24px hsl(var(--foreground) / 8%),
    0 0 24px var(--glow);
  transform: translateY(-2px);
}

@keyframes metric-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}
</style>
