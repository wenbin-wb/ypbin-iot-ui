<script lang="ts" setup>
import type { ConditionRowDraft } from '../condition-rows';
import type { RulePreviewResult, RulePreviewWindowKey } from '../rule-preview';

import type { IotAlertApi } from '#/api/iot';

import { computed, onMounted, ref, watch } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import {
  Alert,
  Button,
  Checkbox,
  CheckboxGroup,
  Descriptions,
  DescriptionsItem,
  Input,
  InputNumber,
  message,
  Radio,
  RadioGroup,
  Select,
  SelectOption,
  Space,
  Tag,
} from 'ant-design-vue';

import {
  createAlertRule,
  getAlertPresets,
  getDeviceOptions,
  getDeviceSeries,
  getPublishedProductOptions,
  listProperties,
  listServices,
  updateAlertRule,
} from '#/api/iot';
import { UserSelect } from '#/components/user-select';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { formatDateTime } from '../../shared/display';
import {
  createConditionRow,
  MAX_POINTS_PER_RULE,
  parseConditionRows,
  toConditionRequests,
  validateConditionRows,
} from '../condition-rows';
import {
  buildConditionsSummary,
  CONDITION_CLAUSE_JOIN_KEY,
} from '../condition-summary';
import { notifyHintKey, resolveNotifyRisk } from '../notify-risk';
import {
  findInvalidEmails,
  joinNotifyTargets,
  splitNotifyTargets,
} from '../notify-targets';
import {
  evaluateRulePreviewGroup,
  RULE_PREVIEW_WINDOWS,
} from '../rule-preview';
import { resolveArgs } from '../summary';

const emit = defineEmits<{ saved: [] }>();

/**
 * 告警规则向导（**傻瓜式**的重点：一键模板 + 人话预览 + 处处合理默认）。
 *
 * <!-- vben-ui-dev-exempt: R2 -->
 * 豁免理由：本向导的字段**依赖两个动态来源**（所选模板、所选设备 → 产品 → 物模型属性），
 * 且需要把「当前填写内容」实时渲染成一句人话预览；`useVbenForm` 的静态 schema + `updateSchema`
 * 组合会让预览与字段**不同源**（预览读的是本地状态、字段读的是表单实例），这类分叉正是要避免的。
 * 因此用受控表单（`ref` + `computed` 预览），校验与错误展示仍与后端 message 同一条链路
 * （提交失败**原样展示后端 message**，不弹原始码）。
 *
 * 默认值全部来自后端预设（`GET /iot/alerts/presets`）而不是前端写死：同一套模板在任何端侧/语言下
 * 行为一致（告警设计见后端 ypbin-iot 的 `docs/ALERTING-DESIGN.md`）。
 */
const [Drawer, drawerApi] = useVbenDrawer({
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      return;
    }
    const data = drawerApi.getData() as null | {
      presetCode?: string;
      rule?: IotAlertApi.RuleResp;
    };
    editingId.value = data?.rule?.id ?? '';
    drawerApi.setState({
      title: editingId.value
        ? $t('page.iot.alert.rule.editTitle')
        : $t('page.iot.alert.rule.createTitle'),
    });
    await loadPresets();
    await loadDevices();
    if (data?.rule) {
      applyRule(data.rule);
    } else {
      applyPreset(data?.presetCode);
    }
    syncBacktestFromForm();
  },
});

const editingId = ref('');

const presets = ref<IotAlertApi.PresetResp[]>([]);

const devices = ref<Awaited<ReturnType<typeof getDeviceOptions>>>([]);

const propertyOptions = ref<
  { dataType?: string; label: string; unit?: string; value: string }[]
>([]);

/** 产品下拉（「整个产品」作用域必填；点位来自产品物模型，故点位/设备级也要用）。 */
const productOptions = ref<{ label: string; value: string }[]>([]);

const submitting = ref(false);

const submitError = ref('');

/** 表单状态（默认值 = 用户口径 ③「处处合理默认」）。 */
const form = ref({
  presetCode: '',
  ruleName: '',
  scopeType: 'POINT',
  deviceId: '',
  productId: '',
  triggerMode: 'CONSECUTIVE_COUNT',
  triggerThreshold: 3,
  pendingTtlSec: 300,
  repeatIntervalSec: 600,
  severity: 'WARNING',
  enabled: true,
  channels: ['INBOX', 'EMAIL'] as string[],
  /**
   * 收件人拆成三段编辑（保存时合回后端的 `notifyTargets` 单字段契约）。
   *
   * 为什么拆：原来是一个自由文本框，用户要**手敲用户 ID**——
   * 既不知道 ID 是多少，也认不出自己敲的对不对。现在"选系统用户"为主，
   * 额外邮箱（非系统用户的邮箱，如公共告警组）保留为次。
   */
  notifyUserIds: [] as string[],
  notifyExtraEmails: [] as string[],
  /** 既非用户 ID 也非邮箱的历史 token（原样保留，避免保存即静默清除）。 */
  notifyUnrecognized: [] as string[],
  description: '',
});

/**
 * 点位条件行（**多行**）。
 *
 * 这是本次修复的核心：旧实现只编辑 `points[0]`，用前端打开一条多条件规则再保存会**静默删掉**
 * 其余条件行。现在条件行是独立数组，新增/编辑/删除/排序都以它为准，保存时按**界面顺序原样提交**。
 *
 * 为什么不再用 `needsPoint = Boolean(operator)` 单条件那套：那套把「有无阈值条件」编码在
 * 「比较符是否为空」里，天然只能表达一条条件；多行条件下这个信号必须由**数组是否为空**表达。
 */
const conditionRows = ref<ConditionRowDraft[]>([]);

/** 「比较符清空 = 断档/离线类」的既有语义 ⇒ 改成「条件行数为 0」。 */
const needsPoint = computed(() => conditionRows.value.length > 0);

