<script lang="ts" setup>
import type {
  WorkbenchProjectItem,
  WorkbenchQuickNavItem,
  WorkbenchTodoItem,
} from '@vben/common-ui';

import { computed } from 'vue';
import { useRouter } from 'vue-router';

import {
  useVbenDrawer,
  WorkbenchHeader,
  WorkbenchProject,
  WorkbenchQuickNav,
  WorkbenchTodo,
  WorkbenchTrends,
} from '@vben/common-ui';
import { preferences, usePreferences } from '@vben/preferences';
import { useUserStore } from '@vben/stores';

import { Alert, Button, Empty, Spin, Tag, Tooltip } from 'ant-design-vue';

import { $t } from '#/locales';
import { formatCompact } from '#/utils/number-format';

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
import { useWorkbenchTrends } from './use-workbench-trends';

const userStore = useUserStore();
const router = useRouter();
const { isDark } = usePreferences();

// 运行总览：notice 必须接 —— 失败要常驻错误态 + 重试，演示兜底要常驻标注（见 04 §P0-1）
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

function openHelp() {
  helpDrawerApi.open();
}

// 最近告警动态流
const { trendItems } = useWorkbenchTrends(overview);

// ---- 统一视觉（与分析页同一份常量，见 shared/metric-visuals.ts）----
/** 页头三个关键计数的文字色（亮/暗各一档，均 ≥4.5:1；不是渐变裁切字）。 */
const headerCountColor = computed(() => brandTextColor(isDark.value));

// ---- IoT 今日概览指标 ----
interface MetricCard {
  key: 'alert' | 'device' | 'message' | 'online';
  label: string;
  value: string;
  icon: string;
  grad: string;
  glow: string;
  /** 数值文字色（亮/暗按主题切换，各自对卡片底色 ≥4.5:1）。 */
  textColor: string;
}

const metricCards = computed<MetricCard[]>(() => {
  const d = overview.value;
  return [
    {
      key: 'device',
      label: $t('page.dashboard.deviceTotal'),
      value: d ? d.deviceTotal.toLocaleString() : '—',
      icon: 'i-lucide-cpu',
      ...METRIC_VISUALS.device,
      textColor: metricTextColor('device', isDark.value),
    },
    {
      key: 'online',
      label: $t('page.dashboard.onlineRate'),
      value: d ? `${d.onlineRate}%` : '—',
      icon: 'i-lucide-wifi',
      ...METRIC_VISUALS.online,
      textColor: metricTextColor('online', isDark.value),
    },
    {
      key: 'message',
      label: $t('page.dashboard.messageToday'),
      value: d ? formatCompact(d.messageToday) : '—',
      icon: 'i-lucide-radio-tower',
      ...METRIC_VISUALS.message,
      textColor: metricTextColor('message', isDark.value),
    },
    {
      key: 'alert',
      label: $t('page.dashboard.alertPending'),
      value: d ? String(d.alertPending) : '—',
      icon: 'i-lucide-triangle-alert',
      ...METRIC_VISUALS.alert,
      textColor: metricTextColor('alert', isDark.value),
    },
  ];
});

/**
 * 实时鉴权失败时的「重新登录」。
 *
 * 动态 import：`#/api/request` 会拉起 axios + Pinia store + 埋点，
 * 只有用户点这一下才需要，页面首屏与单测都不该为它付加载成本。
 */
async function onRelogin() {
  const { handleSessionExpired } = await import('#/api/request');
  await handleSessionExpired();
}

/**
 * 模块卡片的图标底色（**只是分类标识，不承载状态语义**）。
 *
 * 用语义 token 而非 hex 的两个理由：① 切主题色/暗色时色块自动跟随；② 不再散落硬编码色值。
 * 6 个取值按「主色三档 + 成功/警告/危险」分布，保证相邻卡片颜色不同。
 * 这里是 DOM 内联样式，CSS 变量可直接用 —— 图表 canvas 不行，见 `shared/chart-tokens.ts`。
 */
const CARD_TINTS = [
  'hsl(var(--primary))',
  'hsl(var(--primary-600))',
  'hsl(var(--success))',
  'hsl(var(--warning))',
  'hsl(var(--destructive))',
  'hsl(var(--primary-400))',
] as const;

