<script lang="ts" setup>
import type {
  BatchIdentifierOption,
  BatchProductModel,
  BatchResultRow,
  BatchResultSummary,
  CommandParamDef,
} from './batch-command-state';

import type { IotCommandApi } from '#/api/iot';

import { computed, nextTick, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  InputNumber,
  message,
  Popconfirm,
  Select,
  SelectOption,
  Spin,
  Switch,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  listCommands,
  listProperties,
  listServices,
  resendDeviceCommand,
  sendBatchDeviceCommands,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';
import { downloadByBlob } from '#/utils/file';

import CopyText from '../../shared/copy-text.vue';
import { displayOrFallback } from '../../shared/display';
import {
  batchCountsConsistent,
  batchDeliveryReasonKey,
  batchRejectReasonKey,
  buildBatchIdentifierOptions,
  buildBatchResultCsv,
  buildBatchResultCsvRows,
  buildBatchResultRows,
  canResendBatchItem,
  collectServiceParams,
  countUnsupportedDevices,
  normalizeBatchDeviceIds,
  paramControlOf,
  parseBatchValue,
  parseCommandParamDefs,
  parseParamsObject,
  summarizeBatchResults,
} from './batch-command-state';

/**
 * 设备台账「批量下发命令」抽屉（**面向小白也要能用**）。
 *
 * 后端契约：`POST /iot/devices/commands/batch`（权限 `iot:debug:send`），
 * 请求是**一个命令模板 + 多台设备**，响应逐设备结果。三条硬纪律：
 *
 * 1. **目标标识必须从物模型下拉选**（属性/命令），不让人手打标识——手打拼写错误会让几十台设备
 *    一起报 COMMAND_REJECTED，而用户根本不知道是自己打错了；
 * 2. **结果三态如实展示**（本任务重点）：已送达 / 已提交未送达（可重发）/ 未受理（code+message）。
 *    `accepted=true, ok=false` **绝不画成成功**——设备离线是"平台收了、设备没收到"，
 *    与"平台拒绝"要修的东西完全不同；
 * 3. **客户端失败与服务端失败分开**：客户端校验（未选标识/参数非法）用 warning，服务端失败
 *    原样展示后端 message（error），不混成一个提示。
 *
 * 批量**明确拒绝停用设备**（`DEVICE_DISABLED`，单台端点不拒）⇒ 该条提示「请先在设备台账启用」。
 */
interface BatchCommandData {
  devices: {
    deviceCode?: string;
    deviceId: string;
    deviceName?: string;
    productId?: string;
  }[];
}

const emit = defineEmits<{
  (e: 'success', summary: BatchResultSummary): void;
}>();

/** 后端单批设备数上限默认值（`ypbin.emqx.command-batch.max-devices`，nacos 可调），前端先拦一道。 */
const DEFAULT_MAX_DEVICES = 50;

/** 批量下拉里最多列多少个目标标识（物模型很大时避免一次渲染几千项）。 */
const MAX_IDENTIFIER_OPTIONS = 500;

const KIND_OPTIONS: { label: string; value: IotCommandApi.CommandKindCode }[] =
  [
    {
      label: $t('page.iot.device.batchCommand.kindPropertySet'),
      value: 'property_set',
    },
    {
      label: $t('page.iot.device.batchCommand.kindPropertyGet'),
      value: 'property_get',
    },
    { label: $t('page.iot.debug.kindServiceCall'), value: 'service_call' },
  ];

const kind = ref<IotCommandApi.CommandKindCode>('property_set');
const identifier = ref<string | undefined>(undefined);
const valueText = ref('');
const paramsText = ref('');
const timeoutMs = ref<number | undefined>(undefined);
const writeDesired = ref(false);
const clientRequestId = ref('');

const devices = ref<BatchCommandData['devices']>([]);
const showDeviceList = ref(false);

const models = ref<BatchProductModel[]>([]);
const modelLoading = ref(false);
const modelError = ref('');

const submitting = ref(false);
const formError = ref('');
const submitError = ref('');

const resultRows = ref<BatchResultRow[]>([]);
const resultSummary = ref<BatchResultSummary | undefined>(undefined);
/** 后端计数与逐条结果不一致时的提示（**不照抄一个对不上的数字**）。 */
const countMismatch = ref(false);
const resendingId = ref('');

const serviceParams = ref<Record<string, any>>({});

let submittingFlag = false;

/** 选中设备的物模型（去重后的 productId）。 */
const productIds = computed(() => [
  ...new Set(devices.value.map((item) => item.productId).filter(Boolean)),
]);

const deviceIdList = computed(() =>
  normalizeBatchDeviceIds(devices.value.map((item) => item.deviceId)),
);

const overLimit = computed(
  () => deviceIdList.value.length > DEFAULT_MAX_DEVICES,
);

/** 目标标识候选（**只列该动作合法的目标**：设置只列可写属性、读取只列可读属性、服务只列命令）。 */
const identifierOptions = computed(() =>
  buildBatchIdentifierOptions(models.value, kind.value).slice(
    0,
    MAX_IDENTIFIER_OPTIONS,
  ),
);

const selectedOption = computed<BatchIdentifierOption | undefined>(() =>
  identifierOptions.value.find((item) => item.value === identifier.value),
);

/** 选中设备里「物模型没有该标识」的台数（确认前就告诉用户会有一部分被逐台拒绝）。 */
const unsupportedCount = computed(() =>
  countUnsupportedDevices(selectedOption.value, devices.value),
);

/** 服务调用的入参定义（从所选命令的 inputParams 解析；解析不出则回落 JSON 文本框）。 */
const serviceParamDefs = computed<CommandParamDef[]>(() => {
  const found = models.value
    .flatMap((model) => model.commands ?? [])
    .find((command) => command.identifier === identifier.value);
  return parseCommandParamDefs(found?.inputParams);
});

/** 设备名/编码查找（结果表展示用；缺失回落 id，不编造名字）。 */
function labelOf(deviceId: string) {
  const found = devices.value.find((item) => item.deviceId === deviceId);
  return { code: found?.deviceCode, name: found?.deviceName };
}

/**
 * 一次性装载选中设备涉及的物模型（按 productId 去重后取服务 → 属性/命令）。
 *
 * 层级与产品详情一致：属性/命令挂在**服务**下。服务数量是个位数、与设备数无关，
 * 因此这里不是 N+1（按产品数循环，不是按设备数）。
 */
async function loadModels() {
  const ids = productIds.value.filter(
    (productId): productId is string =>
      typeof productId === 'string' && productId !== '',
  );
  if (ids.length === 0) {
    models.value = [];
    return;
  }
  modelLoading.value = true;
  modelError.value = '';
  try {
    const loaded = await Promise.all(
      ids.map(async (productId) => {
        const serviceList = (await listServices(productId)) ?? [];
        const byService = await Promise.all(
          serviceList.map(async (service) => ({
            commands: (await listCommands(productId, service.id)) ?? [],
            properties: (await listProperties(productId, service.id)) ?? [],
          })),
        );
        return {
          commands: byService.flatMap((item) => item.commands),
          productId,
          properties: byService.flatMap((item) => item.properties),
        };
      }),
    );
    models.value = loaded as BatchProductModel[];
  } catch (error) {
    models.value = [];
    modelError.value = extractErrorMessage(
      error,
      $t('page.iot.device.batchCommand.modelLoadFailed'),
    );
  } finally {
    modelLoading.value = false;
  }
}

/** 切换动作类型：目标标识与参数都要重选（不同类型合法标识不同，残留会发错东西）。 */
function onKindChange() {
  identifier.value = undefined;
  valueText.value = '';
  paramsText.value = '';
  serviceParams.value = {};
  formError.value = '';
}

function onIdentifierChange() {
  valueText.value = '';
  paramsText.value = '';
  serviceParams.value = {};
  formError.value = '';
}

// ---------------------------------------------------------------- 校验与提交

/** 组装请求模板；返回 undefined 表示客户端校验未通过（原因写进 formError）。 */
function buildTemplate():
  | undefined
  | { clientRequestId?: string; command: IotCommandApi.CommandSendReq } {
  const template: IotCommandApi.CommandSendReq = { kind: kind.value };
  if (timeoutMs.value !== undefined && Number.isFinite(timeoutMs.value)) {
    template.timeoutMs = timeoutMs.value;
  }
  if (kind.value === 'property_get') {
    // 空标识 = 全部可读属性（后端既定语义）；有标识则只读该属性
    if (identifier.value) {
      template.identifier = identifier.value;
    }
  } else {
    if (!identifier.value) {
      formError.value =
        kind.value === 'property_set'
          ? $t('page.iot.device.batchCommand.noProperty')
          : $t('page.iot.device.batchCommand.noCommand');
      return undefined;
    }
    template.identifier = identifier.value;
  }
  if (kind.value === 'property_set') {
    template.params = { value: parseBatchValue(valueText.value) };
  } else if (kind.value === 'service_call') {
    if (serviceParamDefs.value.length > 0) {
      const collected = collectServiceParams(
        serviceParamDefs.value,
        serviceParams.value,
      );
      if (!collected.ok) {
        formError.value =
          collected.missing.length > 0
            ? $t('page.iot.device.batchCommand.paramsRequired', [
                collected.missing.join('、'),
              ])
            : $t('page.iot.device.batchCommand.paramsWrongType', [
                collected.wrongType.join('、'),
              ]);
        return undefined;
      }
      template.params = collected.params;
    } else {
      const parsed = parseParamsObject(paramsText.value);
      if (!parsed.ok) {
        formError.value = $t('page.iot.device.batchCommand.paramsInvalid');
        return undefined;
      }
      template.params = parsed.value;
    }
  }
  const request: {
    clientRequestId?: string;
    command: IotCommandApi.CommandSendReq;
  } = { command: template };
  const key = clientRequestId.value.trim();
  if (key !== '') {
    request.clientRequestId = key;
  }
  return request;
}

/** 一段人话复述：把「要发生什么」在点下去之前说清楚。 */
const confirmSentence = computed(() => {
  const count = devices.value.length;
  if (kind.value === 'property_set') {
    return $t('page.iot.device.batchCommand.confirmSet', [
      displayOrFallback(identifier.value),
      displayOrFallback(valueText.value),
      String(count),
    ]);
  }
  if (kind.value === 'property_get') {
    return identifier.value
      ? $t('page.iot.device.batchCommand.confirmGetOne', [
          identifier.value,
          String(count),
        ])
      : $t('page.iot.device.batchCommand.confirmGetAll', [String(count)]);
  }
  return $t('page.iot.device.batchCommand.confirmCall', [
    displayOrFallback(identifier.value),
    String(count),
  ]);
});

/** 提交批量下发。部分失败**不抛错也不提示成功**，只如实展示逐台结果。 */
async function onSubmit() {
  formError.value = '';
  submitError.value = '';
  if (submittingFlag) {
    return;
  }
  if (deviceIdList.value.length === 0) {
    formError.value = $t('page.iot.device.batchCommand.noDevice');
    return;
  }
  if (overLimit.value) {
    formError.value = $t('page.iot.device.batchCommand.overLimit', [
      String(DEFAULT_MAX_DEVICES),
    ]);
    return;
  }
  const template = buildTemplate();
  if (!template) {
    return;
  }
  // deviceIds 显式转 number：后端是 List<Long>，且要求安全整数（超出则精度已丢，宁可不发）
  const numericIds: number[] = [];
  for (const id of deviceIdList.value) {
    const parsed = Number(id);
    if (!Number.isSafeInteger(parsed)) {
      formError.value = $t('page.iot.device.batchCommand.deviceIdInvalid', [
        id,
      ]);
      return;
    }
    numericIds.push(parsed);
  }

  submittingFlag = true;
  submitting.value = true;
  resultRows.value = [];
  resultSummary.value = undefined;
  countMismatch.value = false;
  try {
    const resp = await sendBatchDeviceCommands({
      command: template.command,
      deviceIds: numericIds,
      ...(template.clientRequestId === undefined
        ? {}
        : { clientRequestId: template.clientRequestId }),
    });
    const items = resp?.results ?? [];
    const summary = summarizeBatchResults(items);
    resultRows.value = buildBatchResultRows(items, labelOf);
    resultSummary.value = summary;
    countMismatch.value = !batchCountsConsistent(resp ?? {}, summary);
    emit('success', summary);
  } catch (error) {
    // 整批级失败（请求本身不成立）：原样展示后端 message；**此前的结果不假装成功**
    submitError.value = extractErrorMessage(
      error,
      $t('page.iot.device.batchCommand.submitFailed'),
    );
  } finally {
    submittingFlag = false;
    submitting.value = false;
  }
}

/** 单台重发（复用单台重发端点；同一 requestId，不新生成）。 */
async function onResend(row: BatchResultRow) {
  if (!row.requestId || resendingId.value !== '') {
    return;
  }
  resendingId.value = row.deviceId;
  try {
    const instance = await resendDeviceCommand(row.deviceId, row.requestId);
    message.success(
      $t('page.iot.device.batchCommand.resendOk', [
        instance?.requestId ?? row.requestId,
      ]),
    );
    // 重发只改这一台的状态：就地更新该行，不动其它已如实展示的结果
    resultRows.value = resultRows.value.map((item) =>
      item.deviceId === row.deviceId
        ? {
            ...item,
            accepted: true,
            errorCode: instance?.errorCode ?? '',
            message:
              instance?.errorCode === undefined || instance?.errorCode === ''
                ? $t('page.iot.device.batchCommand.resendDone')
                : (instance?.errorMsg ?? item.message),
            requestId: instance?.requestId ?? item.requestId,
            state:
              instance?.statusCode === 'sent'
                ? ('delivered' as const)
                : ('accepted-not-delivered' as const),
            statusCode: instance?.statusCode ?? item.statusCode,
          }
        : item,
    );
  } catch (error) {
    message.error(
      extractErrorMessage(
        error,
        $t('page.iot.device.batchCommand.resendFailed'),
      ),
    );
  } finally {
    resendingId.value = '';
  }
}

// ---------------------------------------------------------------- 结果展示

const RESULT_COLUMNS = computed(() => [
  { key: 'device', title: $t('page.iot.device.batchCommand.colDevice') },
  {
    key: 'state',
    title: $t('page.iot.device.batchCommand.colState'),
    width: 200,
  },
  { key: 'requestId', title: $t('page.iot.debug.requestId'), width: 220 },
  { key: 'reason', title: $t('page.iot.device.batchCommand.colReason') },
  { key: 'action', title: $t('common.action'), width: 110 },
]);

/** antd Table 的插槽 record 是 Record<string, any>：显式收窄成结果行，避免 any 扩散。 */
function asRow(record: Record<string, any>): BatchResultRow {
  return record as BatchResultRow;
}

/** 三态 → 文案（**三态各自独立**，accepted=true/ok=false 绝不与成功共用文案）。 */
function stateText(state: BatchResultRow['state']): string {
  switch (state) {
    case 'accepted-not-delivered': {
      return $t('page.iot.device.batchCommand.stateNotDelivered');
    }
    case 'delivered': {
      return $t('page.iot.device.batchCommand.stateDelivered');
    }
    default: {
      return $t('page.iot.device.batchCommand.stateRejected');
    }
  }
}

function stateColor(state: BatchResultRow['state']): string {
  switch (state) {
    case 'accepted-not-delivered': {
      return 'warning';
    }
    case 'delivered': {
      return 'success';
    }
    default: {
      return 'error';
    }
  }
}

/**
 * 一行的人话原因（三态各自的口径）：
 * - 未受理：优先用码翻译（DEVICE_DISABLED 要指引「去设备台账启用」），**未知码原样展示**，
 *   并始终附上后端 message（后端已写好的人话）；
 * - 已提交未送达：errorCode 翻译（NO_SUBSCRIBER = 设备离线）+ 后端 message；
 * - 已送达：后端 message。
 */
function reasonText(row: BatchResultRow): string {
  if (row.state === 'rejected') {
    const key = batchRejectReasonKey(row.code);
    const translated = key === '' ? '' : $t(key);
    const codeText = row.code === '' ? '' : `[${row.code}]`;
    return [codeText, translated, row.message]
      .filter((item) => item !== '')
      .join(' ');
  }
  const deliveryKey = batchDeliveryReasonKey(row.errorCode);
  const deliveryText = deliveryKey === '' ? '' : $t(deliveryKey);
  const codeText = row.errorCode === '' ? '' : `[${row.errorCode}]`;
  return [codeText, deliveryText, row.message]
    .filter((item) => item !== '')
    .join(' ');
}

/** 未受理里"下一步怎么做"的提示（DEVICE_DISABLED 是最常见、也最容易修错方向的一类）。 */
function nextStepText(row: BatchResultRow): string {
  if (row.state !== 'rejected') {
    return '';
  }
  switch ((row.code ?? '').toUpperCase()) {
    case 'BATCH_BUDGET_EXCEEDED': {
      return $t('page.iot.device.batchCommand.nextBudget');
    }
    case 'COMMAND_REJECTED': {
      return $t('page.iot.device.batchCommand.nextRejected');
    }
    case 'DEVICE_DISABLED': {
      return $t('page.iot.device.batchCommand.nextDisabled');
    }
    case 'DEVICE_WITHOUT_PRODUCT':
    case 'THING_MODEL_EMPTY': {
      return $t('page.iot.device.batchCommand.nextThingModel');
    }
    case 'THING_MODEL_LOAD_FAILED': {
      return $t('page.iot.device.batchCommand.nextRetryLater');
    }
    default: {
      return '';
    }
  }
}

function onExportCsv() {
  if (resultRows.value.length === 0) {
    return;
  }
  const header = [
    $t('page.iot.device.batchCommand.colDevice'),
    $t('page.iot.device.batchCommand.colDeviceCode'),
    $t('page.iot.device.batchCommand.colDeviceId'),
    $t('page.iot.device.batchCommand.colState'),
    $t('page.iot.device.batchCommand.colStatusCode'),
    $t('page.iot.device.batchCommand.colErrorCode'),
    $t('page.iot.device.batchCommand.colCode'),
    $t('page.iot.device.batchCommand.colMessage'),
    $t('page.iot.debug.requestId'),
  ];
  const csv = buildBatchResultCsv(
    header,
    buildBatchResultCsvRows(resultRows.value, stateText),
  );
  // 前置 BOM：Excel 直接打开 UTF-8 CSV 时不乱码
  downloadByBlob(
    new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }),
    `batch-command-${Date.now()}.csv`,
  );
}

