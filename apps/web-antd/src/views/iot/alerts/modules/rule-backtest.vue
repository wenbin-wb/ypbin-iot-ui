<script lang="ts" setup>
import type { RulePreviewResult, RulePreviewWindowKey } from '../rule-preview';

import type { IotAlertApi, IotDeviceApi } from '#/api/iot';

import { computed, ref, watch } from 'vue';

import {
  Alert,
  Button,
  Descriptions,
  DescriptionsItem,
  Radio,
  RadioGroup,
  Select,
  SelectOption,
  Tag,
} from 'ant-design-vue';

import { getDeviceSeries } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { formatDateTime } from '../../shared/display';
import {
  evaluateRulePreviewGroup,
  RULE_PREVIEW_WINDOWS,
} from '../rule-preview';

/**
 * 告警规则的「历史试算」块（只读预览，不参与保存）。
 *
 * 从 `rule-form.vue` 拆出的原因（2026-10-20 架构审查 §2.1，P2-4）：
 * 试算原本是 1665 行表单里的第 ⑦ 块，独占约 300 行模板 + 约 240 行脚本状态，却与提交链路
 * 零耦合（只读条件、只发 GET）。拆成自包含组件后：宿主只剩「传条件 + 打开时同步默认设备」，
 * 试算的串台守卫、失效策略、展示口径全部就近可读、可独立加用例。
 *
 * 三条纪律**原样保留**（拆分类改动不得改变行为）：
 * 1. **组判定不是逐行**：一条规则的多条件是一个合取条件组（真 AND），试算必须整组出结论；
 * 2. **在途结果防串台**：串行拉多串历史期间用户可能切设备/改条件/换窗口 —— 请求序号自增，
 *    旧响应回来直接丢弃；只有「当前这一轮」有权写结果与复位 loading；
 * 3. **断档/离线类不伪装能算**：无条件行时明确说「无法试算、去哪核验」，不给一个永远点不动的按钮。
 */

const props = defineProps<{
  /**
   * 试算条件（与保存请求**同源**投影：宿主用 `toConditionRequests(conditionRows)` 传入）。
   *
   * 为什么不直接把 `conditionRows` 传进来：试算必须与「保存给后端的 points 逐字段相同」，
   * 传投影结果可以从类型上保证两者不会各算各的（同源口径写在 `../condition-rows`）。
   */
  conditions: IotAlertApi.RulePointSaveReq[];
  /** 试算设备候选（与主表单同源，避免出现两套设备标签口径）。 */
  deviceOptions: IotDeviceApi.DeviceResp[];
  /** 是否存在阈值条件（= 宿主的 `needsPoint`）：无条件的断档类如实说明无法试算。 */
  hasPointConditions: boolean;
  /** 点位展示名（宿主从物模型候选派生；取不到时退化为标识，不伪造名字）。 */
  propertyLabelOf: (propertyId: string) => string;
}>();

/** 试算单次取多少条历史样本：与后端上限（5000）留出余量，够看清时间窗又不拖垮抽屉。 */
const BACKTEST_SERIES_LIMIT = 500;

/** 样本明细最多展示最近多少条（结果里仍按 limit 参与判定）。 */
const BACKTEST_SAMPLE_ROWS = 20;

const backtestDeviceId = ref('');

const backtestWindow = ref<RulePreviewWindowKey>('24h');

const backtestLoading = ref(false);

const backtestError = ref('');

/**
 * 条件组试算结果（**整组一份**）。
 *
 * 真 AND 之后一条规则的多条件是一个合取条件组，试算必须给出**组判定**而不是逐行结果；
 * `null` 表示「还没算/已失效」（不得留旧结果给用户当真）。
 */
const backtestResult = ref<null | RulePreviewResult>(null);

/**
 * 试算请求序号（**防串台**）。
 *
 * 试算按点位串行拉多条历史序列，期间用户可能切换试算设备/改条件/换时间窗：
 * 旧请求返回后若直接写 `backtestResult`，会把「旧设备/旧阈值」的结论画成新选择的结果。
 * 每次发起试算/任何使结果失效的操作都自增序号，响应回来时序号不一致 ⇒ 丢弃（不写结果、
 * 不动 loading，由新一轮自己收尾）。
 */
let backtestRequestSeq = 0;

/** 有条件的规则才能试算；断档类如实说「无法试算」，不给一个永远点不动的按钮。 */
const backtestReady = computed(
  () =>
    backtestDeviceId.value !== '' &&
    props.conditions.some((condition) => condition.propertyId !== ''),
);

