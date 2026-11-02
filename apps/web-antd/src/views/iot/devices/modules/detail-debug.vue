<script lang="ts" setup>
import type { SetRow } from './use-debug-fanout';

import type { IotCommandApi, IotThingModelApi } from '#/api/iot';

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { useAccess } from '@vben/access';

import { Alert, Spin } from 'ant-design-vue';

import { listCommands, listProperties, listServices } from '#/api/iot';
import { $t } from '#/locales';

import DebugCommandForm from './debug-command-form.vue';
import DebugHistoryTable from './debug-history-table.vue';
import DebugResultPanel from './debug-result-panel.vue';
import { describeError } from './debug-status';
import { useDebugCommand } from './use-debug-command';
import { MAX_FANOUT, MAX_TIMEOUT_MS } from './use-debug-fanout';
import { useDebugHistory } from './use-debug-history';

/**
 * 「在线调试」页签：选动作 → 填参数 → 下发 → 轮询看状态与回执。
 *
 * **只用后端既有的三个端点**（`POST/GET /iot/devices/{id}/commands`、
 * `POST /iot/devices/{id}/commands/{requestId}/resend`），不为写页面新增任何后端字段。
 *
 * 结构（2026-10-20 架构审查 §2.2 拆分后）：本文件只做**装配 + 物模型加载 + 权限门禁**；
 * - 下发/校验/状态机 → `use-debug-command`（多点位拆分在 `use-debug-fanout`）
 * - 历史/轮询/重发 → `use-debug-history`
 * - 文案/错误信封/回执解析 → `debug-status`（纯函数）
 * - 三块展示 → `debug-command-form` / `debug-result-panel` / `debug-history-table`
 *
 * 三条必须守住的纪律（拆分只在搬家，**语义一字未改**）：
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
 * 「点位留空 = 读取全部可读属性」是后端既定语义，**原样支持**。
 *
 * `writeDesired`（下发同时写影子 desired）**后端已支持**（`CommandSendReq.writeDesired`：
 * 仅 `property_set` 有效，命令投递成功后才写、设备离线不写），因此本页在属性设置下提供
 * 复选框并纳入请求；不勾选就不发该字段（不写用户没要求的期望值）。
 */
const props = defineProps<{
  deviceId: string;
  productId?: string;
}>();

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
 * **机制事实（已核实上游源码，且有用例钉住）**：`packages/effects/access/src/directive.ts`
 * 里 `v-access` **只注册了 `mounted`、没有 `updated`**，且无权限时直接 `el.remove()`
 * （摘掉即不可逆）⇒ 它在**挂载那一刻**把权限判定定死：权限码此后变化不会重算，
 * 「先无权限后补权限」的区块**永远回不来**，「先有权限后撤权」的元素则**继续留在页面上**。
 * 两种方向都不会报错、也不会空白，属**静默**偏差。上游行为已由用例钉成 tripwire
 * （见 `detail-debug.test.ts` 的「权限码迟到/变化」用例组）。
 *
 * ⚠️ **但对本项目的风险定性要如实**（独立复核指出，采纳）：本应用的权限码在**路由守卫里、
 * 页面挂载之前**就写入 store —— `router/guard.ts` 会 `await fetchUserInfo()` → `generateAccess()`
 * 之后才放行导航，`store/auth.ts` 在登录收尾时 `setAccessCodes`。因此「权限码迟到」这个窗口
 * 在**正常流程中不可达**，运行期也没有重新拉取权限码的路径。所以这里**不是**在修一个已复现的
 * 线上缺陷，而是**防御性加固**：把「可见性依赖挂载时机」这一隐式前提，换成显式的响应式判定。
 *
 * **改用本写法的口径（避免「只改了两处」看起来像漏改）**：只对**区块级**（整块功能区，
 * 例如「历史记录」这一区块）使用；散落的单个操作按钮仍保留 `v-access`（摘掉一个按钮的
 * 后果是「少一个入口」，与摘掉整块功能区的后果不同级）。这是刻意划的范围，不是遗漏。
 *
 * 注意两者权限码**不同**：看历史要 `iot:debug:get`，下发/重发要 `iot:debug:send`
 * （与后端 `@SaCheckPermission` 一一对应），不能合并成一个。
 */
const { hasAccessByCodes } = useAccess();

/** 查看下发/回执记录（`GET /iot/devices/{id}/commands`）。 */
const canViewHistory = computed(() => hasAccessByCodes(['iot:debug:get']));

/** 下发与重发（`POST /iot/devices/{id}/commands[...]`）。 */
const canSendCommand = computed(() => hasAccessByCodes(['iot:debug:send']));

// ---------------- 下发 / 历史（组合式，拆分后各自单点维护） ----------------

const history = useDebugHistory({ deviceId: () => props.deviceId });

const command = useDebugCommand({
  deviceId: () => props.deviceId,
  productId: () => props.productId,
  // 下发成功后重置到第 1 页再查（新记录在最前，不重置会看不到刚发的那批）
  reloadHistory: () => history.resetAndLoad(),
});

