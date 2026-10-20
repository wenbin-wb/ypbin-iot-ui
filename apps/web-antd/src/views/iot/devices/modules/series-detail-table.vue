<script lang="ts" setup>
import type { SeriesDetailRow } from './series-utils';

import { $t } from '#/locales';

import { displayOrFallback, qualityLabel } from '../../shared/display';

/**
 * 历史曲线「明细表」（审查 P2-6 拆分之三）。
 *
 * 只做**展示**：行数据/是否多点位/是否截断全部由查询域算好传进来（窄 props），
 * 它自己不发请求、不读全局状态。这样「截断提示」与「表格行」天然同源——
 * 历史上曾出现「表格显示前 500 行但没提示还有多少」，就是因为两处各算一份。
 */
const props = defineProps<{
  /** 明细行数上限（截断提示里的 {0}）。 */
  maxRows: number;
  /** 多点位叠加时首列显示点位名（否则多行数据混在一起无法区分）。 */
  multiSeries: boolean;
  /** 明细行（已按时间排序并截断到上限）。 */
  rows: SeriesDetailRow[];
  /** 本次查询的**总行数**（未截断前；用于截断提示与空态判断）。 */
  total: number;
  /** 是否被截断（`total > rows.length`）。 */
  truncated: boolean;
}>();
</script>

<template>
  <div class="mt-3 max-h-[320px] overflow-auto">
    <table class="w-full min-w-[560px] text-sm">
      <thead>
        <tr class="text-left text-muted-foreground">
          <th v-if="props.multiSeries" class="py-1">
            {{ $t('page.iot.series.pointColumn') }}
          </th>
          <th class="py-1">{{ $t('page.iot.series.ts') }}</th>
          <th class="py-1">{{ $t('page.iot.series.value') }}</th>
          <th class="py-1">{{ $t('page.iot.series.quality') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in props.rows" :key="row.key" class="border-t">
          <td v-if="props.multiSeries" class="py-1">{{ row.name }}</td>
          <td class="py-1">{{ row.ts }}</td>
          <td class="py-1">{{ displayOrFallback(row.value) }}</td>
          <td class="py-1">{{ qualityLabel(row.quality) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <!-- 截断必须显式告知，否则用户以为「就这么多」 -->
  <div v-if="props.truncated" class="mt-1 text-xs text-muted-foreground">
    {{
      $t('page.iot.series.detailTruncated', [
        String(props.maxRows),
        String(props.total),
      ])
    }}
  </div>
</template>
