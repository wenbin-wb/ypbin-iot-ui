<script lang="ts" setup>
import type { IotCommandApi, IotThingModelApi } from '#/api/iot';

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { useAccess } from '@vben/access';

import {
  Alert,
  Button,
  Descriptions,
  DescriptionsItem,
  Empty,
  Input,
  InputNumber,
  message,
  Pagination,
  Popconfirm,
  Select,
  SelectOption,
  Spin,
  Table,
  Tag,
  Textarea,
  Tooltip,
} from 'ant-design-vue';

import {
  getDeviceCommands,
  isResendableStatus,
  isTerminalStatus,
  listCommands,
  listProperties,
  listServices,
  resendDeviceCommand,
  sendDeviceCommand,
} from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

/**
 * 「在线调试」页签（段 C，设计 §7.5）：选动作 → 填参数 → 下发 → 轮询看状态与回执。
 *
 * **只用后端既有的三个端点**（`POST/GET /iot/devices/{id}/commands`、
 * `POST /iot/devices/{id}/commands/{requestId}/resend`），不为写页面新增任何后端字段。
 *
 * 三条必须守住的纪律：
 *
 * 1. **三态如实展示**：加载中 / 空态（「暂无指令记录」）/ 失败态（**原样**显示后端 `message`，
 *    并保留原始 `code`/`message` 可展开查看）。**绝不**把 `R.code != 200` 的失败画成「没有数据」——
 *    那会让人以为设备从没被下发过指令。轮询失败同理：**不清空**已展示的记录，只提示「列表为上次成功结果」。
 * 2. **失败原因给人话**：后端 `error_code` 六类（`NO_SUBSCRIBER` = 「设备未连接」等）各有文案，
 *    但**未知码不吞**——按原始码展示，原始码与 `error_msg` 在展开区一直可见。
 * 3. **重发是「重发同一请求」**：调 resend 端点，**不新生成 `requestId`**（后端 `retry_count+1`），
 *    且只有 `failed`/`timeout` 可重发（前端先禁用，后端仍会二次校验）。
 *
 * **契约限制（写死在页面文案里，不假装支持）**：后端单条指令只接受**一个** `identifier`
 * （`CommandPayloads` 对 `property_get` 只放一个元素）⇒ 多行/多选**由前端拆成 N 条独立指令**
 * （各自 `requestId`、各自可重发），并给出**同一批次**的汇总与高亮；上限见 {@link MAX_FANOUT}。
 * 「点位留空 = 读取全部可读属性」是后端 B1 的既定语义，**原样支持**。
 *
 * `writeDesired`（下发同时写影子 desired）后端 U-B1 **显式拒绝** ⇒ 页面**不做**那个复选框
 * （避免做成假按钮），只放一行说明把用户指向既有的影子接口。
 */
const props = defineProps<{
  deviceId: string;
  productId?: string;
}>();

/** 一次下发最多拆出多少条指令（后端单条只接一个标识 ⇒ 多点位必须拆）。超限**前端先拒**。 */
const MAX_FANOUT = 20;

/** 后端 `CommandSendReq.MAX_TIMEOUT_MS`（1 小时）。 */
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

/** 历史列表单页条数（后端单页上限 100，这里取一屏能看全的数）。 */
const HISTORY_PAGE_SIZE = 10;

/** 轮询间隔：P0 只用轮询，**不引入 ws/SSE**（设计 §7.5 第 3 条）。 */
const POLL_INTERVAL_MS = 2000;

/** 状态下拉的顺序（与后端状态机同序；空 = 全部）。 */
const STATUS_OPTIONS: IotCommandApi.CommandStatusCode[] = [
  'pending',
  'sent',
  'succeeded',
  'failed',
  'timeout',
  'cancelled',
];

// ---------------- 下发表单 ----------------

/** 当前动作。 */
const kind = ref<IotCommandApi.CommandKindCode>('property_set');

/** 超时（毫秒）；留空 = 用后端全局默认。 */
const timeoutMs = ref<number | undefined>(undefined);

interface SetRow {
  identifier?: string;
  key: number;
  value: string;
}

let rowSeed = 0;

/** 「属性设置」的点位 → 值映射行（后端一条指令只接一个点位 ⇒ 多行会拆成多条）。 */
const setRows = ref<SetRow[]>([{ key: (rowSeed += 1), value: '' }]);

/** 「属性读取」选中的点位（空 = 全部可读属性）。 */
const getSelection = ref<string[]>([]);

/** 「服务调用」选中的物模型命令标识。 */
const serviceIdentifier = ref<string | undefined>(undefined);

/** 「服务调用」的 `params`（JSON 对象文本）。 */
const paramsText = ref('');

/** 客户端校验提示（**不是**后端失败，单独用 warning 展示，避免与前者的「原样展示」混淆）。 */
const formError = ref('');

// ---------------- 下发结果（本批） ----------------

interface SendResult {
  error?: string;
  identifier: string;
  raw?: string;
  requestId?: string;
  statusCode?: string;
}

const sending = ref(false);

/** 最近一批的下发结果（拆分成 N 条时逐条可见，避免「一次点击 N 条孤立记录」的困惑）。 */
const sendResults = ref<SendResult[]>([]);

