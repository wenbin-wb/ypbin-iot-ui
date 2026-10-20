<script lang="ts" setup>
import type { SeriesQueryHooks } from './use-series-query';

import { useVbenDrawer } from '@vben/common-ui';

// vben-ui-dev-exempt: R2 本抽屉是「查询条件 + 即时出图」，不是提交型表单（没有 submit/reset 语义），
// 沿用本文件既有写法直接用 antd 组件；把 Select/RangePicker 塞进 useVbenForm schema 反而要另造一套
// 「选完即查」的联动，得不偿失。
import {
  Alert,
  Button,
  Collapse,
  CollapsePanel,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  RadioButton,
  RadioGroup,
  Select,
  Spin,
  Switch,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  IOT_SERIES_DEFAULT_LIMIT,
  IOT_SERIES_MAX_LIMIT,
} from '#/api/iot/series';
import { $t } from '#/locales';

import { EMPTY_TEXT } from '../../shared/display';
import SeriesChart from './series-chart.vue';
import SeriesDetailTable from './series-detail-table.vue';
import {
  IOT_SERIES_AUTO_REFRESH_MS,
  IOT_SERIES_DEFAULT_RANGE_MODE,
  IOT_SERIES_LIVE_MAX_POINTS,
  IOT_SERIES_MAX_SELECTED_POINTS,
  IOT_SERIES_TABLE_MAX_ROWS,
  loadSeriesPreferences,
} from './series-utils';
import { useSeriesLive } from './use-series-live';
import { useSeriesQuery } from './use-series-query';

/**
 * 历史曲线抽屉（设备台账与设备详情**共用这一份**）。
 *
 * 交互目标：**普通用户三步内看到曲线**——① 选点位（下拉，来自 `GET /devices/{id}/points`，默认选中第一个）
 * → ② 选时间（默认最近 24 小时 + 快捷档位）→ ③ 看曲线。打开抽屉即按默认条件自动查一次，
 * 不再要求用户先手写 `temperature` 这种内部标识符。
 *
 * 三条不能退让的语义（都来自后端契约，写错就是把「失败」演成「没数据」）：
 * 1. `from`/`to` 为空**不是**「最近 N 个点」，而是 `time >= 0` 升序取**最早的** N 个点
 *    （`IotDbTimeSeriesStore`：`ORDER BY time ASC LIMIT n`）⇒ 默认必须是显式的最近 24 小时；
 * 2. 「时序库未启用」等业务错误走 reject，必须原样展示后端 message，**绝不能**渲染成「该时间范围内无数据」；
 * 3. 后端一次只接受**一个**点位（`TimeSeriesQueryReq.propertyId` 单值）⇒ 多选由前端扇出多次请求后合并
 *    （见 `use-series-query.ts` 的 `runQuery`）。
 *
 * 本文件职责（拆分后，审查 P2-6）：抽屉壳 + 条件 UI + 图表/明细子组件 + 查询域与实时域的组合式接线。
 * 查询域（点位候选/时间范围/扇出查询/结果派生/CSV）在 `use-series-query.ts`；
 * 实时跟随/自动刷新在 `use-series-live.ts`；图表在 `series-chart.vue`；明细表在 `series-detail-table.vue`。
 */
interface SeriesDrawerData {
  deviceCode?: string;
  deviceName?: string;
  id: string;
  /**
   * 可选：打开时就选好的点位**标识符**。
   * 供设备详情「属性与点位」逐行点「历史曲线」复用本抽屉（不重画一套图表逻辑）。
   */
  propertyId?: string;
  /** 设备绑定的产品：用来把点位映射的属性主键翻译成标识符（详情页入口本轮已补传）。 */
  productId?: string;
}

/**
 * 查询域与实时域之间的钩子：两个组合式互相需要（live 要 runQuery，查询要清计数/重启自动刷新），
 * 用可变钩子在装配阶段接线，避免循环 import。
 */
const queryHooks: SeriesQueryHooks = {};

const query = useSeriesQuery(queryHooks);

const {
  chartModel,
  customRange,
  detail,
  deviceId,
  deviceLabel,
  exportLoading,
  hasChart,
  limit,
  loading,
  manualInput,
  manualPoints,
  modelWarning,
  multiSeries,
  noData,
  onAddManualPoint,
  onCustomRangeChange,
  onExportCsv,
  onPickRange,
  onPointsChange,
  onQuery,
  optionErrors,
  optionsEmpty,
  optionsLoading,
  orphanWarning,
  queried,
  rangeMode,
  reachedLimit,
  resetQuery,
  results,
  selectOptions,
  selectedPoints,
  totalCount,
  units,
  usedLimit,
  usedPoints,
  usedRange,
  usedRangeLabel,
  valueHint,
} = query;