/**
 * 行级校验（与后端 `AlertRuleServiceImpl.buildPoint()/validate()` **完全同口径**，见 `../condition-rows`）。
 *
 * **阻断保存**（不是只警告）：行内必填/数字/布尔 0-1/回差非负/字段长度/行数上限/点位级至少一行
 * —— 这些都是后端**同样会拒**的，前端先拦只是不白跑一次请求。
 *
 * ⚠️ 真 AND 之后**不再有「重复点位」这条阻断**：去重键已是 `R:ruleId:deviceId`（不含 propertyId），
 * 同一点位的两行会**各参与一次合取判定**（例如「同一读数 > 80 且 < 100」），是合法用法。
 */
const conditionIssues = computed(() =>
  validateConditionRows(conditionRows.value, {
    scopeType: form.value.scopeType,
  }),
);

/** 行号（1 起）→ 该行的首个问题（i18n 键 + 参数）；无问题的行不在表里。 */
const issueByRow = computed(() => {
  const map = new Map<number, { args?: (number | string)[]; key: string }>();
  for (const issue of conditionIssues.value) {
    if (issue.index > 0 && !map.has(issue.index)) {
      map.set(issue.index, { args: issue.args, key: issue.key });
    }
  }
  return map;
});

/** 取某行（1 起行号）的首个问题；模板里用它，避免在表达式里做 Map 兜底判断。 */
function rowIssue(position: number) {
  return issueByRow.value.get(position + 1);
}

/** 作用域级问题（行号 0：点位级至少一行 / 行数超上限），与行内问题分开提示。 */
const scopeIssues = computed(() =>
  conditionIssues.value.filter((issue) => issue.index === 0),
);

/**
 * 额外邮箱里"不像邮箱"的条目（不含 `@`）。
 *
 * 🔴 必须提示而不是放过去：后端按**形态**分流，不含 `@` 的 token 会被**静默忽略**
 * ⇒ 用户以为填了收件人，告警却没人收到。这条提示就是为了消灭那个静默失败。
 */
const invalidEmails = computed(() =>
  findInvalidEmails(form.value.notifyExtraEmails),
);

/** 通知对象原文（与保存请求**同源**：同样调用 `joinNotifyTargets`）。 */
const notifyTargetsText = computed(() =>
  joinNotifyTargets({
    userIds: form.value.notifyUserIds,
    emails: form.value.notifyExtraEmails,
    unrecognized: form.value.notifyUnrecognized,
  }),
);

/**
 * 通知对象风险态（判据见 `../notify-risk`）：
 * 未选渠道 / 未配对象 / 邮件仅靠平台兜底 / 站内信兜底 / 正常。
 */
const notifyRisk = computed(() =>
  resolveNotifyRisk(form.value.channels.join(','), notifyTargetsText.value),
);

/** 内联提示的 i18n 键；`undefined` ⇒ 不渲染（通知对象齐全时提示不出现）。 */
const notifyHint = computed(() => notifyHintKey(notifyRisk.value));

/** 点位候选（含展示名与单位）；条件行与试算共用同一份数据，避免两种标签口径。 */
function propertyOption(propertyId: string) {
  return propertyOptions.value.find((item) => item.value === propertyId);
}

/** 某个点位的展示名（取不到就退化成标识——**不伪造一个像名字的东西**）。 */
function propertyLabelOf(propertyId: string) {
  return propertyOption(propertyId)?.label ?? propertyId;
}

/** 某个点位的单位（物模型里没有就不追加）。 */
function propertyUnitOf(propertyId: string) {
  return propertyOption(propertyId)?.unit;
}

/** 某点位的物模型 dataType 是否布尔（决定比较域：布尔只能「等于/不等于」）。 */
function isBooleanDataType(dataType?: string) {
  return (dataType ?? '').toLowerCase().includes('bool');
}

const productLabel = computed(() => {
  const hit = productOptions.value.find(
    (item) => item.value === form.value.productId,
  );
  return hit?.label ?? '';
});

const deviceLabel = computed(() => {
  const hit = devices.value.find((item) => item.id === form.value.deviceId);
  return hit?.deviceName ?? hit?.deviceCode ?? '';
});

// ---------------------------------------------------------------- 历史试算（仅预览）

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
 * 试算条件与保存请求**同源**：两者都只读 `conditionRows`，且都经
 * `toConditionRequests` 归一（与提交给后端的 points 逐字段相同）。
 */
const backtestConditions = computed(() =>
  toConditionRequests(conditionRows.value),
);

/** 有条件的规则才能试算；断档类如实说「无法试算」，不给一个永远点不动的按钮。 */
const backtestReady = computed(
  () =>
    backtestDeviceId.value !== '' &&
    backtestConditions.value.some((condition) => condition.propertyId !== ''),
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
        conditionLabel: propertyLabelOf(value.propertyId),
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
 * 切换试算设备：只清空上一次结果。
 *
 * 条件行自带点位（每行一个 propertyId），试算不再需要「另选一个试算点位」——
 * 那个独立选择器正是旧实现把「试算点位」代入所有条件、从而伪造出 AND 语义的来源。
 */
function onBacktestDeviceChange() {
  backtestResult.value = null;
  backtestError.value = '';
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
    ...conditionRows.value.map(
      (row) =>
        `${row.propertyId}\u0000${row.operator}\u0000${row.threshold}\u0000${row.valueType}\u0000${row.deadband}`,
    ),
    backtestWindow.value,
  ],
  () => {
    backtestResult.value = null;
    backtestError.value = '';
  },
);