// ---------------------------------------------------------------- 抽屉

const [Drawer, drawerApi] = useVbenDrawer<BatchCommandData>({
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      return;
    }
    const data = drawerApi.getData();
    devices.value = data?.devices ?? [];
    kind.value = 'property_set';
    identifier.value = undefined;
    valueText.value = '';
    paramsText.value = '';
    timeoutMs.value = undefined;
    writeDesired.value = false;
    clientRequestId.value = `batch-${Date.now().toString(36)}`;
    formError.value = '';
    submitError.value = '';
    resultRows.value = [];
    resultSummary.value = undefined;
    countMismatch.value = false;
    serviceParams.value = {};
    drawerApi.setState({
      title: $t('page.iot.device.batchCommand.title', [
        String(devices.value.length),
      ]),
    });
    await nextTick();
    await loadModels();
  },
});

defineExpose({ drawerApi });
</script>

<template>
  <Drawer class="w-[min(980px,96vw)]">
    <Spin :spinning="modelLoading || submitting">
      <div class="flex flex-col gap-3">
        <Alert v-if="modelError" :message="modelError" show-icon type="error" />
        <Alert
          v-if="overLimit"
          :message="
            $t('page.iot.device.batchCommand.overLimit', [
              String(DEFAULT_MAX_DEVICES),
            ])
          "
          show-icon
          type="warning"
        />

        <!-- ===== 第 1 步：动作类型 ===== -->
        <div>
          <div class="mb-1 text-sm font-medium">
            {{ $t('page.iot.device.batchCommand.stepKind') }}
          </div>
          <Select v-model:value="kind" class="w-full" @change="onKindChange">
            <SelectOption
              v-for="item in KIND_OPTIONS"
              :key="item.value"
              :value="item.value"
            >
              {{ item.label }}
            </SelectOption>
          </Select>
        </div>

        <!-- ===== 第 2 步：目标标识（**必须从物模型下拉选**） ===== -->
        <div>
          <div class="mb-1 text-sm font-medium">
            {{ $t('page.iot.device.batchCommand.stepIdentifier') }}
          </div>
          <Select
            v-model:value="identifier"
            :options="identifierOptions"
            :placeholder="
              $t('page.iot.device.batchCommand.identifierPlaceholder')
            "
            allow-clear
            class="w-full"
            data-testid="batch-command-identifier"
            option-filter-prop="value"
            show-search
            @change="onIdentifierChange"
          />
          <div
            v-if="identifierOptions.length === 0 && !modelLoading"
            class="mt-1 text-xs text-muted-foreground"
          >
            {{ $t('page.iot.device.batchCommand.identifierEmpty') }}
          </div>
          <!-- 确认前就告诉用户会有多少台被逐台拒绝（而不是下发后才发现） -->
          <Alert
            v-if="unsupportedCount > 0"
            class="mt-2"
            :message="
              $t('page.iot.device.batchCommand.unsupportedHint', [
                String(unsupportedCount),
              ])
            "
            show-icon
            type="warning"
          />
        </div>

        <!-- ===== 第 3 步：参数（按类型给控件） ===== -->
        <div v-if="kind === 'property_set'">
          <div class="mb-1 text-sm font-medium">
            {{ $t('page.iot.device.batchCommand.value') }}
          </div>
          <Input
            v-model:value="valueText"
            :placeholder="$t('page.iot.device.batchCommand.valuePlaceholder')"
          />
          <div class="mt-1 text-xs text-muted-foreground">
            {{ $t('page.iot.debug.valueHint') }}
          </div>
        </div>

        <div v-else-if="kind === 'service_call'">
          <!-- 入参有定义 ⇒ 按物模型类型给控件；没有定义 ⇒ 回落 JSON 文本 -->
          <template v-if="serviceParamDefs.length > 0">
            <div class="mb-1 text-sm font-medium">
              {{ $t('page.iot.device.batchCommand.params') }}
            </div>
            <div
              v-for="def in serviceParamDefs"
              :key="def.identifier"
              class="mb-2 flex flex-wrap items-center gap-2"
            >
              <span class="w-40 text-sm">
                {{ def.name }}
                <span v-if="def.required" class="text-red-500">*</span>
                <span v-if="def.unit" class="text-xs text-muted-foreground">
                  （{{ def.unit }}）
                </span>
              </span>
              <Select
                v-if="paramControlOf(def) === 'select'"
                v-model:value="serviceParams[def.identifier]"
                :options="
                  def.enumList.map((item) => ({ label: item, value: item }))
                "
                class="w-60"
              />
              <Switch
                v-else-if="paramControlOf(def) === 'switch'"
                v-model:checked="serviceParams[def.identifier]"
              />
              <InputNumber
                v-else-if="paramControlOf(def) === 'number'"
                v-model:value="serviceParams[def.identifier]"
                class="w-60"
              />
              <Input
                v-else
                v-model:value="serviceParams[def.identifier]"
                class="w-60"
              />
            </div>
          </template>
          <template v-else>
            <div class="mb-1 text-sm font-medium">
              {{ $t('page.iot.debug.params') }}
            </div>
            <Input.TextArea
              v-model:value="paramsText"
              :placeholder="$t('page.iot.debug.paramsPlaceholder')"
              :rows="3"
            />
            <div class="mt-1 text-xs text-muted-foreground">
              {{ $t('page.iot.debug.paramsHint') }}
            </div>
          </template>
        </div>

        <!-- ===== 第 4 步：可选设置 ===== -->
        <div class="flex flex-wrap items-center gap-4">
          <div class="flex items-center gap-2">
            <span class="text-sm">{{ $t('page.iot.debug.timeout') }}</span>
            <InputNumber
              v-model:value="timeoutMs"
              :max="3600000"
              :min="1"
              :placeholder="$t('page.iot.debug.timeoutPlaceholder')"
              class="w-40"
            />
          </div>
          <div class="flex items-center gap-2">
            <span class="text-sm">
              {{ $t('page.iot.device.batchCommand.clientRequestId') }}
            </span>
            <Input
              v-model:value="clientRequestId"
              class="w-56"
              :placeholder="
                $t('page.iot.device.batchCommand.clientRequestIdPlaceholder')
              "
            />
          </div>
        </div>
        <!-- writeDesired 只对属性设置有效（其它类型后端显式拒绝，故只在属性设置时出现） -->
        <div v-if="kind === 'property_set'" class="flex flex-col gap-1">
          <Checkbox v-model:checked="writeDesired">
            {{ $t('page.iot.device.batchCommand.writeDesired') }}
          </Checkbox>
          <span class="text-xs text-muted-foreground">
            {{ $t('page.iot.device.batchCommand.writeDesiredHint') }}
          </span>
        </div>

        <!-- ===== 将要发生什么：台数 + 设备清单（可折叠）+ 人话复述 ===== -->
        <Alert
          :message="
            $t('page.iot.device.batchCommand.targetCount', [
              String(devices.length),
            ])
          "
          show-icon
          type="info"
        >
          <template #description>
            <div>{{ confirmSentence }}</div>
            <button
              class="mt-1 text-xs text-primary"
              type="button"
              @click="showDeviceList = !showDeviceList"
            >
              {{
                showDeviceList
                  ? $t('page.iot.device.batchCommand.hideDevices')
                  : $t('page.iot.device.batchCommand.showDevices')
              }}
            </button>
            <ul
              v-if="showDeviceList"
              class="mt-1 max-h-40 overflow-auto text-xs"
            >
              <li v-for="item in devices" :key="item.deviceId">
                {{ item.deviceName || item.deviceCode || item.deviceId }}
                <span class="text-muted-foreground">（{{ item.deviceId }}）</span>
              </li>
            </ul>
          </template>
        </Alert>

        <!-- 客户端校验（warning）：与服务端失败分开 -->
        <Alert v-if="formError" :message="formError" show-icon type="warning" />
        <!-- 服务端整批级失败（error）：原样展示后端 message -->
        <Alert
          v-if="submitError"
          :message="submitError"
          show-icon
          type="error"
        />

        <div class="flex flex-wrap items-center gap-2">
          <Button
            data-testid="batch-command-submit"
            :disabled="modelLoading || devices.length === 0"
            :loading="submitting"
            type="primary"
            @click="onSubmit"
          >
            {{ $t('page.iot.device.batchCommand.submit') }}
          </Button>
          <span class="text-xs text-muted-foreground">
            {{ $t('page.iot.device.batchCommand.submitHint') }}
          </span>
        </div>

        <!-- ===== 结果：逐设备三态（部分失败绝不显示成整体成功） ===== -->
        <div v-if="resultSummary" class="flex flex-col gap-2">
          <Alert
            :message="
              resultSummary.allDelivered
                ? $t('page.iot.device.batchCommand.resultAllDelivered', [
                    String(resultSummary.total),
                  ])
                : $t('page.iot.device.batchCommand.resultPartial', [
                    String(resultSummary.total),
                    String(resultSummary.delivered),
                    String(resultSummary.notDelivered),
                    String(resultSummary.rejected),
                  ])
            "
            :type="resultSummary.allDelivered ? 'success' : 'warning'"
            show-icon
          />
          <Alert
            v-if="countMismatch"
            :message="$t('page.iot.device.batchCommand.countMismatch')"
            show-icon
            type="warning"
          />
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">
              {{ $t('page.iot.device.batchCommand.resultTitle') }}
            </span>
            <Button
              data-testid="batch-command-export"
              size="small"
              @click="onExportCsv"
            >
              {{ $t('page.iot.device.batchCommand.exportCsv') }}
            </Button>
          </div>
          <Table
            :columns="RESULT_COLUMNS"
            :data-source="resultRows"
            :pagination="false"
            row-key="deviceId"
            :scroll="{ x: 760 }"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'device'">
                <div class="font-medium">
                  {{
                    record.deviceName || record.deviceCode || record.deviceId
                  }}
                </div>
                <div class="text-xs text-muted-foreground">
                  {{ record.deviceCode || '-' }} · {{ record.deviceId }}
                </div>
              </template>
              <template v-else-if="column.key === 'state'">
                <Tag :color="stateColor(record.state)">
                  {{ stateText(record.state) }}
                </Tag>
                <div
                  v-if="record.statusCode"
                  class="mt-1 text-xs text-muted-foreground"
                >
                  {{ record.statusCode }}
                </div>
              </template>
              <template v-else-if="column.key === 'requestId'">
                <CopyText :value="record.requestId" />
              </template>
              <template v-else-if="column.key === 'reason'">
                <div class="text-xs break-all">
                  {{ reasonText(asRow(record)) }}
                </div>
                <div
                  v-if="nextStepText(asRow(record))"
                  class="mt-1 text-xs text-muted-foreground"
                >
                  {{ nextStepText(asRow(record)) }}
                </div>
              </template>
              <template v-else-if="column.key === 'action'">
                <Popconfirm
                  v-if="canResendBatchItem(asRow(record))"
                  :title="
                    $t('page.iot.debug.resendConfirm', [record.requestId])
                  "
                  @confirm="onResend(asRow(record))"
                >
                  <Button
                    :loading="resendingId === record.deviceId"
                    size="small"
                    type="link"
                  >
                    {{ $t('page.iot.debug.resend') }}
                  </Button>
                </Popconfirm>
                <span v-else class="text-xs text-muted-foreground">-</span>
              </template>
            </template>
            <template #emptyText>
              <Empty
                :description="$t('page.iot.device.batchCommand.resultEmpty')"
              />
            </template>
          </Table>
        </div>
      </div>
    </Spin>
  </Drawer>
</template>
