<script lang="ts" setup>
import type { SendResult } from './use-debug-command';

import { Alert, Tag, Tooltip } from 'ant-design-vue';

import { $t } from '#/locales';

import CopyText from '../../shared/copy-text.vue';
import { NOT_APPLICABLE_TEXT } from '../../shared/display';
import { statusColor, statusText } from './debug-status';

/**
 * 「本批下发结果」面板（逐条成功/失败 + 批次汇总）。
 *
 * 从 `detail-debug.vue` 拆出（2026-10-20 架构审查 §2.2）：约 75 行纯展示。
 *
 * 为什么要逐条展示而不是只报一个总数：一次点击会拆成 N 条独立指令（后端单条只接一个标识），
 * 只报「成功 N 条」会让用户无法知道**哪一条**失败；失败行必须带后端原文（可 hover 看原始信封）。
 */
withDefaults(
  defineProps<{
    /** 本批序号（前端本地计数，仅用于区分批次）。 */
    batchSequence?: number;
    /** 成功/失败条数汇总。 */
    batchSummary?: { failed: number; ok: number };
    /** 本批逐条结果。 */
    sendResults?: SendResult[];
  }>(),
  {
    batchSequence: 0,
    batchSummary: () => ({ failed: 0, ok: 0 }),
    sendResults: () => [],
  },
);
</script>

<template>
  <div
    v-if="sendResults.length > 0"
    class="mt-3 rounded border border-solid p-3"
  >
    <div class="mb-2 font-semibold">
      {{ $t('page.iot.debug.batchTitle', [String(batchSequence)]) }}
    </div>
    <Alert
      :message="
        $t('page.iot.debug.batchSummary', [
          String(sendResults.length),
          String(batchSummary.ok),
          String(batchSummary.failed),
        ])
      "
      :type="batchSummary.failed > 0 ? 'warning' : 'success'"
      show-icon
    />
    <div class="mt-2 overflow-x-auto">
      <table class="w-full min-w-[520px] text-sm">
        <thead>
          <tr
            class="border-b border-border/60 text-left text-xs text-muted-foreground"
          >
            <th class="py-1.5 pr-3 font-medium">
              {{ $t('page.iot.debug.columnIdentifier') }}
            </th>
            <th class="py-1.5 pr-3 font-medium">
              {{ $t('page.iot.debug.requestId') }}
            </th>
            <th class="py-1.5 font-medium">
              {{ $t('page.iot.debug.columnStatus') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(item, index) in sendResults"
            :key="index"
            class="border-t border-border/60"
          >
            <td class="py-1.5 pr-3">
              {{ item.identifier || NOT_APPLICABLE_TEXT }}
            </td>
            <td class="py-1.5 pr-3">
              <CopyText :value="item.requestId" />
            </td>
            <td class="py-1.5">
              <Tag v-if="item.error" color="error">
                {{ $t('page.iot.debug.sendFailed') }}
              </Tag>
              <Tag v-else :color="statusColor(item.statusCode)">
                {{ statusText(item.statusCode) }}
              </Tag>
              <Tooltip v-if="item.error" :title="item.raw || item.error">
                <span class="ml-2 text-xs break-all">{{ item.error }}</span>
              </Tooltip>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="mt-1 text-xs text-muted-foreground">
      {{ $t('page.iot.debug.batchHint') }}
    </div>
  </div>
</template>