/** 打开抽屉时把主表单已有设备同步成试算默认设备（点位由各条件行自带）。 */
function syncBacktestFromForm() {
  backtestResult.value = null;
  backtestError.value = '';
  backtestDeviceId.value = form.value.deviceId || '';
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
 * - `backtestLoading` 期间按钮 loading 且点击短路 ⇒ 防重复请求。
 */
async function runBacktest() {
  if (backtestLoading.value || !backtestReady.value) {
    return;
  }
  backtestError.value = '';
  backtestResult.value = null;
  const to = Date.now();
  const from = to - RULE_PREVIEW_WINDOWS[backtestWindow.value];
  const conditions = backtestConditions.value ?? [];
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
      seriesByPropertyId[propertyId] = await getDeviceSeries(
        backtestDeviceId.value,
        { from, limit: BACKTEST_SERIES_LIMIT, propertyId, to },
      );
    }
    backtestResult.value = evaluateRulePreviewGroup({
      conditions,
      from,
      limit: BACKTEST_SERIES_LIMIT,
      seriesByPropertyId,
      to,
    });
  } catch (error) {
    backtestResult.value = null;
    backtestError.value = extractErrorMessage(
      error,
      $t('page.iot.alert.rule.backtest.loadFailed'),
    );
  } finally {
    backtestLoading.value = false;
  }
}

/**
 * 人话预览（**与保存请求同源**）：两者都只读 `conditionRows`。
 *
 * 单行时委托既有的 {@link buildRuleSummary}（句式与参数顺序逐字不变）；
 * 多行时给出「{N} 条条件**全部满足**才告警」句式 + 每行一句「点位 比较符 阈值」，
 * 由模板按 {@link CONDITION_CLAUSE_JOIN_KEY} 连成「A 且 B 且 C」（真 AND 口径）。
 */
const summary = computed(() =>
  buildConditionsSummary({
    channels: form.value.channels.join(','),
    deviceLabel: deviceLabel.value,
    enabled: form.value.enabled,
    notifyTargets: notifyTargetsText.value,
    productLabel: productLabel.value,
    repeatIntervalSec: form.value.repeatIntervalSec,
    rows: conditionRows.value.map((row, position) => ({
      issueArgs: issueByRow.value.get(position + 1)?.args,
      issueKey: issueByRow.value.get(position + 1)?.key,
      operator: row.operator,
      propertyLabel: propertyLabelOf(row.propertyId),
      threshold: row.threshold,
      unit: propertyUnitOf(row.propertyId),
      valueType: row.valueType,
    })),
    scopeType: form.value.scopeType,
    severity: form.value.severity,
    triggerMode: form.value.triggerMode,
    triggerThreshold: form.value.triggerThreshold,
  }),
);

const summaryText = computed(() =>
  $t(summary.value.sentenceKey, resolveArgs(summary.value.sentenceArgs, $t)),
);

async function loadPresets() {
  if (presets.value.length > 0) {
    return;
  }
  try {
    presets.value = await getAlertPresets();
  } catch (error) {
    // 进不来预设就不让用户瞎填：原样展示后端 message（例如「告警能力未启用」）
    submitError.value = extractErrorMessage(
      error,
      $t('page.iot.alert.rule.presetLoadFailed'),
    );
  }
}

/** 设备下拉与产品下拉（两者都可能失败：失败必须**可见**，否则用户只看到一个空下拉）。 */
async function loadDevices() {
  try {
    if (devices.value.length === 0) {
      devices.value = await getDeviceOptions();
    }
    if (productOptions.value.length === 0) {
      const products = await getPublishedProductOptions();
      productOptions.value = products.map((item) => ({
        label: item.productName ?? item.productCode ?? item.id,
        value: item.id,
      }));
    }
    submitError.value = '';
  } catch (error) {
    submitError.value = extractErrorMessage(
      error,
      $t('page.iot.alert.rule.deviceLoadFailed'),
    );
  }
}

/** 选设备 → 顺带把产品带上（点位来自产品物模型），并加载可选的属性列表。 */
async function onDeviceChange(deviceId: string) {
  const hit = devices.value.find((item) => item.id === deviceId);
  form.value.productId = hit?.productId ?? '';
  // 注意：**不重置条件行的点位**。切换设备是「换一台设备监控同样的条件」，
  // 把已填的点位清掉会让用户在编辑时凭空丢失条件（同本次要修的静默丢条件同一类问题）。
  await loadPropertiesForProduct();
}

/**
 * 按**产品**加载可选点位（物模型属性）。
 *
 * 关键：产品级作用域（「整个产品」）没有设备下拉，但阈值条件仍需选点位 ⇒ 点位必须能**只靠产品**加载；
 * 早期实现只在 `onDeviceChange` 里加载，导致「整个产品 + 阈值」永远卡在「请选择要监控的点位」
 * （独立复核 2026-10-03 判为死路）。
 */
async function loadPropertiesForProduct() {
  propertyOptions.value = [];
  const productId = form.value.productId;
  if (!productId) {
    return;
  }
  try {
    const services = await listServices(productId);
    const options: {
      dataType?: string;
      label: string;
      unit?: string;
      value: string;
    }[] = [];
    for (const service of services) {
      const properties = await listProperties(productId, service.id);
      for (const property of properties) {
        options.push({
          // dataType 决定比较域：布尔点位只能「等于/不等于」，按数值阈值提交会被后端拒绝
          dataType: property.dataType ?? undefined,
          label: `${property.propertyName} (${property.identifier})`,
          unit: property.unit ?? undefined,
          value: property.identifier,
        });
      }
    }
    propertyOptions.value = options;
  } catch (error) {
    submitError.value = extractErrorMessage(
      error,
      $t('page.iot.alert.rule.propertyLoadFailed'),
    );
  }
}

/** 作用域切换：切到产品级或点位/设备级时，按当前产品重新加载点位（避免留着上一个产品的点位）。 */
function onScopeChange() {
  if (!needsPoint.value) {
    return;
  }
  void loadPropertiesForProduct();
}

/** 产品变更（产品级作用域）：换产品必须重载点位，否则会把 A 产品的点位与 B 产品一起提交。 */
function onProductChange() {
  if (needsPoint.value) {
    void loadPropertiesForProduct();
  }
}