const live = useSeriesLive({
  getDeviceId: () => query.deviceId.value,
  hasChart,
  isLoading: () => query.loading.value,
  results,
  runQuery: (targets, range, limitValue) =>
    query.runQuery(targets, range, limitValue),
  usedCustom: query.usedCustom,
  usedLimit: query.usedLimit,
  usedMode: query.usedMode,
  usedPoints: query.usedPoints,
});

const {
  autoRefresh,
  liveDroppedCount,
  liveFollow,
  liveFollowedCount,
  liveNonGoodCount,
  liveState,
  realtimeError,
  realtimeState,
  resetLiveFollow,
  restartAutoRefresh,
  stopAutoRefresh,
} = live;

// 装配双向钩子：查询前清实时计数；查询后重启自动刷新（两者都已创建，无循环依赖）
queryHooks.onBeforeQuery = live.resetLiveCounters;
queryHooks.onAfterQuery = restartAutoRefresh;

const [Drawer, drawerApi] = useVbenDrawer<SeriesDrawerData>({
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      // 关掉抽屉必须停表、退订：否则切走后仍在后台按周期打后端，或在内存里继续追加实时点
      stopAutoRefresh();
      resetLiveFollow();
      return;
    }
    // 换设备 / 重新打开：跟随开关回到关闭，清空上一轮的计数与订阅
    resetLiveFollow();
    const device = drawerApi.getData();
    // 每次打开都回到初始态：不把上一台设备的查询结果留在抽屉里
    query.deviceId.value = device?.id ?? '';
    query.deviceLabel.value =
      device?.deviceName ?? device?.deviceCode ?? query.deviceId.value;
    query.productId.value = device?.productId ?? '';
    const presetPropertyId = device?.propertyId ?? '';
    const preferences = loadSeriesPreferences();
    resetQuery(
      preferences.rangeMode ?? IOT_SERIES_DEFAULT_RANGE_MODE,
      preferences.limit ?? IOT_SERIES_DEFAULT_LIMIT,
    );
    autoRefresh.value = false;
    drawerApi.setState({
      title: deviceLabel.value
        ? `${$t('page.iot.series.title')} - ${deviceLabel.value}`
        : $t('page.iot.series.title'),
    });
    await query.loadOptions(presetPropertyId);
    // 打开即按默认条件（第一个点位 + 最近 24 小时）出图：用户不必先点一次查询才知道能看什么
    if (selectedPoints.value.length > 0) {
      await onQuery();
    }
  },
});
</script>
<template>
  <Drawer class="w-[min(1200px,96vw)]">
    <div class="mb-3 text-sm text-muted-foreground">
      {{ $t('page.iot.series.device') }}：{{ deviceLabel || EMPTY_TEXT }}
    </div>

    <!-- ===== 第 1 步：选点位（下拉候选，不再手填标识符） ===== -->
    <div class="mb-1 text-sm font-medium">
      {{ $t('page.iot.series.stepPoint') }}
    </div>
    <Spin :spinning="optionsLoading">
      <Alert
        v-if="optionErrors.points"
        :message="optionErrors.points"
        class="mb-2"
        show-icon
        type="error"
      />
      <Alert
        v-if="optionErrors.model"
        :message="optionErrors.model"
        class="mb-2"
        show-icon
        type="warning"
      />
      <!--
        降级提示按「最相关的先说」排成 v-else-if 链，同一时刻**只给一条**：
        物模型不可用（根因 + 动作）→ 个别点位解析不出标识符（数量 + 手动补录）→ 候选为空（去配点位映射）。
        上面的两条 error Alert 是**真实失败**，与提示不互斥（失败必须报，提示负责给下一步）。
      -->
      <Alert
        v-if="modelWarning"
        :message="modelWarning"
        class="mb-2"
        show-icon
        type="warning"
      />
      <Alert
        v-else-if="orphanWarning"
        :message="orphanWarning"
        class="mb-2"
        show-icon
        type="warning"
      />
      <Alert
        v-else-if="optionsEmpty"
        :message="$t('page.iot.series.optionsEmpty')"
        class="mb-2"
        show-icon
        type="warning"
      />
      <Select
        v-model:value="selectedPoints"
        :disabled="!deviceId"
        :max-tag-count="1"
        :options="selectOptions"
        :placeholder="$t('page.iot.series.pointPlaceholder')"
        allow-clear
        class="w-full"
        mode="multiple"
        option-filter-prop="label"
        show-search
        @change="onPointsChange"
      >
        <template #option="option">
          <div class="flex items-center justify-between gap-2">
            <span>{{ option.label }}</span>
            <span class="flex shrink-0 items-center gap-1">
              <Tag v-if="option.unit">{{ option.unit }}</Tag>
              <Tag v-if="option.orphan" color="orange">
                {{ $t('page.iot.series.orphanTag') }}
              </Tag>
              <Tag v-else-if="!option.mapped" color="default">
                {{ $t('page.iot.series.unmappedTag') }}
              </Tag>
            </span>
          </div>
        </template>
      </Select>
    </Spin>
    <div class="mt-1 text-xs text-muted-foreground">
      {{
        $t('page.iot.series.pointHint', [
          String(IOT_SERIES_MAX_SELECTED_POINTS),
        ])
      }}
    </div>

    <!-- ===== 第 2 步：选时间（默认最近 24 小时 + 快捷档位） ===== -->
    <div class="mt-4 mb-1 text-sm font-medium">
      {{ $t('page.iot.series.stepTime') }}
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <RadioGroup v-model:value="rangeMode" button-style="solid" size="small">
        <RadioButton value="1h" @click="onPickRange('1h')">
          {{ $t('page.iot.series.range1h') }}
        </RadioButton>
        <RadioButton value="6h" @click="onPickRange('6h')">
          {{ $t('page.iot.series.range6h') }}
        </RadioButton>
        <RadioButton value="24h" @click="onPickRange('24h')">
          {{ $t('page.iot.series.range24h') }}
        </RadioButton>
        <RadioButton value="7d" @click="onPickRange('7d')">
          {{ $t('page.iot.series.range7d') }}
        </RadioButton>
        <RadioButton value="custom" @click="onPickRange('custom')">
          {{ $t('page.iot.series.rangeCustom') }}
        </RadioButton>
      </RadioGroup>
      <DatePicker.RangePicker
        v-if="rangeMode === 'custom'"
        :allow-clear="false"
        class="w-[360px]"
        show-time
        :value="customRange"
        @change="onCustomRangeChange"
      />
    </div>
    <div class="mt-1 text-xs text-muted-foreground">
      {{ $t('page.iot.series.rangeHint') }}
    </div>

    <!-- ===== 第 3 步：查（limit 与自动刷新都不在主流程上） ===== -->
    <div class="mt-4 flex flex-wrap items-center gap-3">
      <Button :loading="loading" type="primary" @click="onQuery">
        {{ $t('page.iot.series.query') }}
      </Button>
      <!-- 无数据时禁用导出并说明原因（灰按钮不给理由 = 用户以为功能坏了） -->
      <Tooltip :title="detail.total === 0 ? $t('page.iot.series.empty') : ''">
        <span :tabindex="detail.total === 0 ? 0 : -1" class="inline-block">
          <Button
            :disabled="detail.total === 0"
            :loading="exportLoading"
            @click="onExportCsv"
          >
            {{ $t('page.iot.series.exportCsv') }}
          </Button>
        </span>
      </Tooltip>
      <span class="flex items-center gap-2 text-sm">
        <Switch
          v-model:checked="autoRefresh"
          :aria-label="$t('page.iot.series.autoRefresh')"
          size="small"
        />
        {{ $t('page.iot.series.autoRefresh') }}
        <span class="text-xs text-muted-foreground">
          {{
            $t('page.iot.series.autoRefreshHint', [
              String(IOT_SERIES_AUTO_REFRESH_MS / 1000),
            ])
          }}
        </span>
      </span>
      <span class="flex items-center gap-2 text-sm">
        <Switch
          v-model:checked="liveFollow"
          :disabled="!hasChart"
          size="small"
        />
        {{ $t('page.iot.series.liveFollow') }}
        <Tag :color="liveState.color">{{ liveState.text }}</Tag>
        <span class="text-xs text-muted-foreground">
          {{
            hasChart
              ? $t('page.iot.series.liveFollowHint', [
                  String(IOT_SERIES_LIVE_MAX_POINTS),
                ])
              : $t('page.iot.series.liveUnavailable')
          }}
        </span>
      </span>
    </div>

    <Collapse class="mt-3" ghost>
      <CollapsePanel key="advanced" :header="$t('page.iot.series.advanced')">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-sm">{{ $t('page.iot.series.limit') }}</span>
          <InputNumber
            v-model:value="limit"
            class="w-[140px]"
            :max="IOT_SERIES_MAX_LIMIT"
            :min="1"
            :step="100"
          />
          <span class="text-xs text-muted-foreground">
            {{
              $t('page.iot.series.limitHint', [
                String(IOT_SERIES_DEFAULT_LIMIT),
                String(IOT_SERIES_MAX_LIMIT),
              ])
            }}
          </span>
        </div>
        <div class="mt-3">
          <div class="text-sm">{{ $t('page.iot.series.manualPoint') }}</div>
          <div class="mt-1 text-xs text-muted-foreground">
            {{ $t('page.iot.series.manualHint') }}
          </div>
          <div class="mt-2 flex items-center gap-2">
            <Input
              v-model:value="manualInput"
              class="w-[240px]"
              :placeholder="$t('page.iot.series.manualPlaceholder')"
              @press-enter="onAddManualPoint"
            />
            <Button size="small" @click="onAddManualPoint">
              {{ $t('page.iot.series.manualAdd') }}
            </Button>
          </div>
          <div class="mt-2 text-xs text-muted-foreground">
            {{
              manualPoints.length > 0
                ? manualPoints.join(', ')
                : $t('page.iot.series.manualEmpty')
            }}
          </div>
        </div>
      </CollapsePanel>
    </Collapse>

    <Spin :spinning="loading">
      <div class="mt-4">
        <template v-if="queried">
          <div class="mb-2 text-sm text-muted-foreground">
            {{ $t('page.iot.series.seriesCount', [String(usedPoints.length)]) }}
            ·
            {{ usedRangeLabel || $t('page.iot.series.rangeUnboundedShort') }}
            ·
            {{ $t('page.iot.series.limitUsed', [String(usedLimit)]) }}
            <span v-if="totalCount > 0">
              ·
              {{ $t('page.iot.series.pointCount', [String(totalCount)]) }}
            </span>
          </div>

          <!-- 未限定时间范围：这是「最早的 N 个点」，不是「最近的 N 个点」，必须说清楚 -->
          <Alert
            v-if="usedRange.unbounded"
            :message="$t('page.iot.series.rangeUnbounded', [String(usedLimit)])"
            class="mb-2"
            show-icon
            type="warning"
          />
          <Alert
            v-if="autoRefresh && !loading"
            :message="
              $t('page.iot.series.autoRefreshing', [
                String(IOT_SERIES_AUTO_REFRESH_MS / 1000),
              ])
            "
            class="mb-2"
            show-icon
            type="info"
          />
          <template v-if="liveFollow">
            <!-- 断线必须可见（Tag 变黄 + 这条 Alert），不得让曲线静止而用户以为设备没上报 -->
            <Alert
              v-if="realtimeState === 'reconnecting'"
              class="mb-2"
              :description="realtimeError || undefined"
              :message="$t('page.iot.series.liveReconnectingDesc')"
              show-icon
              type="warning"
            />
            <div class="mb-2 text-xs text-muted-foreground">
              {{
                $t('page.iot.series.liveFollowed', [String(liveFollowedCount)])
              }}
              <span v-if="liveDroppedCount > 0">
                ·
                {{
                  $t('page.iot.series.liveDropped', [String(liveDroppedCount)])
                }}
              </span>
              <span v-if="liveNonGoodCount > 0">
                ·
                {{
                  $t('page.iot.series.liveNonGood', [String(liveNonGoodCount)])
                }}
              </span>
            </div>
          </template>

          <!-- 逐点位状态：失败原样展示后端 message，空数据与失败严格分开 -->
          <div v-for="item in results" :key="item.propertyId" class="mb-2">
            <Alert
              v-if="item.error"
              :message="`${item.name}：${item.error}`"
              show-icon
              type="error"
            />
            <Alert
              v-else-if="item.points.length === 0 && !noData"
              :message="$t('page.iot.series.pointEmpty', [item.name])"
              show-icon
              type="info"
            />
            <Alert
              v-else-if="reachedLimit(item)"
              :message="`${item.name}：${$t('page.iot.series.limitReachedAsc', [String(usedLimit)])}`"
              show-icon
              type="warning"
            />
          </div>

          <Empty v-if="noData" :description="$t('page.iot.series.empty')" />
          <template v-else-if="detail.total > 0">
            <!-- 图表子组件：model/units 一变就重绘，宿主不再手工调 renderChart() -->
            <SeriesChart :model="chartModel" :units="units" />
            <Alert
              v-if="valueHint"
              :message="valueHint"
              show-icon
              type="warning"
            />
            <!-- 明细表子组件（行/截断/多点位列都是窄 props，表格与截断提示同源） -->
            <SeriesDetailTable
              :max-rows="IOT_SERIES_TABLE_MAX_ROWS"
              :multi-series="multiSeries"
              :rows="detail.rows"
              :total="detail.total"
              :truncated="detail.truncated"
            />
          </template>
        </template>
        <Empty v-else :description="$t('page.iot.series.idle')" />
      </div>
    </Spin>
  </Drawer>
</template>