/**
 * 试算明细行（对齐时刻逐条；不可判定时刻如实标「不可判定」，不伪装成未命中）。
 *
 * `toReversed()`：不得就地反转 `result.groupSamples`（`reverse()` 会改到计算结果本身）。
 */
const backtestRows = computed(() =>
  (backtestResult.value?.groupSamples ?? [])
    .slice(-BACKTEST_SAMPLE_ROWS)
    .toReversed()
    .map((sample) => ({
      ...sample,
      // 逐条件取值带上展示名与比较符/阈值（「阈值 vs 读到多少 vs 判定」三段式）
      values: sample.values.map((value) => ({
        ...value,
        conditionLabel: props.propertyLabelOf(value.propertyId),
        thresholdText: (() => {
          const view = backtestResult.value?.conditions?.[value.index];
          return view ? `${view.symbol} ${view.threshold}` : '';
        })(),
      })),
    })),
);

/** 对齐容差的**人话**（毫秒 → 秒/毫秒；UI 必须显示，见 rule-preview 模块头的对齐口径）。 */
const backtestAlignText = computed(() => {
  const ms = backtestResult.value?.alignToleranceMs ?? 0;
  if (ms <= 0) {
    return '';
  }
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(1))} s` : `${ms} ms`;
});

/** 本次判定实际用到的最大偏移（毫秒；没有可判定样本时为 null ⇒ 不显示，不伪造 0）。 */
const backtestMaxOffsetText = computed(() => {
  const offsets = (backtestResult.value?.groupSamples ?? [])
    .map((sample) => sample.maxOffsetMs)
    .filter((value): value is number => value !== null);
  if (offsets.length === 0) {
    return '';
  }
  const max = Math.max(...offsets);
  return max >= 1000 ? `${Number((max / 1000).toFixed(1))} s` : `${max} ms`;
});

/**
 * 让「在途/已完成的试算结果」立即失效。
 *
 * 为什么不是只清空 `backtestResult`：在途请求返回时还会再写一次（旧设备/旧阈值串台），
 * 必须同时自增序号让旧响应识别自己已过期，并复位 loading（否则旧请求的 finally 会把
 * 新一轮的 loading 清掉，或反过来旧请求让按钮一直转）。
 */
function invalidateBacktest() {
  backtestRequestSeq += 1;
  backtestResult.value = null;
  backtestError.value = '';
  backtestLoading.value = false;
}

/**
 * 切换试算设备：上一次结果与在途请求都立即失效。
 *
 * 条件行自带点位（每行一个 propertyId），试算不再需要「另选一个试算点位」——
 * 那个独立选择器正是旧实现把「试算点位」代入所有条件、从而伪造出 AND 语义的来源。
 */
function onBacktestDeviceChange() {
  invalidateBacktest();
}

/**
 * 规则条件/时间窗一改，上一次试算结果立即失效（避免用户拿着旧阈值的结果当真）。
 * 试算设备与点位由各自 change 处理器清理，不在此重复。
 */
watch(
  () => [
    // 逐条件试算：任一行的点位/比较符/阈值/比较域/回差一变，上一次结果立即失效。
    // ⚠️ 不能用 `deep: true`：它会深遍历「条件行数组 + 每行对象」的每个属性，
    // 而这是**高频** getter（抽屉打开、行增删、每次输入都跑）。本仓单测是 5s 超时的
    // 组件级用例，深遍历会把挂载/刷新推到超时边缘（实测：deep 版 list-refresh 用例约 1/3 概率超时，
    // 浅比较版稳定通过）。这里显式把每行投影成字符串元组，语义相同但**浅比较即可**。
    ...props.conditions.map(
      (condition) =>
        `${condition.propertyId ?? ''}\u0000${condition.operator ?? ''}\u0000${condition.threshold ?? ''}\u0000${condition.valueType ?? ''}\u0000${condition.deadband ?? ''}`,
    ),
    backtestWindow.value,
  ],
  () => {
    // 条件/时间窗变化 ⇒ 旧结果**与在途请求**都失效（串行拉数期间切换窗口同样会串台）
    invalidateBacktest();
  },
);

/**
 * 打开抽屉时把主表单已有设备同步成试算默认设备（点位由各条件行自带）。
 *
 * 由宿主在抽屉 open 后调用（`syncFromForm(form.deviceId)`）：设备选择是试算的独立输入，
 * 用户改了主表单设备后**不应该**在未察觉时把已选试算设备换掉，所以只在打开时同步一次。
 */
function syncFromForm(deviceId: string) {
  invalidateBacktest();
  backtestDeviceId.value = deviceId;
}

/**
 * 执行历史试算（**条件组整体试算，真 AND**）。
 *
 * 引擎把同一条规则在同一台设备上的全部点位条件当成**一个**合取条件组，因此试算也必须整组做：
 * 拉取组内**每个** propertyId 的序列，按时间对齐后逐时刻做 AND 判定（对齐口径见 `../rule-preview`
 * 模块头，容差与最大偏移都会显示在 UI 上）。
 *
 * - 每个**不同**的点位只查一次历史（同点位复用，避免 N 行 N 次请求）；
 * - 断档/离线类（无条件行）：**不发历史请求**，直接给出「无法试算」的诚实结论；
 * - 某点位查询失败原样展示后端 message，**整组如实显示无法试算**（不拿部分序列硬算出一个假结论）；
 * - `backtestLoading` 期间按钮 loading 且点击短路 ⇒ 防重复请求；
 * - 请求期间切换设备/改条件 ⇒ 序号自增，旧响应回来时**直接丢弃**（P2-8：否则旧设备序列
 *   会被当成新设备的试算结果，属于把不确定当确定，比「没有结果」更糟）。
 */
async function runBacktest() {
  if (backtestLoading.value || !backtestReady.value) {
    return;
  }
  const requestSeq = (backtestRequestSeq += 1);
  backtestError.value = '';
  backtestResult.value = null;
  // 在发起时快照设备/窗口/条件：串行 await 期间这些 ref 可能已被用户改掉，
  // 每个点位都用「当前值」会把不同设备/不同窗口的序列混进同一组判定。
  const deviceId = backtestDeviceId.value;
  const to = Date.now();
  const from = to - RULE_PREVIEW_WINDOWS[backtestWindow.value];
  const conditions = props.conditions ?? [];
  if (conditions.length === 0) {
    backtestResult.value = evaluateRulePreviewGroup({
      conditions: [],
      from,
      seriesByPropertyId: {},
      to,
    });
    return;
  }
  backtestLoading.value = true;
  try {
    const propertyIds = [
      ...new Set(
        conditions
          .map((condition) => condition.propertyId ?? '')
          .filter((propertyId) => propertyId !== ''),
      ),
    ];
    const seriesByPropertyId: Record<
      string,
      Awaited<ReturnType<typeof getDeviceSeries>>
    > = {};
    for (const propertyId of propertyIds) {
      // 逐点位串行：避免同一设备并发多串查询把时序库打满；结果按点位缓存
      const series = await getDeviceSeries(deviceId, {
        from,
        limit: BACKTEST_SERIES_LIMIT,
        propertyId,
        to,
      });
      // 每个 await 之后都检查一次：已失效就停止后续请求，不再打时序库
      if (requestSeq !== backtestRequestSeq) {
        return;
      }
      seriesByPropertyId[propertyId] = series;
    }
    if (requestSeq !== backtestRequestSeq) {
      return;
    }
    backtestResult.value = evaluateRulePreviewGroup({
      conditions,
      from,
      limit: BACKTEST_SERIES_LIMIT,
      seriesByPropertyId,
      to,
    });
  } catch (error) {
    // 旧请求的失败同样不能覆盖新一轮的状态
    if (requestSeq !== backtestRequestSeq) {
      return;
    }
    backtestResult.value = null;
    backtestError.value = extractErrorMessage(
      error,
      $t('page.iot.alert.rule.backtest.loadFailed'),
    );
  } finally {
    // 只有「当前这一轮」才有权复位 loading；旧请求复位会把新一轮的 loading 提前关掉
    if (requestSeq === backtestRequestSeq) {
      backtestLoading.value = false;
    }
  }
}

/** 宿主在抽屉 open 后调用：把主表单设备同步为试算默认设备（见 {@link syncFromForm}）。 */
defineExpose({ syncFromForm });
</script>

<template>
  <div class="rounded border border-solid border-border p-3">
    <div class="mb-1 text-sm font-semibold">
      {{ $t('page.iot.alert.rule.backtest.title') }}
    </div>
    <div class="mb-2 text-xs text-muted-foreground">
      {{ $t('page.iot.alert.rule.backtest.hint') }}
    </div>

    <!-- 断档/离线类没有阈值条件：当场说清「无法试算、去哪核验」，而不是给一个永远点不动的按钮 -->
    <Alert
      v-if="!hasPointConditions"
      class="mb-2"
      :message="$t('page.iot.alert.rule.backtest.unsupportedNoCondition')"
      show-icon
      type="warning"
    />

    <div class="grid grid-cols-2 gap-3">
      <div>
        <div class="mb-1 text-sm">{{ $t('page.iot.device.name') }}</div>
        <Select
          v-model:value="backtestDeviceId"
          allow-clear
          data-testid="backtest-device"
          show-search
          style="width: 100%"
          :placeholder="$t('page.iot.alert.rule.backtest.devicePlaceholder')"
          @change="onBacktestDeviceChange"
        >
          <SelectOption
            v-for="item in deviceOptions"
            :key="item.id"
            :label="item.deviceName ?? item.deviceCode ?? item.id"
            :value="item.id"
          >
            {{ item.deviceName ?? item.deviceCode }} ({{ item.deviceCode }})
          </SelectOption>
        </Select>
      </div>
      <div>
        <div class="mb-1 text-sm">
          {{ $t('page.iot.alert.rule.backtest.window') }}
        </div>
        <RadioGroup v-model:value="backtestWindow" size="small">
          <Radio value="1h">
            {{ $t('page.iot.alert.rule.backtest.window1h') }}
          </Radio>
          <Radio value="6h">
            {{ $t('page.iot.alert.rule.backtest.window6h') }}
          </Radio>
          <Radio value="24h">
            {{ $t('page.iot.alert.rule.backtest.window24h') }}
          </Radio>
          <Radio value="7d">
            {{ $t('page.iot.alert.rule.backtest.window7d') }}
          </Radio>
        </RadioGroup>
      </div>
      <div class="flex items-end">
        <Button
          :disabled="!backtestReady"
          :loading="backtestLoading"
          type="primary"
          @click="runBacktest"
        >
          {{
            backtestLoading
              ? $t('page.iot.alert.rule.backtest.running')
              : $t('page.iot.alert.rule.backtest.run')
          }}
        </Button>
        <span v-if="!backtestReady" class="ml-2 text-xs text-muted-foreground">
          {{ $t('page.iot.alert.rule.backtest.needSelection') }}
        </span>
      </div>
    </div>

    <Alert
      v-if="backtestError"
      class="mt-2"
      :message="backtestError"
      show-icon
      type="error"
    />

    <!--
      只要跑过一次就渲染结果容器（data-testid=backtest-result）：即使窗口内一条可判定样本都没有，
      也要让用户看到「跑了、但结论为空」并读到原因，而不是点完毫无反应。
    -->
    <template v-else-if="backtestResult">
      <div class="mt-2 text-sm font-semibold" data-testid="backtest-result">
        {{ $t('page.iot.alert.rule.backtest.resultTitle') }}
      </div>
      <!-- 组判定口径：全部满足才命中（AND） -->
      <div class="mt-1 text-xs text-muted-foreground">
        {{ $t('page.iot.alert.rule.backtest.groupNote') }}
      </div>
      <!-- ⏱ 对齐口径必须显式展示（容差 + 本次最大偏移），不得只说「已对齐」 -->
      <div
        v-if="backtestAlignText"
        class="mt-1 text-xs text-muted-foreground"
        data-testid="backtest-align-note"
      >
        {{
          $t('page.iot.alert.rule.backtest.alignNote', [
            backtestAlignText,
            backtestMaxOffsetText || '-',
          ])
        }}
      </div>
      <div class="mt-1 text-xs text-muted-foreground">
        {{ $t('page.iot.alert.rule.backtest.approximationNote') }}
      </div>

      <Descriptions :column="3" class="mt-2" size="small" bordered>
        <DescriptionsItem
          :label="$t('page.iot.alert.rule.backtest.triggerCount')"
        >
          <span class="font-semibold">
            {{ backtestResult.triggerCount }}
          </span>
        </DescriptionsItem>
        <DescriptionsItem
          :label="$t('page.iot.alert.rule.backtest.matchedCount')"
        >
          {{ backtestResult.matchedCount }}
        </DescriptionsItem>
        <DescriptionsItem
          :label="$t('page.iot.alert.rule.backtest.notDecidableCount')"
        >
          {{ backtestResult.notDecidableCount }}
        </DescriptionsItem>
        <DescriptionsItem
          :label="$t('page.iot.alert.rule.backtest.sampleCount')"
        >
          {{ backtestResult.usedSamples }}
        </DescriptionsItem>
        <DescriptionsItem
          :label="$t('page.iot.alert.rule.backtest.firstTrigger')"
        >
          {{
            backtestResult.firstTriggerTs === null
              ? '-'
              : formatDateTime(backtestResult.firstTriggerTs)
          }}
        </DescriptionsItem>
        <DescriptionsItem
          :label="$t('page.iot.alert.rule.backtest.lastTrigger')"
        >
          {{
            backtestResult.lastTriggerTs === null
              ? '-'
              : formatDateTime(backtestResult.lastTriggerTs)
          }}
        </DescriptionsItem>
      </Descriptions>

      <Alert
        v-if="backtestResult.usedSamples === 0"
        class="mt-2"
        :message="
          backtestResult.notDecidableCount > 0
            ? $t('page.iot.alert.rule.backtest.allNotDecidable')
            : $t('page.iot.alert.rule.backtest.emptyData')
        "
        show-icon
        type="warning"
      />
      <Alert
        v-else-if="backtestResult.matchedCount === 0"
        class="mt-2"
        :message="$t('page.iot.alert.rule.backtest.noneTriggered')"
        show-icon
        type="info"
      />

      <div
        v-if="backtestResult.skippedSamples > 0"
        class="mt-1 text-xs text-warning-text"
      >
        {{
          $t('page.iot.alert.rule.backtest.skipped', [
            backtestResult.skippedSamples,
          ])
        }}
      </div>
      <div
        v-if="backtestResult.truncatedSamples > 0"
        class="mt-1 text-xs text-warning-text"
      >
        {{
          $t('page.iot.alert.rule.backtest.truncated', [
            backtestResult.usedSamples,
          ])
        }}
      </div>

      <!-- 对齐时刻明细：每个时刻给组判定 + 逐条件「阈值 vs 读到多少 vs 判定」三段式 -->
      <div v-if="backtestRows.length > 0" class="mt-2">
        <div class="mb-1 text-xs font-semibold">
          {{
            $t('page.iot.alert.rule.backtest.samplesTitle', [
              Math.min(BACKTEST_SAMPLE_ROWS, backtestRows.length),
            ])
          }}
        </div>
        <div
          v-for="(sample, position) in backtestRows"
          :key="`${sample.ts}-${position}`"
          class="mt-2 rounded border border-solid border-border p-2"
          :data-testid="`backtest-row-${position}`"
        >
          <div class="mb-1 flex items-center justify-between text-xs">
            <span class="font-mono">{{ formatDateTime(sample.ts) }}</span>
            <Tag
              :color="
                sample.matched === null
                  ? 'warning'
                  : sample.matched
                    ? 'success'
                    : 'default'
              "
            >
              {{
                sample.matched === null
                  ? $t('page.iot.alert.rule.backtest.notDecidable')
                  : sample.matched
                    ? $t('page.iot.alert.rule.backtest.groupMatched')
                    : $t('page.iot.alert.rule.backtest.groupNotMatched')
              }}
            </Tag>
          </div>
          <table class="w-full text-xs">
            <thead>
              <tr class="text-left text-muted-foreground">
                <th>
                  {{ $t('page.iot.alert.rule.backtest.sampleProperty') }}
                </th>
                <th>
                  {{ $t('page.iot.alert.rule.backtest.sampleCondition') }}
                </th>
                <th>
                  {{ $t('page.iot.alert.rule.backtest.sampleValue') }}
                </th>
                <th>
                  {{ $t('page.iot.alert.rule.backtest.sampleTime') }}
                </th>
                <th>
                  {{ $t('page.iot.alert.rule.backtest.sampleMatched') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="item in sample.values"
                :key="item.index"
                :data-testid="`backtest-condition-${position}-${item.index}`"
              >
                <td>{{ item.conditionLabel }}</td>
                <td class="font-mono">{{ item.thresholdText }}</td>
                <td class="font-mono">
                  {{ item.value === '' ? '-' : item.value }}
                </td>
                <td>
                  {{
                    item.sampleTs === null ? '-' : formatDateTime(item.sampleTs)
                  }}
                </td>
                <td>
                  <Tag
                    :color="
                      item.matched === null
                        ? 'warning'
                        : item.matched
                          ? 'success'
                          : 'default'
                    "
                  >
                    {{
                      item.matched === null
                        ? $t('page.iot.alert.rule.backtest.notDecidable')
                        : item.matched
                          ? $t('page.iot.alert.rule.backtest.matched')
                          : $t('page.iot.alert.rule.backtest.notMatched')
                    }}
                  </Tag>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>