/**
 * 新增一行条件。
 *
 * 上限与后端同值（`MAX_POINTS_PER_RULE`，来源见 condition-rows.ts）：
 * 达到上限就不再新增，并给出可见提示（不静默无反应）。
 */
async function addConditionRow() {
  if (conditionRows.value.length >= MAX_POINTS_PER_RULE) {
    submitError.value = $t('page.iot.alert.rule.condition.tooMany', [
      MAX_POINTS_PER_RULE,
    ]);
    return;
  }
  submitError.value = '';
  conditionRows.value = [...conditionRows.value, createConditionRow()];
  // 修复「点添加后点位下拉是空的」这条死路：候选只在「本来就有条件行」时才随作用域/产品变更加载，
  // 若用户先清空了所有条件行再添加，候选可能从未加载过。这里按需补一次（已有候选则短路）。
  if (propertyOptions.value.length === 0 && form.value.productId) {
    await loadPropertiesForProduct();
  }
}

/** 删除某一行（`key` 唯一定位，避免下标在重排后错位）。 */
function removeConditionRow(key: string) {
  conditionRows.value = conditionRows.value.filter((row) => row.key !== key);
}

/** 上移一行（顺序即保存顺序，必须让用户能调）。 */
function moveConditionRow(key: string, offset: -1 | 1) {
  const rows = [...conditionRows.value];
  const index = rows.findIndex((row) => row.key === key);
  const target = index + offset;
  if (index === -1 || target < 0 || target >= rows.length) {
    return;
  }
  const current = rows[index];
  const neighbor = rows[target];
  if (current === undefined || neighbor === undefined) {
    return;
  }
  rows[index] = neighbor;
  rows[target] = current;
  conditionRows.value = rows;
}

/** 比较符候选项（布尔点位只给「等于/不等于」，与后端 `buildPoint` 同口径）。 */
const BOOLEAN_OPERATOR_OPTIONS = [
  { label: '=', value: 'EQ' },
  { label: '!=', value: 'NE' },
];

const NUMERIC_OPERATOR_OPTIONS = [
  { label: '>', value: 'GT' },
  { label: '>=', value: 'GTE' },
  { label: '<', value: 'LT' },
  { label: '<=', value: 'LTE' },
  { label: '=', value: 'EQ' },
  { label: '!=', value: 'NE' },
];

/** 某行可选的比较符：布尔点位只能等于/不等于（给别的选项会被后端直接拒）。 */
function operatorsFor(row: ConditionRowDraft) {
  return row.valueType === 'BOOLEAN'
    ? BOOLEAN_OPERATOR_OPTIONS
    : NUMERIC_OPERATOR_OPTIONS;
}

/**
 * 选点位 ⇒ 顺带按物模型决定比较域（布尔点位自动切到 BOOLEAN，比较符收敛为等于/不等于）。
 *
 * 与旧实现同口径（不再顺手清空别的字段）：用户选好点位后把比较符从 `>` 改成 `<`，
 * 点位**不得**被悄悄清掉。
 */
function onConditionPropertyChange(row: ConditionRowDraft) {
  const hit = propertyOption(row.propertyId);
  const boolLike = isBooleanDataType(hit?.dataType);
  row.valueType = boolLike ? 'BOOLEAN' : 'NUMERIC';
  if (boolLike && !['EQ', 'NE'].includes(row.operator)) {
    row.operator = 'EQ';
    row.threshold = '1';
  }
}

/**
 * 清空比较符 = 这一行不再是一条有效阈值条件。
 *
 * 旧语义「清空比较符 ⇒ 整条规则变成断档类」在多行下不再成立（那会**静默丢掉别的行**）；
 * 现在清空只清本行的比较符/阈值，让校验明确报「第 N 行请选择比较符」。
 * 要表达断档/离线类，请**删除所有条件行**（界面在 0 行时明确提示这是断档类规则）。
 */
function onConditionOperatorChange(row: ConditionRowDraft) {
  if (
    row.operator === '' ||
    row.operator === null ||
    row.operator === undefined
  ) {
    row.operator = '';
    row.threshold = '';
  }
}

/** 一键模板：把后端默认值填进表单（用户只需再选设备/点位/数字）。 */
function applyPreset(code?: string) {
  const target =
    presets.value.find((item) => item.code === code) ?? presets.value[0];
  if (!target) {
    return;
  }
  form.value.presetCode = target.code;
  form.value.scopeType = target.defaultScopeType;
  // 模板决定「有没有点位条件」：点位类给一行空条件；断档/离线类清空条件行
  conditionRows.value = target.needsPointCondition
    ? [
        createConditionRow({
          operator: target.defaultOperator ?? '',
          valueType: 'NUMERIC',
        }),
      ]
    : [];
  form.value.triggerMode = target.defaultTriggerMode;
  form.value.triggerThreshold =
    Number(target.defaultTriggerThreshold ?? 3) || 3;
  form.value.pendingTtlSec = Number(target.defaultPendingTtlSec ?? 300);
  form.value.repeatIntervalSec = Number(
    target.defaultRepeatIntervalSec ?? 1800,
  );
  form.value.severity = target.defaultSeverity;
  form.value.channels = (target.defaultNotifyChannels ?? 'INBOX,EMAIL')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  form.value.ruleName = $t(target.i18nKey);
  form.value.description = '';
}