/** 最近一批产生的 `requestId`（历史列表据此高亮「这 N 条是同一批」）。 */
const batchRequestIds = ref<Set<string>>(new Set());

/** 批次序号（**前端本地计数、不入库**，仅用于让用户看出「是一批」）。 */
const batchSequence = ref(0);

/** 后端失败详情（`message` 原样 + 原始 `code`/信封可展开）。 */
const sendError = ref<ErrorDetail | undefined>(undefined);

// ---------------- 物模型（点位与命令） ----------------

const modelLoading = ref(false);

const modelError = ref('');

const properties = ref<IotThingModelApi.PropertyResp[]>([]);

const commands = ref<IotThingModelApi.CommandResp[]>([]);

/** 可写点位（`accessMode ∈ {W, RW}`）→ 属性设置的目标。 */
const setPropertyOptions = computed(() =>
  properties.value
    .filter((item) => item.accessMode === 'W' || item.accessMode === 'RW')
    .map((item) => ({ label: propertyLabel(item), value: item.identifier })),
);

/** 可读点位（`accessMode ∈ {R, RW}`）→ 属性读取的目标。 */
const getPropertyOptions = computed(() =>
  properties.value
    .filter((item) => item.accessMode === 'R' || item.accessMode === 'RW')
    .map((item) => ({ label: propertyLabel(item), value: item.identifier })),
);

/**
 * 可调用的物模型命令。
 *
 * 标识按后端口径**跨服务去重**（后端 `ThingModel` 的 commands 索引是按 identifier 归并的），
 * 标签带上服务名便于定位——后端一次只能表达一个标识。
 */
const commandOptions = computed(() => {
  const seen = new Set<string>();
  const options: { label: string; value: string }[] = [];
  for (const command of commands.value) {
    if (seen.has(command.identifier)) {
      continue;
    }
    seen.add(command.identifier);
    options.push({
      label: `${command.identifier}（${command.commandName}）`,
      value: command.identifier,
    });
  }
  return options;
});

function propertyLabel(property: IotThingModelApi.PropertyResp): string {
  return `${property.identifier}（${property.propertyName}｜${property.dataType}｜${property.accessMode}）`;
}

// ---------------- 权限门禁 ----------------

/**
 * 本区块的权限门禁用 **computed + `v-if`**，不用 `v-access` 指令。
 *
 * 原因（已核实上游实现）：`packages/effects/access/src/directive.ts` 里 `v-access`
 * **只注册了 `mounted`、没有 `updated`**，且无权限时直接 `el.remove()`（摘掉即不可逆）。
 * ⇒ 权限码若在挂载**之后**才到位（或运行期变化），被摘掉的区块**永远回不来**；
 * 反向（先有后撤）则元素留在页面上继续放行入口。用户看到的是「功能静默消失/静默残留」——
 * 没有报错、没有空白。`computed` 读 pinia 的 `accessCodes`，随权限码变化自动重算，
 * 可见性语义与指令一致但无此时序窗口。上游行为已由用例钉住（见 detail-debug.test.ts）。
 *
 * 注意两者权限码**不同**：看历史要 `iot:debug:get`，下发/重发要 `iot:debug:send`
 * （与后端 `@SaCheckPermission` 一一对应），不能合并成一个。
 */
const { hasAccessByCodes } = useAccess();

/** 查看下发/回执记录（`GET /iot/devices/{id}/commands`）。 */
const canViewHistory = computed(() => hasAccessByCodes(['iot:debug:get']));

/** 下发与重发（`POST /iot/devices/{id}/commands[...]`）。 */
const canSendCommand = computed(() => hasAccessByCodes(['iot:debug:send']));

// ---------------- 历史列表 ----------------

const history = ref<IotCommandApi.CommandInstanceResp[]>([]);

const historyTotal = ref(0);

const historyPage = ref(1);

/** 状态过滤（空 = 全部）。 */
const historyStatus = ref<'' | IotCommandApi.CommandStatusCode>('');

const historyLoading = ref(false);

/** 是否已经完成过一次加载（用于区分「还没加载」与「加载成功但确实为空」）。 */
const historyLoaded = ref(false);

/** 查询失败详情——只要它非空，就**不显示空态**。 */
const historyError = ref<ErrorDetail | undefined>(undefined);

/** 轮询失败详情（**不清空**列表；只提示「这是上一次成功的结果」，并停掉轮询）。 */
const pollError = ref<ErrorDetail | undefined>(undefined);

let pollTimer: ReturnType<typeof setInterval> | undefined;

const historyColumns = computed(() => [
  {
    dataIndex: 'createTime',
    key: 'createTime',
    title: $t('page.iot.debug.columnTime'),
    width: 170,
  },
  { key: 'kind', title: $t('page.iot.debug.columnKind'), width: 100 },
  { key: 'identifier', title: $t('page.iot.debug.columnIdentifier') },
  { key: 'statusCode', title: $t('page.iot.debug.columnStatus'), width: 190 },
  {
    dataIndex: 'retryCount',
    key: 'retryCount',
    title: $t('page.iot.debug.columnRetry'),
    width: 90,
  },
  { key: 'action', title: $t('common.action'), width: 150 },
]);

