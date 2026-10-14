<script lang="ts" setup>
import type { Component } from 'vue';

import { useRouter } from 'vue-router';

import {
  ArrowRightToLine,
  BookOpenText,
  CircleCheckBig,
  CircleHelp,
  LayoutGrid,
  Plus,
} from '@vben/icons';

import { Button } from 'ant-design-vue';

import { $t } from '#/locales';

/**
 * 首页/工作台共用的「新手快速上手」卡片。
 *
 * 面向第一次接触物联网平台的物业/值班人员：三步走完就能接入第一台设备，
 * 每步只讲「为什么」和「去哪点」，并直跳目标页面；术语不清楚时统一打开帮助抽屉，
 * 不在卡片里再抄一遍术语解释（避免口径漂移）。
 *
 * 不做「关闭后不再显示」的持久化：一是当前没有偏好接口，二是本卡片是新手唯一入口，
 * 老用户可通过收起态/帮助入口自行忽略，不引入本地存储与过期逻辑。
 */
defineOptions({ name: 'NoviceGuideCard' });

const emit = defineEmits<{
  openHelp: [];
}>();

const router = useRouter();

interface GuideStep {
  /** 跳转按钮文案 i18n 键。 */
  actionKey: string;
  /** 这一步为什么做/做什么的 i18n 键。 */
  descKey: string;
  icon: Component;
  titleKey: string;
  /** 目标路由（与后端菜单路径一致）。 */
  url: string;
}

const STEPS: GuideStep[] = [
  {
    actionKey: 'page.dashboard.novice.step1Action',
    descKey: 'page.dashboard.novice.step1Desc',
    icon: LayoutGrid,
    titleKey: 'page.dashboard.novice.step1Title',
    url: '/iot/products',
  },
  {
    actionKey: 'page.dashboard.novice.step2Action',
    descKey: 'page.dashboard.novice.step2Desc',
    icon: CircleCheckBig,
    titleKey: 'page.dashboard.novice.step2Title',
    url: '/iot/products',
  },
  {
    actionKey: 'page.dashboard.novice.step3Action',
    descKey: 'page.dashboard.novice.step3Desc',
    icon: Plus,
    titleKey: 'page.dashboard.novice.step3Title',
    url: '/iot/devices',
  },
];

/** 两个最常被问到的概念，给一句话结论；详情交给术语词典。 */
const CONCEPT_KEYS = [
  'page.dashboard.novice.conceptAlert',
  'page.dashboard.novice.conceptMaintenance',
];

function go(url: string) {
  void router.push(url);
}
</script>

<template>
  <div class="rounded-xl border border-border/80 bg-card p-5">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 class="flex items-center gap-2 text-sm font-semibold">
          <CircleHelp class="size-4 text-primary" />
          {{ $t('page.dashboard.novice.title') }}
        </h3>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ $t('page.dashboard.novice.subtitle') }}
        </p>
      </div>
      <Button size="small" type="link" @click="emit('openHelp')">
        <BookOpenText class="size-4" />
        {{ $t('page.iot.help.openHint') }}
      </Button>
    </div>

    <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
      <div
        v-for="(step, index) in STEPS"
        :key="step.titleKey"
        class="flex flex-col rounded-lg border border-border/70 bg-background/60 p-3"
      >
        <div class="flex items-center gap-2">
          <span
            class="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
          >
            {{ index + 1 }}
          </span>
          <component :is="step.icon" class="size-4 shrink-0 text-primary" />
          <span class="text-sm font-medium">{{ $t(step.titleKey) }}</span>
        </div>
        <p class="mt-2 flex-1 text-xs leading-relaxed text-muted-foreground">
          {{ $t(step.descKey) }}
        </p>
        <div class="mt-3">
          <Button size="small" @click="go(step.url)">
            {{ $t(step.actionKey) }}
            <ArrowRightToLine class="size-3.5" />
          </Button>
        </div>
      </div>
    </div>

    <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
      <ul class="m-0 list-none space-y-1 p-0 text-xs text-muted-foreground">
        <li v-for="key in CONCEPT_KEYS" :key="key">{{ $t(key) }}</li>
      </ul>
      <Button size="small" type="link" @click="go('/iot/onboarding')">
        {{ $t('page.dashboard.novice.wizard') }} →
      </Button>
    </div>
  </div>
</template>