/** 编辑：把后端返回的规则回填（含点位条件）。 */
function applyRule(rule: IotAlertApi.RuleResp) {
  form.value.ruleName = rule.ruleName;
  form.value.scopeType = rule.scopeType;
  form.value.deviceId = rule.scopeDeviceId ?? '';
  form.value.productId = rule.scopeProductId ?? '';
  form.value.severity = rule.severity;
  form.value.enabled = rule.enabled;
  form.value.triggerMode = rule.triggerMode;
  form.value.triggerThreshold = Number(rule.triggerThreshold ?? 3) || 3;
  form.value.pendingTtlSec = Number(rule.pendingTtlSec ?? 300);
  form.value.repeatIntervalSec = Number(rule.repeatIntervalSec ?? 1800);
  form.value.channels = (rule.notifyChannels ?? 'INBOX,EMAIL')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  // 拆分历史值（形态分流）：旧的自由文本里可能混着用户 ID 与邮箱，甚至无效 token
  const splitTargets = splitNotifyTargets(rule.notifyTargets);
  form.value.notifyUserIds = splitTargets.userIds;
  form.value.notifyExtraEmails = splitTargets.emails;
  form.value.notifyUnrecognized = splitTargets.unrecognized;
  form.value.description = rule.description ?? '';
  // 🔴 本次修复的核心：**全部**条件行回填（旧实现只取 rule.points?.[0]，其余行在保存时被静默删掉）
  conditionRows.value = parseConditionRows(rule.points);
  if (form.value.deviceId) {
    void onDeviceChange(form.value.deviceId);
  } else if (form.value.productId) {
    // 产品级规则没有设备：必须按产品加载点位，否则点位下拉为空、人话预览里只能显示标识
    void loadPropertiesForProduct();
  }
}

watch(
  () => form.value.deviceId,
  (deviceId, previous) => {
    if (deviceId && deviceId !== previous) {
      void onDeviceChange(deviceId);
    }
  },
);

/** 作用域切到断档类（DEVICE/TENANT）时，条件行不再有意义 ⇒ 明确让用户决定，不静默清空。 */
const offlineScope = computed(
  () => form.value.scopeType === 'DEVICE' || form.value.scopeType === 'TENANT',
);

/** 一键把规则变成断档/离线类（清空全部条件行）——用显式操作替代旧的「清空比较符」隐式语义。 */
function clearConditionRows() {
  conditionRows.value = [];
}

/**
 * 保存前把表单拼成后端契约（**不做字段改名映射**：契约字段与后端 DTO 同名）。
 *
 * 条件行按**界面顺序**原样提交（`toConditionRequests`），不丢行、不排序、不去重：
 * 重复点位会先被 `conditionIssues` 阻断在 `onSubmit`（后端唯一键会静默合并，绝不能放过去）。
 */
function toRequest(): IotAlertApi.RuleSaveReq {
  return {
    ruleName: form.value.ruleName,
    scopeType: form.value.scopeType,
    // 作用域字段按后端校验规则只填必要的那个（DEVICE 不填产品、PRODUCT 不填设备）
    scopeProductId:
      form.value.scopeType === 'PRODUCT' || form.value.scopeType === 'POINT'
        ? form.value.productId
        : undefined,
    scopeDeviceId:
      form.value.scopeType === 'DEVICE' || form.value.scopeType === 'POINT'
        ? form.value.deviceId
        : undefined,
    severity: form.value.severity,
    enabled: form.value.enabled,
    triggerMode: form.value.triggerMode,
    triggerThreshold: form.value.triggerThreshold,
    pendingTtlSec: form.value.pendingTtlSec,
    repeatIntervalSec: form.value.repeatIntervalSec,
    notifyChannels: form.value.channels.join(','),
    // 合回后端契约（用户 ID + 邮箱 + 无法识别项，逗号分隔）：
    // 空串转 undefined 以保留"留空 = 发给规则创建者"的既有语义。
    notifyTargets:
      joinNotifyTargets({
        userIds: form.value.notifyUserIds,
        emails: form.value.notifyExtraEmails,
        unrecognized: form.value.notifyUnrecognized,
      }) || undefined,
    description: form.value.description || undefined,
    // 条件行数组 ⇒ 保存请求（空数组 = 断档/离线类，与后端「points 可为空」的契约一致）
    points: toConditionRequests(conditionRows.value),
  };
}

async function onSubmit() {
  submitError.value = '';
  // 阻断性校验（与后端同口径 + 「重复点位」这条后端不做的检查）：
  // 失败时把**行号 + 具体原因**说清楚，而不是丢一个笼统的「保存失败」。
  const blocking = conditionIssues.value;
  if (blocking.length > 0) {
    submitError.value = blocking
      .map((issue) => $t(issue.key, issue.args ?? []))
      .join('；');
    return;
  }
  if (!summary.value.ready) {
    // 未就绪时**不允许提交**：让人话预览里的「还差什么」成为唯一的失败提示（不弹原始码）
    submitError.value = summaryText.value;
    return;
  }
  submitting.value = true;
  try {
    const request = toRequest();
    await (editingId.value
      ? updateAlertRule(editingId.value, request)
      : createAlertRule(request));
    // 通知对象风险提示：未配对象 / 邮件仅靠平台兜底时保存虽成功，但必须当场把「可能不会送达」说清楚
    // （文案见语言包；不在组件里写死，避免 zh/en 口径漂移）
    const hintKey = notifyHintKey(
      resolveNotifyRisk(request.notifyChannels, request.notifyTargets),
    );
    if (hintKey) {
      message.warning($t(hintKey));
    } else {
      message.success($t('common.success'));
    }
    drawerApi.close();
    emit('saved');
  } catch (error) {
    // 原样展示后端 message（例如「阈值必须是数字（当前填的是「八十」）」）
    submitError.value = extractErrorMessage(
      error,
      $t('page.iot.alert.rule.saveFailed'),
    );
  } finally {
    submitting.value = false;
  }
}

onMounted(loadPresets);
</script>