// ---------------- 错误详情（原样保留后端 code/message） ----------------

interface ErrorDetail {
  /** 后端 `R.code`（拿不到时为空串）。 */
  code: string;
  /** 后端 `R.message`（拿不到时用 fallback）。 */
  message: string;
  /** 原始信封文本，供展开查看。 */
  raw: string;
}

/**
 * 取后端响应的「原样」错误：`extractErrorMessage` 只回文案，这里额外保留 `R.code` 与原始信封。
 *
 * 业务失败的形态是 **HTTP 200 + `R.code != 200`**（全仓约定），信封在 `error.response.data` 上。
 */
function describeError(error: unknown, fallback: string): ErrorDetail {
  const envelope = readEnvelope(error);
  const rawCode = envelope?.code;
  const code =
    rawCode === null || rawCode === undefined ? '' : String(rawCode);
  const rawMessage = envelope?.message;
  const message =
    typeof rawMessage === 'string' && rawMessage !== ''
      ? rawMessage
      : extractErrorMessage(error, fallback);
  let raw: string;
  if (envelope) {
    try {
      raw = JSON.stringify(envelope, null, 2);
    } catch {
      raw = message;
    }
  } else {
    raw = error instanceof Error ? error.message : String(error);
  }
  return { code, message, raw };
}

function readEnvelope(
  error: unknown,
): undefined | { code?: unknown; message?: unknown } {
  const record = error as
    | undefined
    | { data?: unknown; response?: { data?: unknown } };
  const payload = record?.response?.data ?? record?.data;
  if (payload && typeof payload === 'object') {
    return payload as { code?: unknown; message?: unknown };
  }
  return undefined;
}

/**
 * 后端计数 → 展示用数字：统一走 `#/utils/backend-number` 的 `toBackendNumber`。
 *
 * 后端 Long 全局序列化成字符串（实测 `PageResult.total` 是 `"17"`），而 antdv `Pagination.total`
 * 要求 `number`（实测喂字符串会触发 `[Vue warn] Invalid prop: type check failed for prop "total"`）
 * ⇒ 必须在进组件前显式转数。
 *
 * 此前这里是本文件私有的 `toCount`，`detail.vue`/`guide.vue` 各自又写了一遍；这个口径
 * 只有**一处实现**才不会再各自漂移。
 */

// ---------------- 文案 ----------------

/** 状态码 → 文案（未知码**不吞**，按原始码展示）。 */
function statusText(statusCode?: string): string {
  switch (statusCode) {
    case 'cancelled': {
      return $t('page.iot.debug.statusCancelled');
    }
    case 'failed': {
      return $t('page.iot.debug.statusFailed');
    }
    case 'pending': {
      return $t('page.iot.debug.statusPending');
    }
    case 'sent': {
      return $t('page.iot.debug.statusSent');
    }
    case 'succeeded': {
      return $t('page.iot.debug.statusSucceeded');
    }
    case 'timeout': {
      return $t('page.iot.debug.statusTimeout');
    }
    default: {
      return statusCode
        ? `${$t('page.iot.debug.unknownStatus')}（${statusCode}）`
        : '-';
    }
  }
}

function statusColor(statusCode?: string): string {
  switch (statusCode) {
    case 'failed': {
      return 'error';
    }
    case 'pending': {
      return 'default';
    }
    case 'sent': {
      return 'processing';
    }
    case 'succeeded': {
      return 'success';
    }
    case 'timeout': {
      return 'warning';
    }
    default: {
      return 'default';
    }
  }
}

/** 动作码 → 文案（未知码按原始码展示）。 */
function kindText(kindCode?: string): string {
  switch (kindCode) {
    case 'property_get': {
      return $t('page.iot.debug.kindPropertyGet');
    }
    case 'property_set': {
      return $t('page.iot.debug.kindPropertySet');
    }
    case 'service_call': {
      return $t('page.iot.debug.kindServiceCall');
    }
    default: {
      return kindCode ?? '-';
    }
  }
}

/** 失败原因码 → 人话（**未知码不吞**，按原始码展示）。 */
function errorCodeText(errorCode?: string): string {
  switch (errorCode) {
    case 'DEVICE_OFFLINE': {
      return $t('page.iot.debug.errorDeviceOffline');
    }
    case 'DEVICE_REJECTED': {
      return $t('page.iot.debug.errorDeviceRejected');
    }
    case 'EMQX_ERROR': {
      return $t('page.iot.debug.errorEmqx');
    }
    case 'NO_SUBSCRIBER': {
      return $t('page.iot.debug.errorNoSubscriber');
    }
    case 'TIMEOUT': {
      return $t('page.iot.debug.errorTimeout');
    }
    default: {
      return errorCode
        ? `${$t('page.iot.debug.unknownErrorCode')}（${errorCode}）`
        : '';
    }
  }
}

function showTotal(total: number): string {
  return $t('page.iot.debug.total', [String(total)]);
}

// ---------------- 数据加载 ----------------

/**
 * 载入该产品的物模型（点位与命令）。
 *
 * 层级与产品详情一致：**属性/命令挂在服务下** ⇒ 先取服务再逐服务取（服务数量是个位数，
 * 与设备数无关，不存在按设备循环的 N+1）。
 */
