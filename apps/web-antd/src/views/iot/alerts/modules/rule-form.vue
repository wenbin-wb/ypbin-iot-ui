<script lang="ts" setup>
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
import { notifyHintKey, resolveNotifyRisk } from '../notify-risk';
import {
  findInvalidEmails,
  joinNotifyTargets,
  splitNotifyTargets,
} from '../notify-targets';
import { evaluateRulePreview, RULE_PREVIEW_WINDOWS } from '../rule-preview';
import { buildRuleSummary, resolveArgs } from '../summary';

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
  propertyId: '',
  operator: '',
  threshold: '',
  valueType: 'NUMERIC' as string,
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

const needsPoint = computed(() => Boolean(form.value.operator));

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

/** 点位选择项的展示名（含单位），预览里用同一份数据。 */
const propertyLabel = computed(() => {
  const hit = propertyOptions.value.find(
    (item) => item.value === form.value.propertyId,
  );
  return hit?.label ?? form.value.propertyId;
});

const propertyUnit = computed(
  () =>
    propertyOptions.value.find((item) => item.value === form.value.propertyId)
      ?.unit,
);

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

const backtestPropertyId = ref('');

const backtestWindow = ref<RulePreviewWindowKey>('24h');

const backtestPropertyOptions = ref<
  { label: string; unit?: string; value: string }[]
>([]);

const backtestLoading = ref(false);

const backtestError = ref('');

const backtestResult = ref<RulePreviewResult>();

/** 设备+点位都选了才允许试算（缺哪个由按钮旁提示说清楚）。 */
const backtestReady = computed(
  () => backtestDeviceId.value !== '' && backtestPropertyId.value !== '',
);

/** 试算条件与保存请求**同源**（同一 `toRequest().points`），避免预览/提交两套口径。 */
const backtestConditions = computed(() => toRequest().points ?? []);

const backtestPropertyLabel = computed(() => {
  const hit = backtestPropertyOptions.value.find(
    (item) => item.value === backtestPropertyId.value,
  );
  return hit?.label ?? backtestPropertyId.value;
});

/** 结果里命中条件的人话（如「温度 (temp) > 30」）。 */
const backtestConditionTexts = computed(() =>
  (backtestResult.value?.conditions ?? []).map(
    (condition) =>
      `${backtestPropertyLabel.value} ${condition.symbol} ${condition.threshold}`,
  ),
);

/** 样本明细：取最近 BACKTEST_SAMPLE_ROWS 条，倒序展示（最近在前）。 */
const backtestSampleRows = computed(() =>
  (backtestResult.value?.samples ?? []).slice(-BACKTEST_SAMPLE_ROWS).reverse(),
);

/**
 * 按试算设备所属产品加载点位候选（与主表单 `loadPropertiesForProduct` 同一数据源，
 * 但不改主表单状态：试算区是独立选择，不能悄悄覆盖用户正在编辑的规则点位）。
 */
async function loadBacktestProperties(deviceId: string) {
  backtestPropertyOptions.value = [];
  // 与主表单同一设备且候选已加载：直接复用，不重复打 services/properties 两串请求
  if (deviceId === form.value.deviceId && propertyOptions.value.length > 0) {
    backtestPropertyOptions.value = propertyOptions.value.map((item) => ({
      ...item,
    }));
    return;
  }
  const hit = devices.value.find((item) => item.id === deviceId);
  const productId = hit?.productId ?? '';
  if (!productId) {
    return;
  }
  try {
    const services = await listServices(productId);
    const options: { label: string; unit?: string; value: string }[] = [];
    for (const service of services) {
      const properties = await listProperties(productId, service.id);
      for (const property of properties) {
        options.push({
          label: `${property.propertyName} (${property.identifier})`,
          unit: property.unit ?? undefined,
          value: property.identifier,
        });
      }
    }
    backtestPropertyOptions.value = options;
  } catch (error) {
    backtestResult.value = undefined;
    backtestError.value = extractErrorMessage(
      error,
      $t('page.iot.alert.rule.propertyLoadFailed'),
    );
  }
}

