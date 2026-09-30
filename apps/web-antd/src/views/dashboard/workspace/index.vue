<script lang="ts" setup>
import type {
  WorkbenchProjectItem,
  WorkbenchQuickNavItem,
  WorkbenchTodoItem,
} from '@vben/common-ui';

import { computed } from 'vue';
import { useRouter } from 'vue-router';

import {
  WorkbenchHeader,
  WorkbenchProject,
  WorkbenchQuickNav,
  WorkbenchTodo,
  WorkbenchTrends,
} from '@vben/common-ui';
import { preferences } from '@vben/preferences';
import { useUserStore } from '@vben/stores';

import { Empty, Spin, Tag } from 'ant-design-vue';

import { $t } from '#/locales';

import { useIotOverview } from '../shared/use-iot-overview';
import { useWorkbenchTrends } from './use-workbench-trends';

const userStore = useUserStore();
const router = useRouter();

// 运行总览（真实接口缺位时演示数据兜底，页面上以徽标标注）
const { loading, overview, usingDemo } = useIotOverview();

// 最近告警动态流
const { trendItems } = useWorkbenchTrends(overview);

// ---- 统一视觉（与分析页同一套语言）----
const BRAND_GRAD =
  'linear-gradient(135deg, hsl(var(--primary)), hsl(245 82% 67%))';

// ---- IoT 今日概览指标 ----
interface MetricCard {
  key: string;
  label: string;
  value: string;
  icon: string;
  grad: string;
  glow: string;
}

const metricCards = computed<MetricCard[]>(() => {
  const d = overview.value;
  return [
    {
      key: 'device',
      label: $t('page.dashboard.deviceTotal'),
      value: d ? d.deviceTotal.toLocaleString() : '—',
      icon: 'i-lucide-cpu',
      grad: 'linear-gradient(135deg, hsl(var(--primary)), hsl(245 82% 67%))',
      glow: 'hsl(var(--primary) / 30%)',
    },
    {
      key: 'online',
      label: $t('page.dashboard.onlineRate'),
      value: d ? `${d.onlineRate}%` : '—',
      icon: 'i-lucide-wifi',
      grad: 'linear-gradient(135deg, hsl(161 90% 43%), hsl(199 89% 48%))',
      glow: 'hsl(161 90% 43% / 30%)',
    },
    {
      key: 'message',
      label: $t('page.dashboard.messageToday'),
      value: d ? formatCompact(d.messageToday) : '—',
      icon: 'i-lucide-radio-tower',
      grad: 'linear-gradient(135deg, hsl(199 89% 48%), hsl(161 90% 43%))',
      glow: 'hsl(199 89% 48% / 30%)',
    },
    {
      key: 'alert',
      label: $t('page.dashboard.alertPending'),
      value: d ? String(d.alertPending) : '—',
      icon: 'i-lucide-triangle-alert',
      grad: 'linear-gradient(135deg, hsl(32 95% 44%), hsl(16 90% 50%))',
      glow: 'hsl(32 95% 44% / 30%)',
    },
  ];
});