async function loadModel() {
  if (!props.productId) {
    properties.value = [];
    commands.value = [];
    return;
  }
  modelLoading.value = true;
  modelError.value = '';
  try {
    const serviceList = (await listServices(props.productId)) ?? [];
    const byService = await Promise.all(
      serviceList.map(async (service) => ({
        commands: (await listCommands(props.productId!, service.id)) ?? [],
        properties: (await listProperties(props.productId!, service.id)) ?? [],
      })),
    );
    properties.value = byService.flatMap((item) => item.properties);
    commands.value = byService.flatMap((item) => item.commands);
  } catch (error) {
    // 物模型读不到 ⇔ 无法选择下发目标：必须显式报错，不能静默留空下拉
    properties.value = [];
    commands.value = [];
    modelError.value = describeError(
      error,
      $t('page.iot.debug.loadModelFailed'),
    ).message;
  } finally {
    modelLoading.value = false;
  }
}

/**
 * 拉取历史列表。
 *
 * `silent = true` 用于轮询：失败时**不清空**已展示记录（否则一次网络抖动会把列表擦成空态，
 * 看起来像「没有指令记录」），只把原因写进 `pollError`，并**停掉轮询**——
 * 全局请求拦截器每次失败都会弹一次 `message.error`，2 秒一次地弹会让故障期的页面没法用；
 * 停掉后由用户点「刷新」重试（成功即自动恢复轮询）。
 */
async function loadHistory(options: { silent?: boolean } = {}) {
  if (!props.deviceId) {
    // 没有设备 ⇒ 没有可查的记录。**必须**把 historyLoaded 标成已完成：
    // 否则 `#emptyText` 的 `v-if="historyLoaded"` 不成立，列表区会**什么都没有**——
    // 正是「空白」而不是「空态」，与失败态也分不开（三态可辨的硬要求）。
    historyLoaded.value = true;
    historyLoading.value = false;
    return;
  }
  if (!options.silent) {
    historyLoading.value = true;
  }
  try {
    const result = await getDeviceCommands(props.deviceId, {
      page: historyPage.value,
      pageSize: HISTORY_PAGE_SIZE,
      statusCode: historyStatus.value === '' ? undefined : historyStatus.value,
    });
    history.value = result.items ?? [];
    // 后端 Long 全局序列化成**字符串**（实测 `GET /iot/devices/{id}/commands` 回
    // `"total":"17"`），而 `Pagination.total` 是 `number` ⇒ 这里必须显式转数，
    // 否则 antdv 报 `Invalid prop: type check failed for prop "total"`，
    // 脏数据时还会把分页算成 NaN。
    historyTotal.value = toBackendNumber(result.total);
    historyError.value = undefined;
    pollError.value = undefined;
  } catch (error) {
    const detail = describeError(
      error,
      $t('page.iot.debug.historyLoadFailed'),
    );
    if (options.silent) {
      // 轮询失败：列表原样保留，原始 code/信封一并留下（与 historyError 同口径）
      pollError.value = detail;
      stopPolling();
    } else {
      // 失败态与空态**必须分开**：这里清空的是列表数据，但错误详情非空 ⇒ 页面走 Alert 分支
      history.value = [];
      historyTotal.value = 0;
      historyError.value = detail;
    }
  } finally {
    if (!options.silent) {
      historyLoading.value = false;
      historyLoaded.value = true;
    }
    syncPolling();
  }
}

/**
 * 只要当页还有非终态实例就轮询；全部终态立刻停（**不引入 ws**）。
 *
 * `pollError` 非空表示上一次自动刷新失败 ⇒ **不重新拉起**定时器（否则会立刻又失败、又弹提示），
 * 由用户点「刷新」触发一次非静默加载，成功后 `pollError` 被清空，轮询自然恢复。
 */
function syncPolling() {
  const hasPending = history.value.some(
    (item) => !isTerminalStatus(item.statusCode),
  );
  if (hasPending && pollTimer === undefined && pollError.value === undefined) {
    pollTimer = setInterval(() => {
      void loadHistory({ silent: true });
    }, POLL_INTERVAL_MS);
  } else if (!hasPending && pollTimer !== undefined) {
    stopPolling();
  }
}