// ---- 快捷导航（IoT 模块，路径与后端菜单一致）----
const quickNavItems: WorkbenchQuickNavItem[] = [
  {
    color: CARD_TINTS[0],
    icon: 'carbon:iot-platform',
    title: $t('page.iot.device.title'),
    url: '/iot/devices',
  },
  {
    color: CARD_TINTS[1],
    icon: 'carbon:product',
    title: $t('page.iot.product.title'),
    url: '/iot/products',
  },
  {
    color: CARD_TINTS[2],
    icon: 'carbon:warning',
    title: $t('page.iot.alert.title'),
    url: '/iot/alerts',
  },
  {
    color: CARD_TINTS[3],
    icon: 'carbon:group',
    title: $t('page.iot.group.title'),
    url: '/iot/groups',
  },
  {
    color: CARD_TINTS[4],
    icon: 'carbon:flow',
    title: $t('page.iot.onboarding.title'),
    url: '/iot/onboarding',
  },
  {
    color: CARD_TINTS[5],
    icon: 'carbon:tool-box',
    title: $t('page.iot.maintenance.shortTitle'),
    url: '/iot/maintenance',
  },
];

// ---- 平台能力卡片（IoT 功能入口）----
/** 与快捷导航同一套色（同一模块在两个区域颜色一致，用户不用记两套）。 */
const PROJECT_COLORS = CARD_TINTS;

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