/** 切换试算设备：清空上一个点位并重载候选。 */
function onBacktestDeviceChange(deviceId: unknown) {
  const id = deviceId ? String(deviceId) : '';
  backtestResult.value = undefined;
  backtestError.value = '';
  backtestPropertyId.value = '';
  if (id) {
    void loadBacktestProperties(id);
  } else {
    backtestPropertyOptions.value = [];
  }
}

/**
 * 规则条件/时间窗一改，上一次试算结果立即失效（避免用户拿着旧阈值的结果当真）。
 * 试算设备与点位由各自 change 处理器清理，不在此重复。
 */
watch(
  () =>
    [
      form.value.operator,
      form.value.threshold,
      form.value.valueType,
      backtestWindow.value,
    ] as const,
  () => {
    backtestResult.value = undefined;
    backtestError.value = '';
  },
);

/** 打开抽屉时把主表单已有设备/点位同步成试算默认值（编辑规则时少点两下）。 */
function syncBacktestFromForm() {
  backtestResult.value = undefined;
  backtestError.value = '';
  const deviceId = form.value.deviceId;
  backtestDeviceId.value = deviceId || '';
  backtestPropertyId.value = deviceId ? form.value.propertyId || '' : '';
  if (deviceId) {
    void loadBacktestProperties(deviceId).then(() => {
      // 点位候选加载完成后，若主表单已有合法点位则保持选中
      if (form.value.propertyId) {
        backtestPropertyId.value = form.value.propertyId;
      }
    });
  } else {
    backtestPropertyOptions.value = [];
  }
}

/**
 * 执行历史试算。
 *
 * - 断档/离线类（无 points）：**不发历史请求**，直接给出「无法试算」的诚实结论；
 * - 失败原样展示后端 message（例如时序库未启用），绝不伪装成「没有数据」；
 * - `backtestLoading` 期间按钮 loading 且点击短路 ⇒ 防重复请求。
 */
async function runBacktest() {
  if (backtestLoading.value || !backtestReady.value) {
    return;
  }
  backtestError.value = '';
  backtestResult.value = undefined;
  const to = Date.now();
  const from = to - RULE_PREVIEW_WINDOWS[backtestWindow.value];
  const conditions = (backtestConditions.value ?? []).map((condition) => ({
    ...condition,
    propertyId: backtestPropertyId.value,
  }));
  if (conditions.length === 0) {
    backtestResult.value = evaluateRulePreview({
      conditions: [],
      from,
      points: [],
      to,
    });
    return;
  }
  backtestLoading.value = true;
  try {
    const points = await getDeviceSeries(backtestDeviceId.value, {
      from,
      limit: BACKTEST_SERIES_LIMIT,
      propertyId: backtestPropertyId.value,
      to,
    });
    backtestResult.value = evaluateRulePreview({
      conditions,
      from,
      limit: BACKTEST_SERIES_LIMIT,
      points,
      to,
    });
  } catch (error) {
    backtestResult.value = undefined;
    backtestError.value = extractErrorMessage(
      error,
      $t('page.iot.alert.rule.backtest.loadFailed'),
    );
  } finally {
    backtestLoading.value = false;
  }
}