<template>
  <Drawer class="w-[720px]">
    <div class="space-y-4">
      <!-- ① 一键模板（编辑时隐藏：编辑改的是同一条规则，不该被模板覆盖） -->
      <div v-if="!editingId">
        <div class="mb-2 font-semibold">
          {{ $t('page.iot.alert.rule.pickPreset') }}
        </div>
        <Space wrap>
          <Tag
            v-for="item in presets"
            :key="item.code"
            :color="item.code === form.presetCode ? 'processing' : 'default'"
            class="cursor-pointer px-3 py-1 text-sm"
            @click="applyPreset(item.code)"
          >
            {{ $t(item.i18nKey) }}
          </Tag>
        </Space>
        <div class="mt-2 text-xs text-muted-foreground">
          {{ $t('page.iot.alert.rule.presetHint') }}
        </div>
      </div>

      <!-- ② 基本：名字 + 作用域 + 设备/产品 -->
      <div class="grid grid-cols-2 gap-3">
        <div>
          <div class="mb-1 text-sm">{{ $t('page.iot.alert.ruleName') }}</div>
          <Input v-model:value="form.ruleName" :maxlength="128" />
        </div>
        <div>
          <div class="mb-1 text-sm">{{ $t('page.iot.alert.scopeTitle') }}</div>
          <RadioGroup v-model:value="form.scopeType" @change="onScopeChange">
            <Radio value="POINT">{{ $t('page.iot.alert.scope.point') }}</Radio>
            <Radio value="DEVICE">
              {{ $t('page.iot.alert.scope.device') }}
            </Radio>
            <Radio value="PRODUCT">
              {{ $t('page.iot.alert.scope.product') }}
            </Radio>
            <Radio value="TENANT">
              {{ $t('page.iot.alert.scope.tenant') }}
            </Radio>
          </RadioGroup>
        </div>
      </div>

      <!-- 产品级作用域：必须能选产品（否则预览永远「请先选择产品」、保存永久禁用） -->
      <div v-if="form.scopeType === 'PRODUCT'" class="grid grid-cols-2 gap-3">
        <div>
          <div class="mb-1 text-sm">{{ $t('page.iot.product.name') }}</div>
          <Select
            v-model:value="form.productId"
            :placeholder="$t('page.iot.alert.rule.pickProduct')"
            show-search
            style="width: 100%"
            @change="onProductChange"
          >
            <SelectOption
              v-for="item in productOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </Select>
        </div>
      </div>

      <div
        v-if="form.scopeType === 'DEVICE' || form.scopeType === 'POINT'"
        class="grid grid-cols-2 gap-3"
      >
        <div>
          <div class="mb-1 text-sm">{{ $t('page.iot.device.name') }}</div>
          <Select
            v-model:value="form.deviceId"
            :placeholder="$t('page.iot.alert.rule.pickDevice')"
            show-search
            style="width: 100%"
            :filter-option="
              (input: string, option: any) =>
                String(option?.label ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
            "
          >
            <SelectOption
              v-for="item in devices"
              :key="item.id"
              :label="item.deviceName ?? item.deviceCode ?? item.id"
              :value="item.id"
            >
              {{ item.deviceName ?? item.deviceCode }} ({{ item.deviceCode }})
            </SelectOption>
          </Select>
        </div>
      </div>

      <!--
        ③ 点位条件行（**多行**）
        引擎把同一条规则在同一台设备上的**全部**条件当成一个合取条件组（真 AND）：
        组内全部条件都越界才告警，任一条未越界即不告警；触发时只产生**一条**实例。
        保存顺序 = 界面顺序（也决定通知正文明细与实例快照的顺序）；「不丢行」由 condition-rows
        的纯逻辑 + 用例保证。
      -->
      <div class="rounded border border-solid border-gray-200 p-3">
        <div class="mb-1 flex items-center justify-between">
          <div class="text-sm font-semibold">
            {{ $t('page.iot.alert.rule.condition.title') }}
          </div>
          <Button
            :disabled="conditionRows.length >= MAX_POINTS_PER_RULE"
            data-testid="condition-add"
            size="small"
            @click="addConditionRow"
          >
            {{ $t('page.iot.alert.rule.condition.add') }}
          </Button>
        </div>
        <!--
          引擎真实语义必须当场说清（用户口径：不误导）：
          组内**全部**条件同时满足才告警（AND），不是「满足任一条就告警」。
        -->
        <div class="mb-2 text-xs text-muted-foreground">
          {{ $t('page.iot.alert.rule.condition.perPointHint') }}
        </div>

        <!-- 条件行（0 行 = 断档/离线类，由平台断档链路判定） -->
        <div
          v-if="conditionRows.length === 0"
          class="mb-2 text-xs text-orange-600"
          data-testid="condition-empty"
        >
          {{
            offlineScope
              ? $t('page.iot.alert.rule.condition.noneHint')
              : $t('page.iot.alert.rule.condition.noneHintPoint')
          }}
        </div>
        <div v-if="conditionRows.length > 1" class="mb-2">
          <Button size="small" type="link" @click="clearConditionRows">
            {{ $t('page.iot.alert.rule.condition.clearAll') }}
          </Button>
        </div>

        <div
          v-for="(row, position) in conditionRows"
          :key="row.key"
          class="mb-2 rounded border border-solid border-gray-100 p-2"
          :data-testid="`condition-row-${position}`"
        >
          <div class="mb-1 flex items-center justify-between">
            <div class="text-xs text-muted-foreground">
              {{ $t('page.iot.alert.rule.condition.rowTitle', [position + 1]) }}
            </div>
            <Space size="small">
              <Button
                :disabled="position === 0"
                size="small"
                type="link"
                @click="moveConditionRow(row.key, -1)"
              >
                {{ $t('page.iot.alert.rule.condition.moveUp') }}
              </Button>
              <Button
                :disabled="position === conditionRows.length - 1"
                size="small"
                type="link"
                @click="moveConditionRow(row.key, 1)"
              >
                {{ $t('page.iot.alert.rule.condition.moveDown') }}
              </Button>
              <Button
                :data-testid="`condition-remove-${position}`"
                danger
                size="small"
                type="link"
                @click="removeConditionRow(row.key)"
              >
                {{ $t('page.iot.alert.rule.condition.remove') }}
              </Button>
            </Space>
          </div>
          <div class="grid grid-cols-4 gap-2">
            <div>
              <div class="mb-1 text-sm">
                {{ $t('page.iot.alert.property') }}
              </div>
              <Select
                v-model:value="row.propertyId"
                :placeholder="$t('page.iot.alert.rule.pickPoint')"
                show-search
                style="width: 100%"
                @change="() => onConditionPropertyChange(row)"
              >
                <SelectOption
                  v-for="item in propertyOptions"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </Select>
            </div>
            <div>
              <div class="mb-1 text-sm">
                {{ $t('page.iot.alert.operator') }}
              </div>
              <Select
                v-model:value="row.operator"
                style="width: 100%"
                :placeholder="$t('page.iot.alert.rule.operatorHint')"
                @change="onConditionOperatorChange(row)"
              >
                <SelectOption
                  v-for="operator in operatorsFor(row)"
                  :key="operator.value"
                  :value="operator.value"
                >
                  {{ operator.label }}
                </SelectOption>
              </Select>
            </div>
            <div>
              <div class="mb-1 text-sm">
                {{ $t('page.iot.alert.threshold') }}
                <span
                  v-if="propertyUnitOf(row.propertyId)"
                  class="text-muted-foreground"
                >
                  ({{ propertyUnitOf(row.propertyId) }})
                </span>
              </div>
              <Input
                v-model:value="row.threshold"
                :placeholder="$t('page.iot.alert.rule.thresholdPlaceholder')"
              />
            </div>
            <div>
              <div class="mb-1 text-sm">
                {{ $t('page.iot.alert.rule.condition.deadband') }}
              </div>
              <Input
                v-model:value="row.deadband"
                :placeholder="
                  $t('page.iot.alert.rule.condition.deadbandPlaceholder')
                "
              />
            </div>
          </div>
          <!-- 行内问题（与后端 buildPoint 同口径）：行号的定位必须能给到用户 -->
          <div
            v-if="rowIssue(position)"
            class="mt-1 text-xs text-red-500"
            :data-testid="`condition-error-${position}`"
          >
            {{
              $t(rowIssue(position)?.key ?? '', rowIssue(position)?.args ?? [])
            }}
          </div>
        </div>

        <!-- 作用域级问题：点位级至少一行 / 行数超上限 -->
        <div
          v-for="issue in scopeIssues"
          :key="issue.key"
          class="mb-1 text-xs text-red-500"
          data-testid="condition-scope-error"
        >
          {{ $t(issue.key, issue.args ?? []) }}
        </div>
      </div>

      <!-- ④ 高级（都有合理默认；不改也能用） -->
      <div class="grid grid-cols-3 gap-3">
        <div v-if="needsPoint">
          <div class="mb-1 text-sm">{{ $t('page.iot.alert.triggerMode') }}</div>
          <Select v-model:value="form.triggerMode" style="width: 100%">
            <SelectOption value="CONSECUTIVE_COUNT">
              {{ $t('page.iot.alert.mode.count') }}
            </SelectOption>
            <SelectOption value="DURATION">
              {{ $t('page.iot.alert.mode.duration') }}
            </SelectOption>
            <SelectOption value="IMMEDIATE">
              {{ $t('page.iot.alert.mode.immediate') }}
            </SelectOption>
          </Select>
        </div>
        <div v-if="needsPoint">
          <div class="mb-1 text-sm">
            {{
              form.triggerMode === 'DURATION'
                ? $t('page.iot.alert.durationSeconds')
                : $t('page.iot.alert.consecutiveCount')
            }}
          </div>
          <InputNumber
            v-model:value="form.triggerThreshold"
            :min="1"
            class="w-full"
          />
        </div>
        <div>
          <div class="mb-1 text-sm">
            {{ $t('page.iot.alert.repeatInterval') }}
          </div>
          <InputNumber
            v-model:value="form.repeatIntervalSec"
            :min="60"
            class="w-full"
          />
        </div>
        <div>
          <div class="mb-1 text-sm">
            {{ $t('page.iot.alert.severityField') }}
          </div>
          <Select v-model:value="form.severity" style="width: 100%">
            <SelectOption value="INFO">
              {{ $t('page.iot.alert.severity.info') }}
            </SelectOption>
            <SelectOption value="WARNING">
              {{ $t('page.iot.alert.severity.warning') }}
            </SelectOption>
            <SelectOption value="CRITICAL">
              {{ $t('page.iot.alert.severity.critical') }}
            </SelectOption>
          </Select>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <div class="mb-1 text-sm">{{ $t('page.iot.alert.channels') }}</div>
          <CheckboxGroup v-model:value="form.channels">
            <Checkbox value="INBOX">
              {{ $t('page.iot.alert.channel.inbox') }}
            </Checkbox>
            <Checkbox value="EMAIL">
              {{ $t('page.iot.alert.channel.email') }}
            </Checkbox>
          </CheckboxGroup>
          <div class="mt-1 text-xs text-muted-foreground">
            {{ $t('page.iot.alert.channelHint') }}
          </div>
        </div>
      </div>

      <!--
        收件人：以「选系统用户」为主、额外邮箱为辅。
        保存时会**合回**后端 `notify_targets` 的单字段契约（用户ID + 邮箱，逗号分隔），
        因此后端无需任何改动，且**线上既有数据（含邮箱的历史规则）能原样回显与保存**。
      -->
      <div class="space-y-2">
        <div>
          <div class="mb-1 text-sm">
            {{ $t('page.iot.alert.notifyUsers') }}
          </div>
          <!-- 系统通用用户选择器：多选 / 可搜索 / 按 id 回显（编辑时显示姓名而不是裸 ID） -->
          <UserSelect v-model="form.notifyUserIds" />
          <div class="mt-1 text-xs text-muted-foreground">
            {{ $t('page.iot.alert.notifyUsersHint') }}
          </div>
        </div>

        <div>
          <div class="mb-1 text-sm">
            {{ $t('page.iot.alert.notifyExtraEmails') }}
          </div>
          <Select
            v-model:value="form.notifyExtraEmails"
            mode="tags"
            class="w-full"
            :placeholder="$t('page.iot.alert.notifyExtraEmailsPlaceholder')"
            :token-separators="[',', ' ', ';']"
          />
          <!--
            🔴 不含 @ 的条目会被后端按形态**静默忽略** ⇒ 必须当场指出。
            不提示的后果是"我明明填了收件人，告警却没人收到"，且无从排查。
          -->
          <div
            v-if="invalidEmails.length > 0"
            class="mt-1 text-xs text-red-500"
          >
            {{
              $t('page.iot.alert.notifyExtraEmailsInvalid', [
                invalidEmails.join(', '),
              ])
            }}
          </div>
          <div class="mt-1 text-xs text-muted-foreground">
            {{ $t('page.iot.alert.notifyExtraEmailsHint') }}
          </div>
        </div>

        <!-- 历史遗留 token：原样保留并如实告知（静默清除才是更糟的选择） -->
        <Alert
          v-if="form.notifyUnrecognized.length > 0"
          type="warning"
          show-icon
          :message="
            $t('page.iot.alert.notifyUnrecognized', [
              form.notifyUnrecognized.join(', '),
            ])
          "
        />

        <!--
          🔴 未配置通知对象必须当场可见（issue #226）：站内信走兜底链、邮件仅在平台配置了
          兜底邮箱时才会送达 —— 文案全部在语言包里，不在这里写死，避免 zh/en 口径漂移。
        -->
        <Alert
          v-if="notifyHint"
          show-icon
          :message="$t(notifyHint)"
          :type="
            notifyRisk === 'noChannel'
              ? 'error'
              : notifyRisk === 'inboxFallback'
                ? 'info'
                : 'warning'
          "
        />
      </div>

      <div>
        <div class="mb-1 text-sm">{{ $t('page.iot.alert.description') }}</div>
        <Input v-model:value="form.description" :maxlength="512" />
      </div>

      <!-- ⑤ 人话预览 + 「这样配会发生什么」 -->
      <Alert :message="$t('page.iot.alert.rule.preview')" show-icon type="info">
        <template #description>
          <div class="space-y-1">
            <div class="text-base font-semibold">{{ summaryText }}</div>
            <!--
              多条件规则逐条列出并**用「且」连成一句**（真 AND：组内全部条件同时满足才告警）。
              连接词走 i18n 键，不在这里写死，避免 zh/en 口径漂移。
            -->
            <div
              v-if="summary.conditionClauses?.length"
              class="text-xs"
              data-testid="summary-condition-clause"
            >
              {{
                summary.conditionClauses
                  .map((clause) => $t(clause.key, resolveArgs(clause.args, $t)))
                  .join($t(CONDITION_CLAUSE_JOIN_KEY))
              }}
            </div>
            <ul
              v-if="summary.expectations.length > 0"
              class="list-disc pl-5 text-xs"
            >
              <li v-for="key in summary.expectations" :key="key">
                {{ $t(key) }}
              </li>
            </ul>
            <ul
              v-for="warning in summary.warnings"
              :key="warning.key"
              class="list-disc pl-5 text-xs text-orange-600"
            >
              <li>
                {{ $t(warning.key, resolveArgs(warning.args ?? [], $t)) }}
              </li>
            </ul>
            <div v-if="needsPoint" class="text-xs text-muted-foreground">
              {{ $t('page.iot.alert.rule.offlineHint') }}
            </div>
          </div>
        </template>
      </Alert>

      <!--
        ⑥ 历史试算（只读预览：不改保存逻辑，断档类如实说明无法试算）
        真 AND：试算按**条件组整体**做（组内各点位序列按时间对齐后逐时刻 AND 判定），
        对齐口径与容差在 `../rule-preview` 模块头显式定义、并在下面如实展示。
      -->
      <div class="rounded border border-solid border-gray-200 p-3">
        <div class="mb-1 text-sm font-semibold">
          {{ $t('page.iot.alert.rule.backtest.title') }}
        </div>
        <div class="mb-2 text-xs text-muted-foreground">
          {{ $t('page.iot.alert.rule.backtest.hint') }}
        </div>

        <!-- 断档/离线类没有阈值条件：当场说清「无法试算、去哪核验」，而不是给一个永远点不动的按钮 -->
        <Alert
          v-if="!needsPoint"
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
              show-search
              style="width: 100%"
              :placeholder="
                $t('page.iot.alert.rule.backtest.devicePlaceholder')
              "
              @change="onBacktestDeviceChange"
            >
              <SelectOption
                v-for="item in devices"
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
            <span
              v-if="!backtestReady"
              class="ml-2 text-xs text-muted-foreground"
            >
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
            class="mt-1 text-xs text-orange-600"
          >
            {{
              $t('page.iot.alert.rule.backtest.skipped', [
                backtestResult.skippedSamples,
              ])
            }}
          </div>
          <div
            v-if="backtestResult.truncatedSamples > 0"
            class="mt-1 text-xs text-orange-600"
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
              class="mt-2 rounded border border-solid border-gray-100 p-2"
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
                        item.sampleTs === null
                          ? '-'
                          : formatDateTime(item.sampleTs)
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

      <Alert v-if="submitError" :message="submitError" show-icon type="error" />
    </div>

    <template #footer>
      <Space>
        <Button @click="drawerApi.close()">{{ $t('common.cancel') }}</Button>
        <Button
          :disabled="!summary.ready"
          :loading="submitting"
          type="primary"
          @click="onSubmit"
        >
          {{ $t('page.iot.alert.rule.save') }}
        </Button>
      </Space>
    </template>
  </Drawer>
</template>
