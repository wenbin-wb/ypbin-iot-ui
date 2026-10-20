<script lang="ts" setup>
import type { IotShadowApi } from '#/api/iot';

import { Alert, Empty } from 'ant-design-vue';

import { $t } from '#/locales';

import { formatDateTime, prettyJson } from '../../shared/display';
import ShadowDiff from './shadow-diff.vue';

/**
 * 概览 · 设备影子卡（reported / desired 两卡并排 + 差异对比）。
 *
 * 为什么影子独立成卡：三块只依赖同一个影子响应（父组件一次 `load()` 拉齐），
 * 与最新值/可用率无耦合；拆出后 detail.vue 不再承载影子展示细节。
 *
 * 布局契约：reported / desired 必须保持 `md:grid-cols-2` 并排（窄屏单列），差异卡在其下方。
 * 失败语义：失败绝不画成空态；reported 为空只说「没有可展示的上报记录」，**不得**推断设备没上报。
 */
const props = defineProps<{
  /** 设备 id（影子编辑要用）。 */
  deviceId: string;
  /** 影子快照。 */
  shadow?: IotShadowApi.ShadowResp;
  /** 查询失败原因（非空即错误态）。 */
  shadowError: string;
}>();

const emit = defineEmits<{ saved: [] }>();

/** 影子值 → 展示文本：空值给 `-`，对象给格式化 JSON（避免 `[object Object]` 撑破布局）。 */
function shadowValueText(value: unknown): string {
  if (value === null || value === undefined) {
    return '-';
  }
  if (typeof value === 'object') {
    try {
      return prettyJson(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
  const text = String(value);
  return text.trim() === '' ? '-' : text;
}

/** 打平影子键值（键=属性标识），供表格渲染。 */
function shadowRows(map?: Record<string, unknown>) {
  return Object.entries(map ?? {}).map(([key, value]) => ({
    key,
    value: shadowValueText(value),
  }));
}
</script>

<template>
  <div class="space-y-4">
    <!-- 设备影子：reported / desired 两卡响应式并排 -->
    <div class="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
      <section
        class="rounded-xl border border-border/80 bg-card p-4"
        data-section="overview-shadow-reported"
      >
        <h3 class="mb-3 text-sm font-semibold">
          {{ $t('page.iot.shadow.reported') }}
        </h3>
        <Alert
          v-if="shadowError"
          :message="shadowError"
          show-icon
          type="error"
        />
        <template v-else>
          <!--
            如实语义：这里只展示「平台已写入影子的上报值」。
            为空只能说「当前没有可展示的上报记录」，**不得**推断成「设备没上报」
            （后端 reported 写入链路已存在，见 AvailabilityServiceImpl#shadowReportedWriter）。
          -->
          <template v-if="shadowRows(shadow?.reported).length === 0">
            <Empty :description="$t('page.iot.shadow.reportedEmpty')" />
            <div class="mt-2 text-xs text-muted-foreground">
              {{ $t('page.iot.shadow.reportedEmptyHint') }}
            </div>
          </template>
          <div v-else class="overflow-x-auto">
            <table class="w-full min-w-[320px] text-sm">
              <tbody>
                <tr
                  v-for="row in shadowRows(shadow?.reported)"
                  :key="row.key"
                  class="border-t border-border/60"
                >
                  <td class="py-1.5 pr-3 break-all">{{ row.key }}</td>
                  <td class="py-1.5 break-all whitespace-pre-wrap">
                    {{ row.value }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="mt-2 text-xs text-muted-foreground">
            {{ $t('page.iot.shadow.reportTs') }}:
            {{ formatDateTime(shadow?.reportTs) }}
          </div>
        </template>
      </section>

      <section
        class="rounded-xl border border-border/80 bg-card p-4"
        data-section="overview-shadow-desired"
      >
        <h3 class="mb-3 text-sm font-semibold">
          {{ $t('page.iot.shadow.desired') }}
        </h3>
        <Empty
          v-if="shadowRows(shadow?.desired).length === 0"
          :description="$t('page.iot.shadow.empty')"
        />
        <div v-else class="overflow-x-auto">
          <table class="w-full min-w-[320px] text-sm">
            <tbody>
              <tr
                v-for="row in shadowRows(shadow?.desired)"
                :key="row.key"
                class="border-t border-border/60"
              >
                <td class="py-1.5 pr-3 break-all">{{ row.key }}</td>
                <td class="py-1.5 break-all whitespace-pre-wrap">
                  {{ row.value }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="mt-2 text-xs text-muted-foreground">
          {{ $t('page.iot.shadow.desiredTs') }}:
          {{ formatDateTime(shadow?.desiredTs) }}
        </div>
      </section>
    </div>

    <!--
      影子差异对比：reported / desired 逐键四态，与两张卡同区但独立成卡。
      只读区块（无 iot:shadow:update 也完整可见），写入口（手工编辑 / 一键应用）在其内部把门。
    -->
    <section
      class="rounded-xl border border-border/80 bg-card p-4"
      data-section="overview-shadow-diff"
    >
      <ShadowDiff
        :desired="shadow?.desired"
        :device-id="deviceId"
        :reported="shadow?.reported"
        @saved="emit('saved')"
      />
    </section>
  </div>
</template>