/** 人话预览（与保存请求**同源**：两者都只读 `form`）。 */
const summary = computed(() =>
  buildRuleSummary({
    ...form.value,
    channels: form.value.channels.join(','),
    deviceLabel: deviceLabel.value,
    productLabel: productLabel.value,
    operator: needsPoint.value ? form.value.operator : undefined,
    propertyLabel: propertyLabel.value,
    unit: propertyUnit.value,
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
  form.value.propertyId = '';
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
  form.value.propertyId = '';
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
 * 清空比较符 = 这条规则不再有阈值条件（即变成「设备离线/数据中断」类规则）。
 * 清空时同步清掉点位与阈值，避免留下半截条件（后端会按「零点位条件」处理）。
 */
function onOperatorChange(value: any) {
  const cleared = value === undefined || value === null || value === '';
  if (!cleared) {
    // ⚠️ 非清空分支**必须直接返回**：早期实现无条件调 `onScopeChange()`，而它开头就会清空
    // propertyId/propertyOptions ⇒ 用户选好点位后把 `>` 改成 `<`，点位会被悄悄清掉、预览退回
    // 「请选择要监控的点位」（独立复核 2026-10-03 判为**本轮新引入的回归**）。
    return;
  }
  form.value.propertyId = '';
  form.value.threshold = '';
  onScopeChange();
}

/** 选点位 ⇒ 顺带按物模型决定比较域（布尔点位自动切到 BOOLEAN，比较符收敛为等于/不等于）。 */
function onPropertyChange(propertyId: string) {
  const hit = propertyOptions.value.find((item) => item.value === propertyId);
  const boolLike = (hit?.dataType ?? '').toLowerCase().includes('bool');
  form.value.valueType = boolLike ? 'BOOLEAN' : 'NUMERIC';
  if (boolLike && !['EQ', 'NE'].includes(form.value.operator)) {
    form.value.operator = 'EQ';
    form.value.threshold = '1';
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
  form.value.operator = target.defaultOperator ?? '';
  form.value.valueType = 'NUMERIC';
  form.value.threshold = '';
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
  const point = rule.points?.[0];
  form.value.propertyId = point?.propertyId ?? '';
  form.value.operator = point?.operator ?? '';
  form.value.threshold = point?.threshold ?? '';
  form.value.valueType = point?.valueType ?? 'NUMERIC';
  if (form.value.deviceId) {
    void onDeviceChange(form.value.deviceId).then(() => {
      form.value.propertyId = point?.propertyId ?? '';
    });
  } else if (form.value.productId) {
    // 产品级规则没有设备：必须按产品加载点位，否则点位下拉为空、人话预览里只能显示标识
    void loadPropertiesForProduct().then(() => {
      form.value.propertyId = point?.propertyId ?? '';
    });
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

/** 保存前把表单拼成后端契约（**不做字段改名映射**：契约字段与后端 DTO 同名）。 */
function toRequest(): IotAlertApi.RuleSaveReq {
  const pointLike = needsPoint.value;
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
    points: pointLike
      ? [
          {
            propertyId: form.value.propertyId,
            operator: form.value.operator,
            threshold: String(form.value.threshold),
            valueType: form.value.valueType,
          },
        ]
      : [],
  };
}

async function onSubmit() {
  submitError.value = '';
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

      <!-- ③ 点位 + 阈值（仅点位类模板） -->
      <div v-if="needsPoint" class="grid grid-cols-3 gap-3">
        <div>
          <div class="mb-1 text-sm">{{ $t('page.iot.alert.property') }}</div>
          <Select
            v-model:value="form.propertyId"
            :placeholder="$t('page.iot.alert.rule.pickPoint')"
            show-search
            style="width: 100%"
            @change="(value: any) => onPropertyChange(String(value))"
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
          <div class="mb-1 text-sm">{{ $t('page.iot.alert.operator') }}</div>
          <Select
            v-model:value="form.operator"
            allow-clear
            style="width: 100%"
            :placeholder="$t('page.iot.alert.rule.operatorHint')"
            @change="onOperatorChange"
          >
            <SelectOption value="GT">&gt;</SelectOption>
            <SelectOption value="GTE">&gt;=</SelectOption>
            <SelectOption value="LT">&lt;</SelectOption>
            <SelectOption value="LTE">&lt;=</SelectOption>
            <SelectOption value="EQ">=</SelectOption>
            <SelectOption value="NE">!=</SelectOption>
          </Select>
        </div>
        <div>
          <div class="mb-1 text-sm">
            {{ $t('page.iot.alert.threshold') }}
            <span v-if="propertyUnit" class="text-muted-foreground">
              ({{ propertyUnit }})
            </span>
          </div>
          <Input
            v-model:value="form.threshold"
            :placeholder="$t('page.iot.alert.rule.thresholdPlaceholder')"
          />
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

      <!-- ⑥ 历史试算（只读预览：不改保存逻辑，断档类如实说明无法试算） -->
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
            <div class="mb-1 text-sm">{{ $t('page.iot.alert.property') }}</div>
            <Select
              v-model:value="backtestPropertyId"
              allow-clear
              show-search
              style="width: 100%"
              :placeholder="
                $t('page.iot.alert.rule.backtest.propertyPlaceholder')
              "
              @change="
                () => {
                  backtestResult = undefined;
                  backtestError = '';
                }
              "
            >
              <SelectOption
                v-for="item in backtestPropertyOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
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

        <Alert
          v-else-if="backtestResult?.kind === 'unsupported'"
          class="mt-2"
          :message="
            backtestResult.reason === 'empty-conditions'
              ? $t('page.iot.alert.rule.backtest.unsupportedNoCondition')
              : $t('page.iot.alert.summary.needNumber')
          "
          show-icon
          type="warning"
        />

        <template v-else-if="backtestResult?.kind === 'ok'">
          <div class="mt-2 text-sm font-semibold">
            {{ $t('page.iot.alert.rule.backtest.resultTitle') }}
          </div>
          <Descriptions class="mt-1" :column="2" size="small" bordered>
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

          <div
            v-if="backtestConditionTexts.length > 0"
            class="mt-1 text-xs text-muted-foreground"
          >
            {{ $t('page.iot.alert.rule.backtest.conditionNote') }}:
            {{ backtestConditionTexts.join('; ') }}
          </div>
          <div class="mt-1 text-xs text-muted-foreground">
            {{ $t('page.iot.alert.rule.backtest.conditionsAppliedToProperty') }}
          </div>

          <Alert
            v-if="backtestResult.usedSamples === 0"
            class="mt-2"
            :message="$t('page.iot.alert.rule.backtest.emptyData')"
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
          <div
            v-if="backtestResult.conditions.length > 1"
            class="mt-1 text-xs text-muted-foreground"
          >
            {{ $t('page.iot.alert.rule.backtest.andNote') }}
          </div>
          <div class="mt-1 text-xs text-muted-foreground">
            {{ $t('page.iot.alert.rule.backtest.approximationNote') }}
          </div>

          <div v-if="backtestSampleRows.length > 0" class="mt-2">
            <div class="mb-1 text-xs font-semibold">
              {{
                $t('page.iot.alert.rule.backtest.samplesTitle', [
                  Math.min(BACKTEST_SAMPLE_ROWS, backtestResult.usedSamples),
                ])
              }}
            </div>
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-muted-foreground">
                  <th>{{ $t('page.iot.alert.rule.backtest.sampleTime') }}</th>
                  <th>{{ $t('page.iot.alert.rule.backtest.sampleValue') }}</th>
                  <th>
                    {{ $t('page.iot.alert.rule.backtest.sampleMatched') }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="sample in backtestSampleRows"
                  :key="`${sample.ts}-${sample.value}`"
                >
                  <td>{{ formatDateTime(sample.ts) }}</td>
                  <td class="font-mono">
                    {{ sample.value === '' ? '-' : sample.value }}
                  </td>
                  <td>
                    <Tag :color="sample.matched ? 'success' : 'default'">
                      {{
                        sample.matched
                          ? $t('page.iot.alert.rule.backtest.matched')
                          : $t('page.iot.alert.rule.backtest.notMatched')
                      }}
                    </Tag>
                  </td>
                </tr>
              </tbody>
            </table>
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