// ---- 运营待办 ----
// 真实总览返回后，按「告警 → 离线 → 无产品 → 无设备 → 无上报」的优先级生成可执行待办；
// 演示兜底时仍用静态示例并保留「演示数据」标注，避免把演示数字当真实结论。
const demoTodoItems = computed<WorkbenchTodoItem[]>(() => [
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

const realTodoItems = computed<WorkbenchTodoItem[]>(() => {
  const d = overview.value;
  if (!d) {
    return [];
  }
  const today = $t('page.dashboard.today');
  const items: WorkbenchTodoItem[] = [];
  if (d.alertPending > 0) {
    items.push({
      title: $t('page.dashboard.todoAlertPending'),
      content: $t('page.dashboard.todoAlertPendingContent', [
        String(d.alertPending),
      ]),
      completed: false,
      date: today,
    });
  }
  if (d.deviceOffline > 0) {
    items.push({
      title: $t('page.dashboard.todoDeviceOffline'),
      content: $t('page.dashboard.todoDeviceOfflineContent', [
        String(d.deviceOffline),
      ]),
      completed: false,
      date: today,
    });
  }
  if (d.productTotal === 0) {
    items.push({
      title: $t('page.dashboard.todoNoProduct'),
      content: $t('page.dashboard.todoNoProductContent'),
      completed: false,
      date: today,
    });
  } else if (d.deviceTotal === 0) {
    items.push({
      title: $t('page.dashboard.todoNoDevice'),
      content: $t('page.dashboard.todoNoDeviceContent'),
      completed: false,
      date: today,
    });
  } else if (d.messageToday === 0) {
    items.push({
      title: $t('page.dashboard.todoNoMessage'),
      content: $t('page.dashboard.todoNoMessageContent'),
      completed: false,
      date: today,
    });
  }
  if (items.length === 0) {
    items.push({
      title: $t('page.dashboard.todoAllGood'),
      content: $t('page.dashboard.todoAllGoodContent'),
      completed: true,
      date: today,
    });
  }
  return items.slice(0, 4);
});

const todoItems = computed<WorkbenchTodoItem[]>(() =>
  usingDemo.value ? demoTodoItems.value : realTodoItems.value,
);

const todoTitle = computed(() =>
  usingDemo.value
    ? `${$t('page.dashboard.todoTitle')}${$t('page.dashboard.demoSuffix')}`
    : $t('page.dashboard.todoTitle'),
);

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
    <!--
      页面主标题：视觉上标题是下面的问候语，但问候语挂在 WorkbenchHeader 的插槽里
      （基座组件内部是普通文本节点，塞 <h1> 会跟它自己的排版打架）。
      这里给一个读屏可见、视觉隐藏的 <h1> —— 目标只是让「按 H 跳标题」能定位到本页，
      不改变任何视觉（全站此前 0 个 h1，读屏用户没有任何页面主题锚点）。
    -->
    <h1 class="sr-only">{{ $t('page.dashboard.workspace') }}</h1>

    <!--
      常驻提示（不再藏 hover tooltip）：
      ① 总览失败 ⇒ 错误态 + 重试；② 演示兜底 ⇒ 明确标注「非真实指标」；
      ③ 实时鉴权失败 ⇒ 单独提示（重连解决不了 token 过期），unauthorized 给「重新登录」。
    -->
    <ListErrorAlert
      v-if="notice"
      class="mb-3"
      :error="notice.error"
      :retry-text="$t('page.dashboard.retry')"
      :title="notice.title"
      :type="notice.type"
      @retry="() => void load()"
    />
    <Alert
      v-if="authError === 'forbidden'"
      class="mb-3"
      :message="$t('page.iot.realtime.forbidden')"
      show-icon
      type="error"
    />
    <Alert
      v-if="authError === 'unauthorized'"
      class="mb-3"
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
      class="mb-3"
      :description="$t('page.iot.realtime.disconnectedHint', [realtimeError])"
      :message="$t('page.iot.realtime.disconnected')"
      show-icon
      type="warning"
    />

    <!-- 页头：问候 + 右侧关键计数 -->
    <WorkbenchHeader :avatar="avatar">
      <template #title>
        <span class="inline-flex items-center gap-2">
          {{ welcomeTitle }}
          <Tooltip v-if="usingDemo" :title="$t('page.dashboard.demoReason')">
            <!-- tabindex=0：让键盘用户也能把焦点停在徽标上读到原因（原先只有鼠标 hover） -->
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
        </span>
      </template>
      <template #description>
        {{ $t('page.dashboard.headerDesc') }}
      </template>
      <template #actions>
        <div
          class="flex flex-wrap items-center justify-end gap-x-6 gap-y-2 md:gap-10"
        >
          <div class="flex flex-col items-end">
            <span class="text-xs text-muted-foreground">{{
              $t('page.dashboard.deviceTotal')
            }}</span>
            <span
              class="text-2xl font-bold tabular-nums leading-none"
              :style="{ color: headerCountColor }"
            >
              {{ overview ? overview.deviceTotal.toLocaleString() : '—' }}
            </span>
          </div>
          <div class="flex flex-col items-end">
            <span class="text-xs text-muted-foreground">{{
              $t('page.dashboard.online')
            }}</span>
            <span
              class="text-2xl font-bold tabular-nums leading-none"
              :style="{ color: headerCountColor }"
            >
              {{ overview ? overview.deviceOnline.toLocaleString() : '—' }}
            </span>
          </div>
          <div class="flex flex-col items-end">
            <span class="text-xs text-muted-foreground">{{
              $t('page.dashboard.alertPending')
            }}</span>
            <span
              class="text-2xl font-bold tabular-nums leading-none"
              :style="{ color: headerCountColor }"
            >
              {{ overview ? overview.alertPending : '—' }}
            </span>
          </div>
        </div>
      </template>
    </WorkbenchHeader>

    <!-- 今日概览指标条 -->
    <div class="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div
        v-for="(m, i) in metricCards"
        :key="m.key"
        class="iot-metric-card group relative overflow-hidden rounded-xl border border-border/80 bg-card p-4"
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
              :style="{ color: m.textColor }"
            >
              {{ m.value }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- 新手快速上手：三步接入 + 术语帮助入口（与首页分析页同一份卡片） -->
    <NoviceGuideCard class="mt-5" @open-help="openHelp" />

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
        <WorkbenchTodo :items="todoItems" :title="todoTitle" />
      </div>
    </div>

    <HelpDrawerContainer />
  </div>
</template>

<style scoped>
/*
 * 指标卡样式（.iot-metric-card / 入场动画 / prefers-reduced-motion）已抽到
 * shared/metric-visuals.css，由 shared/metric-visuals.ts 引入 —— 两页共用一份，
 * 避免「一页改了动效、另一页没改」。本页不再需要页面级指标卡样式。
 */
</style>