const {
  batchRequestIds,
  batchSequence,
  batchSummary,
  formError,
  getSelection,
  kind,
  onKindChange,
  onSend,
  onTimeoutChange,
  paramsText,
  removeSetRow,
  addSetRow,
  sendError,
  sendResults,
  sending,
  serviceIdentifier,
  setRows,
  timeoutMs,
  writeDesired,
} = command;

const {
  history: historyRows,
  historyError,
  historyLoaded,
  historyLoading,
  historyPage,
  historyPageSize,
  historyStatus,
  historyTotal,
  loadHistory,
  onPageChange,
  onStatusFilterChange,
  pollError,
} = history;

/** 重发：失败详情要落进「下发失败」区（原样 message + code/信封），与下发失败同一展示口径。 */
async function onResend(record: { requestId?: string; statusCode?: string }) {
  const detail = await history.resend(record);
  if (detail) {
    sendError.value = detail;
  }
}

/** 状态筛选变化：回第 1 页并重查。 */
function onHistoryStatusChange(value: '' | IotCommandApi.CommandStatusCode) {
  historyStatus.value = value;
  onStatusFilterChange();
}

/** 属性设置行的字段更新（子组件用事件回传，避免直接改 prop 里的对象）。 */
function onRowChange(
  row: SetRow,
  field: 'identifier' | 'value',
  value: string | undefined,
) {
  if (field === 'identifier') {
    row.identifier = value;
    return;
  }
  row.value = value ?? '';
}

// ---------------- 数据加载 ----------------

/**
 * 载入该产品的物模型（点位与命令）。
 *
 * 层级与产品详情一致：**属性/命令挂在服务下** ⇒ 先取服务再逐服务取（服务数量是个位数，
 * 与设备数无关，不存在按设备循环的 N+1）。
 */
async function loadModel() {
  const productId = props.productId;
  if (!productId) {
    properties.value = [];
    commands.value = [];
    return;
  }
  modelLoading.value = true;
  modelError.value = '';
  try {
    const serviceList = (await listServices(productId)) ?? [];
    const byService = await Promise.all(
      serviceList.map(async (service) => ({
        commands: (await listCommands(productId, service.id)) ?? [],
        properties: (await listProperties(productId, service.id)) ?? [],
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

/** 打开页签/切换设备时的整体加载（下发侧复位 + 历史回到第 1 页重查 + 物模型）。 */
async function load() {
  command.reset();
  await Promise.all([loadModel(), history.resetAndLoad()]);
}

onMounted(load);

// 抽屉是复用组件：设备切换时必须重新加载（否则会把上一台设备的记录当成这台设备的）
watch(
  () => [props.deviceId, props.productId],
  () => {
    void load();
  },
);

onUnmounted(history.stopPolling);
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
    <DebugCommandForm
      :can-send-command="canSendCommand"
      :command-options="commandOptions"
      :form-error="formError"
      :get-property-options="getPropertyOptions"
      :get-selection="getSelection"
      :kind="kind"
      :max-fanout="MAX_FANOUT"
      :max-timeout-ms="MAX_TIMEOUT_MS"
      :params-text="paramsText"
      :send-error="sendError"
      :sending="sending"
      :service-identifier="serviceIdentifier"
      :set-property-options="setPropertyOptions"
      :set-rows="setRows"
      :timeout-ms="timeoutMs"
      :write-desired="writeDesired"
      @add-row="addSetRow"
      @get-selection-change="(value) => (getSelection = value)"
      @kind-change="onKindChange"
      @params-text-change="(value) => (paramsText = value)"
      @remove-row="removeSetRow"
      @send="onSend"
      @service-identifier-change="(value) => (serviceIdentifier = value)"
      @timeout-change="onTimeoutChange"
      @update-kind="(value) => (kind = value)"
      @update-row="onRowChange"
      @write-desired-change="(value) => (writeDesired = value)"
    />

    <!-- ===== 本批下发结果 ===== -->
    <DebugResultPanel
      :batch-sequence="batchSequence"
      :batch-summary="batchSummary"
      :send-results="sendResults"
    />

    <!-- ===== 历史列表（需 iot:debug:get；无权限的用户看不到这一块） ===== -->
    <DebugHistoryTable
      v-if="canViewHistory"
      :batch-request-ids="batchRequestIds"
      :can-send-command="canSendCommand"
      :history="historyRows"
      :history-error="historyError"
      :history-loaded="historyLoaded"
      :history-loading="historyLoading"
      :history-page="historyPage"
      :history-page-size="historyPageSize"
      :history-status="historyStatus"
      :history-total="historyTotal"
      :poll-error="pollError"
      @page-change="onPageChange"
      @refresh="loadHistory()"
      @resend="onResend"
      @status-change="onHistoryStatusChange"
    />
  </Spin>
</template>