function formatCompact(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

// ---- 快捷导航（IoT 模块，路径与后端菜单一致）----
const quickNavItems: WorkbenchQuickNavItem[] = [
  {
    color: '#0066f5',
    icon: 'carbon:iot-platform',
    title: $t('page.iot.device.title'),
    url: '/iot/devices',
  },
  {
    color: '#7c7cf0',
    icon: 'carbon:product',
    title: $t('page.iot.product.title'),
    url: '/iot/products',
  },
  {
    color: '#f2547b',
    icon: 'carbon:warning',
    title: $t('page.iot.alert.title'),
    url: '/iot/alerts',
  },
  {
    color: '#0ec9a3',
    icon: 'carbon:group',
    title: $t('page.iot.group.title'),
    url: '/iot/groups',
  },
  {
    color: '#f0b429',
    icon: 'carbon:flow',
    title: $t('page.iot.onboarding.title'),
    url: '/iot/onboarding',
  },
  {
    color: '#5a6cf0',
    icon: 'carbon:tool-box',
    title: $t('page.iot.maintenance.shortTitle'),
    url: '/iot/maintenance',
  },
];

// ---- 平台能力卡片（IoT 功能入口）----
const PROJECT_COLORS = [
  '#0066f5',
  '#7c7cf0',
  '#0ec9a3',
  '#f0b429',
  '#f2547b',
  '#5a6cf0',
];

const projectItems = computed<WorkbenchProjectItem[]>(() => [
  {
    title: $t('page.iot.onboarding.title'),
    icon: 'carbon:flow',
    color: PROJECT_COLORS[0],
    content: $t('page.dashboard.featOnboardContent'),
    group: $t('page.dashboard.grpAccess'),
    date: $t('page.dashboard.justNow'),
    url: '/iot/onboarding',
  },
  {
    title: $t('page.iot.product.title'),
    icon: 'carbon:model-alt',
    color: PROJECT_COLORS[1],
    content: $t('page.dashboard.featModelContent'),
    group: $t('page.dashboard.grpAccess'),
    date: $t('page.dashboard.justNow'),
    url: '/iot/products',
  },
  {
    title: $t('page.iot.device.title'),
    icon: 'carbon:iot-platform',
    color: PROJECT_COLORS[2],
    content: $t('page.dashboard.featDeviceContent'),
    group: $t('page.dashboard.grpMonitor'),
    date: $t('page.dashboard.justNow'),
    url: '/iot/devices',
  },
  {
    title: $t('page.iot.alert.title'),
    icon: 'carbon:warning',
    color: PROJECT_COLORS[3],
    content: $t('page.dashboard.featAlertContent'),
    group: $t('page.dashboard.grpOps'),
    date: $t('page.dashboard.justNow'),
    url: '/iot/alerts',
  },
  {
    title: $t('page.iot.group.title'),
    icon: 'carbon:group',
    color: PROJECT_COLORS[4],
    content: $t('page.dashboard.featGroupContent'),
    group: $t('page.dashboard.grpOps'),
    date: $t('page.dashboard.justNow'),
    url: '/iot/groups',
  },
  {
    title: $t('page.iot.maintenance.shortTitle'),
    icon: 'carbon:tool-box',
    color: PROJECT_COLORS[5],
    content: $t('page.dashboard.featMaintContent'),
    group: $t('page.dashboard.grpOps'),
    date: $t('page.dashboard.justNow'),
    url: '/iot/maintenance',
  },
]);

// ---- 运营待办（暂无后端接口，演示数据标注）----
const todoItems = computed<WorkbenchTodoItem[]>(() => [
  {
    title: $t('page.dashboard.todoAckAlert'),
    content: $t('page.dashboard.todoAckAlertContent'),
    completed: false,
    date: $t('page.dashboard.today'),
  },
  {
    title: $t('page.dashboard.todoCheckOffline'),
    content: $t('page.dashboard.todoCheckOfflineContent'),
    completed: false,
    date: $t('page.dashboard.today'),
  },
  {
    title: $t('page.dashboard.todoRule'),
    content: $t('page.dashboard.todoRuleContent'),
    completed: true,
    date: $t('page.dashboard.yesterday'),
  },
  {
    title: $t('page.dashboard.todoModel'),
    content: $t('page.dashboard.todoModelContent'),
    completed: false,
    date: $t('page.dashboard.thisWeek'),
  },
  {
    title: $t('page.dashboard.todoImport'),
    content: $t('page.dashboard.todoImportContent'),
    completed: false,
    date: $t('page.dashboard.thisWeek'),
  },
]);

const welcomeTitle = computed(
  () =>
    `${$t('page.dashboard.welcome')}, ${userStore.userInfo?.realName ?? ''}`,
);

const avatar = computed(
  () => userStore.userInfo?.avatar || preferences.app.defaultAvatar,
);

function navTo(nav: WorkbenchQuickNavItem) {
  if (nav.url?.startsWith('/')) {
    router.push(nav.url).catch((error) => {
      console.error('Navigation failed:', error);
    });
  }
}

function onProjectClick(item: WorkbenchProjectItem) {
  if (item.url?.startsWith('/')) {
    router.push(item.url).catch((error) => {
      console.error('Navigation failed:', error);
    });
  }
}
</script>

<template>
  <div class="p-5">
    <!-- 页头：问候 + 右侧关键计数 -->
    <WorkbenchHeader :avatar="avatar">
      <template #title>
        <span class="inline-flex items-center gap-2">
          {{ welcomeTitle }}
          <Tag v-if="usingDemo" color="orange" class="!mr-0">
            {{ $t('page.dashboard.demoBadge') }}
          </Tag>
        </span>
      </template>
      <template #description>
        {{ $t('page.dashboard.headerDesc') }}
      </template>
      <template #actions>
        <div class="flex items-center gap-6 md:gap-10">
          <div class="flex flex-col items-end">
            <span class="text-xs text-muted-foreground">{{
              $t('page.dashboard.deviceTotal')
            }}</span>
            <span
              class="text-2xl font-bold tabular-nums leading-none"
              :style="{
                background: BRAND_GRAD,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }"
              >{{
                overview ? overview.deviceTotal.toLocaleString() : '—'
              }}</span>
          </div>
          <div class="flex flex-col items-end">
            <span class="text-xs text-muted-foreground">{{
              $t('page.dashboard.online')
            }}</span>
            <span
              class="text-2xl font-bold tabular-nums leading-none"
              :style="{
                background: BRAND_GRAD,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }"
              >{{
                overview ? overview.deviceOnline.toLocaleString() : '—'
              }}</span>
          </div>
          <div class="flex flex-col items-end">
            <span class="text-xs text-muted-foreground">{{
              $t('page.dashboard.alertPending')
            }}</span>
            <span
              class="text-2xl font-bold tabular-nums leading-none"
              :style="{
                background: BRAND_GRAD,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }"
              >{{ overview ? overview.alertPending : '—' }}</span>
          </div>
        </div>
      </template>
    </WorkbenchHeader>

    <!-- 今日概览指标条 -->
    <div class="mt-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
      <div
        v-for="(m, i) in metricCards"
        :key="m.key"
        class="metric-card group relative overflow-hidden rounded-xl border border-border/80 bg-card p-4"
        :style="{ '--glow': m.glow, animationDelay: `${i * 60}ms` }"
      >
        <span
          class="pointer-events-none absolute -right-6 -top-6 size-20 rounded-full opacity-60 blur-2xl transition-opacity duration-300 group-hover:opacity-90"
          :style="{ background: m.grad }"
        ></span>
        <div class="relative flex items-center gap-3">
          <span
            class="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-white shadow-lg"
            :style="{ background: m.grad, boxShadow: `0 6px 16px ${m.glow}` }"
          >
            <span :class="m.icon" class="size-5"></span>
          </span>
          <div class="min-w-0">
            <p class="truncate text-xs text-muted-foreground">{{ m.label }}</p>
            <p
              class="truncate text-2xl font-bold tabular-nums leading-tight tracking-tight"
              :style="{
                background: m.grad,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }"
            >
              {{ m.value }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- 最近告警动态 + 快捷导航 -->
    <div class="mt-5 flex flex-col gap-4 xl:flex-row">
      <div class="min-w-0 flex-1">
        <Spin :spinning="loading">
          <WorkbenchTrends
            v-if="!loading && trendItems.length > 0"
            :items="trendItems"
            :title="
              usingDemo
                ? `${$t('page.dashboard.recentAlerts')}${$t('page.dashboard.demoSuffix')}`
                : $t('page.dashboard.recentAlerts')
            "
          />
          <Empty
            v-else-if="!loading"
            :description="$t('page.dashboard.noData')"
          />
        </Spin>
      </div>
      <div class="flex w-full flex-col gap-4 xl:w-[320px]">
        <WorkbenchQuickNav
          :items="quickNavItems"
          :title="$t('page.dashboard.quickNav')"
          @click="navTo"
        />
      </div>
    </div>

    <!-- 平台能力入口 -->
    <div class="mt-5">
      <WorkbenchProject
        :items="projectItems"
        :title="$t('page.dashboard.myProjects')"
        @click="onProjectClick"
      >
        <template #content="{ item }">
          <div
            class="text-muted-foreground mt-3 flex h-9 items-center text-[13px]"
          >
            {{ item.content }}
          </div>
        </template>
        <template #footer="{ item }">
          <div
            class="text-muted-foreground flex w-full justify-between text-xs"
          >
            <span class="flex items-center gap-1">
              <span class="i-lucide-folder size-3"></span>
              {{ item.group }}
            </span>
            <span>{{ item.date }}</span>
          </div>
        </template>
      </WorkbenchProject>
    </div>

    <!-- 运营待办（演示数据，标注） -->
    <div class="mt-5 flex flex-col gap-4 xl:flex-row">
      <div class="min-w-0 flex-1">
        <WorkbenchTodo
          :items="todoItems"
          :title="`${$t('page.dashboard.todoTitle')}${$t('page.dashboard.demoSuffix')}`"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
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