function stopPolling() {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

/** 打开页签/切换设备时的整体加载。 */
async function load() {
  stopPolling();
  historyPage.value = 1;
  historyLoaded.value = false;
  historyError.value = undefined;
  pollError.value = undefined;
  history.value = [];
  historyTotal.value = 0;
  batchRequestIds.value = new Set();
  sendResults.value = [];
  sendError.value = undefined;
  formError.value = '';
  await Promise.all([loadModel(), loadHistory()]);
}

onMounted(load);

// 抽屉是复用组件：设备切换时必须重新加载（否则会把上一台设备的记录当成这台设备的）
watch(
  () => [props.deviceId, props.productId],
  () => {
    void load();
  },
);

onUnmounted(stopPolling);

// ---------------- 表单交互 ----------------

function addSetRow() {
  setRows.value.push({ key: (rowSeed += 1), value: '' });
}

function removeSetRow(index: number) {
  setRows.value.splice(index, 1);
}

/** 切换动作时清掉上一次的客户端校验提示（参数区已换，旧提示会误导）。 */
function onKindChange() {
  formError.value = '';
}

/** 超时输入（留空或清空 = 用后端默认，不传 `timeoutMs`）。 */
function onTimeoutChange(value: null | number | string | undefined) {
  timeoutMs.value = typeof value === 'number' ? value : undefined;
}

function onStatusFilterChange() {
  historyPage.value = 1;
  void loadHistory();
}

function onPageChange(page: number) {
  historyPage.value = page;
  void loadHistory();
}

/**
 * 输入框文本 → 下发的 JSON 值。
 *
 * 口径写在字段说明里（`valueHint`）：优先按 JSON 解析（`25.5`→数字、`true`→布尔、
 * `"text"`→字符串、`{"a":1}`→对象），解析失败则按**字符串**下发（不静默丢弃用户输入）。
 */
function parseValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') {
    return '';
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

/** 解析 `params`：**必须是 JSON 对象**（与后端 B10 口径一致，前端先拦一道避免无谓往返）。 */
function parseParamsObject(
  text: string,
): { ok: false } | { ok: true; value: Record<string, unknown> } {
  const raw = text.trim() === '' ? '{}' : text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

interface SendTarget {
  identifier: string;
  req: IotCommandApi.CommandSendReq;
}

/** 组装本批要下发的指令（每条只带一个标识）；返回 `undefined` 表示校验未通过。 */
function buildTargets(): SendTarget[] | undefined {
  formError.value = '';
  if (!props.deviceId) {
    formError.value = $t('page.iot.debug.noDevice');
    return undefined;
  }
  if (!props.productId) {
    formError.value = $t('page.iot.debug.noProduct');
    return undefined;
  }
  const timeout =
    typeof timeoutMs.value === 'number' && timeoutMs.value > 0
      ? timeoutMs.value
      : undefined;
  if (kind.value === 'property_set') {
    const rows = setRows.value.filter(
      (row) => (row.identifier ?? '') !== '',
    );
    if (rows.length === 0) {
      formError.value = $t('page.iot.debug.noTarget');
      return undefined;
    }
    return rows.map((row) => ({
      identifier: row.identifier!,
      req: {
        identifier: row.identifier,
        kind: kind.value,
        params: { value: parseValue(row.value) },
        timeoutMs: timeout,
      },
    }));
  }
  if (kind.value === 'property_get') {
    // 空选 = 全部可读属性（后端 B1：properties 空数组 = 全部可读）
    if (getSelection.value.length === 0) {
      return [
        {
          identifier: $t('page.iot.debug.allReadable'),
          req: { kind: kind.value, timeoutMs: timeout },
        },
      ];
    }
    return getSelection.value.map((identifier) => ({
      identifier,
      req: { identifier, kind: kind.value, timeoutMs: timeout },
    }));
  }
  if (!serviceIdentifier.value) {
    formError.value = $t('page.iot.debug.noCommand');
    return undefined;
  }
  const parsed = parseParamsObject(paramsText.value);
  if (!parsed.ok) {
    formError.value = $t('page.iot.debug.paramsInvalid');
    return undefined;
  }
  return [
    {
      identifier: serviceIdentifier.value,
      req: {
        identifier: serviceIdentifier.value,
        kind: kind.value,
        params: parsed.value,
        timeoutMs: timeout,
      },
    },
  ];
}

/** 下发（多点位时**逐条拆分**；顺序发出，避免一次轰出几十条并发）。 */
async function onSend() {
  const targets = buildTargets();
  if (!targets) {
    return;
  }
  if (targets.length > MAX_FANOUT) {
    formError.value = $t('page.iot.debug.fanoutTooMany', [
      String(MAX_FANOUT),
      String(targets.length),
    ]);
    return;
  }
  sending.value = true;
  sendError.value = undefined;
  sendResults.value = [];
  batchSequence.value += 1;
  const batch = new Set<string>();
  try {
    for (const target of targets) {
      try {
        const instance = await sendDeviceCommand(props.deviceId, target.req);
        batch.add(instance.requestId);
        sendResults.value.push({
          identifier: target.identifier,
          requestId: instance.requestId,
          statusCode: instance.statusCode,
        });
      } catch (error) {
        const detail = describeError(error, $t('page.iot.debug.sendFailed'));
        // 逐条失败不中断整批：把失败的标识与后端原文一起留在结果里
        sendResults.value.push({
          error: detail.message,
          identifier: target.identifier,
          raw: detail.raw,
        });
      }
    }
    batchRequestIds.value = batch;
    historyPage.value = 1;
    await loadHistory();
  } finally {
    sending.value = false;
  }
}

/**
 * 重发**同一条**指令（同一 `requestId`，后端 `retry_count+1`）。
 *
 * 参数是表格插槽给的**结构类型**行（只取需要的两个字段，不对插槽类型做强断言）。
 */
async function onResend(record: {
  requestId?: string;
  statusCode?: string;
}) {
  const requestId = record.requestId;
  if (!requestId) {
    message.warning($t('page.iot.debug.resendNotAllowed'));
    return;
  }
  if (!isResendableStatus(record.statusCode)) {
    message.warning($t('page.iot.debug.resendNotAllowed'));
    return;
  }
  try {
    const instance = await resendDeviceCommand(props.deviceId, requestId);
    message.success($t('page.iot.debug.resendOk', [instance.requestId ?? requestId]));
    await loadHistory();
  } catch (error) {
    const detail = describeError(error, $t('page.iot.debug.resendFailed'));
    sendError.value = detail;
    message.error(detail.message);
  }
}

// ---------------- 回执解析 ----------------

/** 把 `replyPayload` 解析成结构化字段；非 JSON/非对象返回 `undefined`（页面回退展示原文）。 */
function replyOf(record: {
  replyPayload?: string;
}): IotCommandApi.ReplyPayload | undefined {
  const text = record.replyPayload;
  if (!text) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as IotCommandApi.ReplyPayload;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 值 → 展示文本（对象/数组用 JSON，避免 `[object Object]`）。 */
function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function prettyJson(text?: string): string {
  if (!text) {
    return '-';
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 本批高亮：最近一次下发产生的记录在列表里标出来，避免 N 条看着像孤立记录。 */
function rowClassName(record: IotCommandApi.CommandInstanceResp): string {
  return batchRequestIds.value.has(record.requestId) ? 'bg-blue-50' : '';
}

/** 本批结果汇总（成功/失败条数）。 */
const batchSummary = computed(() => {
  const failed = sendResults.value.filter((item) => item.error).length;
  return { failed, ok: sendResults.value.length - failed };
});
</script>

<template>
  <Spin :spinning="modelLoading || sending">
    <!-- 无产品 ⇒ 调试用的物模型定义不存在，必须显式说明而不是给空下拉 -->
    <Alert
      v-if="!productId"
      :message="$t('page.iot.debug.noProduct')"
      class="mb-3"
      show-icon
      type="warning"
    />
    <Alert
      v-if="modelError"
      :message="modelError"
      class="mb-3"
      show-icon
      type="error"
    />

    <!-- ===== 下发区 ===== -->
    <div class="rounded border border-solid p-3">
      <div class="mb-2 font-semibold">
        {{ $t('page.iot.debug.sendTitle') }}
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <span>{{ $t('page.iot.debug.kind') }}</span>
        <Select
          v-model:value="kind"
          style="width: 160px"
          @change="onKindChange"
        >
          <SelectOption value="property_set">
            {{ $t('page.iot.debug.kindPropertySet') }}
          </SelectOption>
          <SelectOption value="property_get">
            {{ $t('page.iot.debug.kindPropertyGet') }}
          </SelectOption>
          <SelectOption value="service_call">
            {{ $t('page.iot.debug.kindServiceCall') }}
          </SelectOption>
        </Select>

        <span class="ml-2">{{ $t('page.iot.debug.timeout') }}</span>
        <InputNumber
          :value="timeoutMs as number"
          :max="MAX_TIMEOUT_MS"
          :min="1"
          :placeholder="$t('page.iot.debug.timeoutPlaceholder')"
          style="width: 150px"
          @update:value="onTimeoutChange"
        />
      </div>
      <div class="mb-3 text-xs text-muted-foreground">
        {{ $t('page.iot.debug.timeoutHint') }}
      </div>

      <!-- 属性设置：点位 → 值（后端一条指令只接一个标识，多行会拆成多条） -->
      <template v-if="kind === 'property_set'">
        <div
          v-for="(row, index) in setRows"
          :key="row.key"
          class="mb-2 flex flex-wrap items-center gap-2"
        >
          <Select
            v-model:value="row.identifier"
            :options="setPropertyOptions"
            :placeholder="$t('page.iot.debug.propertyPlaceholder')"
            option-filter-prop="label"
            show-search
            style="width: 380px"
          />
          <Input
            v-model:value="row.value"
            :placeholder="$t('page.iot.debug.valuePlaceholder')"
            style="width: 220px"
          />
          <Button
            v-if="setRows.length > 1"
            danger
            size="small"
            @click="removeSetRow(index)"
          >
            {{ $t('page.iot.debug.removeRow') }}
          </Button>
        </div>
        <Button
          :disabled="setRows.length >= MAX_FANOUT"
          size="small"
          @click="addSetRow"
        >
          {{ $t('page.iot.debug.addRow') }}
        </Button>
        <div class="mt-1 text-xs text-muted-foreground">
          {{ $t('page.iot.debug.valueHint') }}
        </div>
        <div v-if="setRows.length > 1" class="mt-1 text-xs text-amber-600">
          {{ $t('page.iot.debug.fanoutHint', [String(MAX_FANOUT)]) }}
        </div>
      </template>

      <!-- 属性读取：可多选；留空 = 全部可读属性 -->
      <template v-else-if="kind === 'property_get'">
        <Select
          v-model:value="getSelection"
          :options="getPropertyOptions"
          :placeholder="$t('page.iot.debug.getPropertiesPlaceholder')"
          mode="multiple"
          option-filter-prop="label"
          show-search
          style="width: 100%"
        />
        <div v-if="getPropertyOptions.length === 0" class="mt-1 text-xs">
          {{ $t('page.iot.debug.noProperty') }}
        </div>
        <Alert
          :message="$t('page.iot.debug.getAllHint')"
          class="mt-2"
          show-icon
          type="info"
        />
        <div v-if="getSelection.length > 1" class="mt-1 text-xs text-amber-600">
          {{ $t('page.iot.debug.fanoutHint', [String(MAX_FANOUT)]) }}
        </div>
      </template>

      <!-- 服务调用：命令标识 + params（必须是 JSON 对象） -->
      <template v-else>
        <Select
          v-model:value="serviceIdentifier"
          :options="commandOptions"
          :placeholder="$t('page.iot.debug.servicePlaceholder')"
          option-filter-prop="label"
          show-search
          style="width: 100%"
        />
        <div v-if="commandOptions.length === 0" class="mt-1 text-xs">
          {{ $t('page.iot.debug.noCommand') }}
        </div>
        <div class="mt-2 mb-1 text-xs text-muted-foreground">
          {{ $t('page.iot.debug.params') }}
        </div>
        <Textarea
          v-model:value="paramsText"
          :placeholder="$t('page.iot.debug.paramsPlaceholder')"
          :rows="4"
          class="font-mono"
        />
        <div class="mt-1 text-xs text-muted-foreground">
          {{ $t('page.iot.debug.paramsHint') }}
        </div>
      </template>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <Button
          v-if="canSendCommand"
          :loading="sending"
          type="primary"
          @click="onSend"
        >
          {{ sending ? $t('page.iot.debug.sending') : $t('page.iot.debug.send') }}
        </Button>
        <span class="text-xs text-muted-foreground">
          {{ $t('page.iot.debug.writeDesiredHint') }}
        </span>
      </div>

      <!-- 客户端校验（warning）：与「后端失败」分开，后者一定原样展示后端 message -->
      <Alert
        v-if="formError"
        :message="formError"
        class="mt-2"
        show-icon
        type="warning"
      />

      <!-- 后端失败（error）：原样展示 message，并保留原始 code / 信封供展开查看 -->
      <Alert
        v-if="sendError"
        :message="sendError.message"
        class="mt-2"
        show-icon
        type="error"
      >
        <template #description>
          <div>
            {{ $t('page.iot.debug.rawEnvelope') }}:
            <span class="font-mono">{{ sendError.code || '-' }}</span>
          </div>
          <pre class="mt-1 text-xs break-all whitespace-pre-wrap">{{
            sendError.raw
          }}</pre>
        </template>
      </Alert>
    </div>

    <!-- ===== 本批下发结果 ===== -->
    <div v-if="sendResults.length > 0" class="mt-3 rounded border border-solid p-3">
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
      <table class="mt-2 w-full text-sm">
        <thead>
          <tr class="text-left text-gray-500">
            <th class="py-1">{{ $t('page.iot.debug.columnIdentifier') }}</th>
            <th class="py-1">{{ $t('page.iot.debug.requestId') }}</th>
            <th class="py-1">{{ $t('page.iot.debug.columnStatus') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in sendResults" :key="index" class="border-t">
            <td class="py-1">{{ item.identifier }}</td>
            <td class="py-1 font-mono">{{ item.requestId ?? '-' }}</td>
            <td class="py-1">
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
      <div class="mt-1 text-xs text-muted-foreground">
        {{ $t('page.iot.debug.batchHint') }}
      </div>
    </div>

    <!-- ===== 历史列表（需 iot:debug:get；无权限的用户看不到这一块） ===== -->
    <div v-if="canViewHistory" class="mt-4">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div class="font-semibold">
          {{ $t('page.iot.debug.historyTitle') }}
          <span class="text-xs text-muted-foreground">
            （{{ $t('page.iot.debug.historyHint') }}）
          </span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs">{{ $t('page.iot.debug.statusFilter') }}</span>
          <Select
            v-model:value="historyStatus"
            size="small"
            style="width: 140px"
            @change="onStatusFilterChange"
          >
            <SelectOption value="">
              {{ $t('page.iot.debug.allStatus') }}
            </SelectOption>
            <SelectOption v-for="item in STATUS_OPTIONS" :key="item" :value="item">
              {{ statusText(item) }}
            </SelectOption>
          </Select>
          <Button size="small" @click="loadHistory()">
            {{ $t('common.refresh') }}
          </Button>
        </div>
      </div>

      <!-- 失败态：原样展示后端 message（并可展开看原始 code/信封）——绝不画成空态 -->
      <Alert
        v-if="historyError"
        :message="historyError.message"
        show-icon
        type="error"
      >
        <template #description>
          <div>
            {{ $t('page.iot.debug.rawEnvelope') }}:
            <span class="font-mono">{{ historyError.code || '-' }}</span>
          </div>
          <pre class="mt-1 text-xs break-all whitespace-pre-wrap">{{
            historyError.raw
          }}</pre>
        </template>
      </Alert>

      <template v-else>
        <!-- 轮询失败：列表保留上一次成功结果，并如实说明「已停止自动刷新」 -->
        <Alert
          v-if="pollError"
          :message="$t('page.iot.debug.pollFailed')"
          class="mb-2"
          show-icon
          type="warning"
        >
          <template #description>
            <div>{{ pollError.message }}</div>
            <div>
              {{ $t('page.iot.debug.rawEnvelope') }}:
              <span class="font-mono">{{ pollError.code || '-' }}</span>
            </div>
            <pre class="mt-1 text-xs break-all whitespace-pre-wrap">{{
              pollError.raw
            }}</pre>
          </template>
        </Alert>

        <Table
          :columns="historyColumns"
          :data-source="history"
          :loading="historyLoading"
          :pagination="false"
          :row-class-name="rowClassName"
          row-key="id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'kind'">
              {{ kindText(record.kind) }}
            </template>
            <template v-else-if="column.key === 'identifier'">
              {{ record.identifier }}
              <Tag v-if="batchRequestIds.has(record.requestId)" color="blue">
                {{ $t('page.iot.debug.batchTag') }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'statusCode'">
              <Tag :color="statusColor(record.statusCode)">
                {{ statusText(record.statusCode) }}
              </Tag>
              <span v-if="record.errorCode" class="ml-1 text-xs text-red-600">
                {{ errorCodeText(record.errorCode) }}
              </span>
            </template>
            <template v-else-if="column.key === 'action'">
              <!-- 语义必须明确：重发的是**同一条请求**（同一 requestId），不新生成 -->
              <Popconfirm
                v-if="isResendableStatus(record.statusCode)"
                :title="
                  $t('page.iot.debug.resendConfirm', [record.requestId])
                "
                @confirm="onResend(record)"
              >
                <Button v-if="canSendCommand" size="small" type="link">
                  {{ $t('page.iot.debug.resend') }}
                </Button>
              </Popconfirm>
              <span v-else class="text-muted-foreground text-xs">
                {{ $t('page.iot.debug.resendNotAllowed') }}
              </span>
            </template>
          </template>

          <template #emptyText>
            <Empty
              v-if="historyLoaded"
              :description="$t('page.iot.debug.historyEmpty')"
            />
          </template>

          <!-- 展开：原始报文 + 回执（设备 code/message/data、设备 ts、平台 receivedAt） -->
          <template #expandedRowRender="{ record }">
            <Descriptions :column="2" bordered size="small">
              <DescriptionsItem :label="$t('page.iot.debug.requestId')">
                <span class="font-mono">{{ record.requestId }}</span>
                <Tag
                  v-if="batchRequestIds.has(record.requestId)"
                  class="ml-1"
                  color="blue"
                >
                  {{ $t('page.iot.debug.batchTag') }}
                </Tag>
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.topic')">
                {{ record.topic || '-' }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.createTime')">
                {{ record.createTime || '-' }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.sentAt')">
                {{ record.sentAt || '-' }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.finishedAt')">
                {{ record.finishedAt || '-' }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.retryCount')">
                {{ record.retryCount ?? 0 }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.errorCode')">
                <span class="font-mono">{{ record.errorCode || '-' }}</span>
                <span v-if="record.errorCode" class="ml-1">
                  {{ errorCodeText(record.errorCode) }}
                </span>
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.errorMsg')">
                {{ record.errorMsg || '-' }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.emqxMessageId')">
                {{ record.emqxMessageId || '-' }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.source')">
                {{ record.source || '-' }}
              </DescriptionsItem>
            </Descriptions>

            <!-- 回执：设备原始字段逐个列出（平台只做原样存储，不改写设备给的值） -->
            <div class="mt-2 font-semibold">
              {{ $t('page.iot.debug.replyParsed') }}
            </div>
            <Descriptions
              v-if="replyOf(record)"
              :column="2"
              bordered
              size="small"
            >
              <DescriptionsItem :label="$t('page.iot.debug.replyCode')">
                {{ displayValue(replyOf(record)?.code) }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.replyMessage')">
                {{ displayValue(replyOf(record)?.message) }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.replyData')">
                {{ displayValue(replyOf(record)?.data) }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.replyTs')">
                {{ displayValue(replyOf(record)?.ts) }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.debug.replyReceivedAt')">
                {{ displayValue(replyOf(record)?.receivedAt) }}
              </DescriptionsItem>
            </Descriptions>
            <Alert
              v-else-if="record.replyPayload"
              :message="$t('page.iot.debug.replyUnparsable')"
              show-icon
              type="info"
            />
            <div v-else class="text-xs text-muted-foreground">
              {{ $t('page.iot.debug.replyEmpty') }}
            </div>

            <div class="mt-2 font-semibold">
              {{ $t('page.iot.debug.payload') }}
            </div>
            <pre class="text-xs break-all whitespace-pre-wrap">{{
              prettyJson(record.payload)
            }}</pre>

            <div class="mt-2 font-semibold">
              {{ $t('page.iot.debug.replyPayload') }}
            </div>
            <pre class="text-xs break-all whitespace-pre-wrap">{{
              prettyJson(record.replyPayload)
            }}</pre>
          </template>
        </Table>

        <div class="mt-2 flex justify-end">
          <Pagination
            :current="historyPage"
            :page-size="HISTORY_PAGE_SIZE"
            :show-total="showTotal"
            :total="historyTotal"
            size="small"
            @change="onPageChange"
          />
        </div>
      </template>
    </div>
  </Spin>
</template>
