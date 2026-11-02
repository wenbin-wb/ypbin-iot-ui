import type { ErrorDetail } from './debug-status';
import type { FanoutFormState, SetRow } from './use-debug-fanout';

import type { IotCommandApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { sendDeviceCommand } from '#/api/iot';
import { $t } from '#/locales';

import { describeError } from './debug-status';
import { buildFanoutTargets } from './use-debug-fanout';

interface DebugCommandDeps {
  /** 当前设备（无设备时组装目标直接拒绝）。 */
  deviceId: () => string | undefined;
  /** 当前产品（无产品 ⇒ 没有物模型，无法选择下发目标）。 */
  productId: () => string | undefined;
  /** 下发成功后刷新历史（**重置到第 1 页**再查，由历史模块负责）。 */
  reloadHistory: () => Promise<void>;
}

/** 本批下发结果的一行。 */
export interface SendResult {
  error?: string;
  identifier: string;
  raw?: string;
  requestId?: string;
  statusCode?: string;
}

/**
 * 「在线调试」的下发表单与状态机（从 `detail-debug.vue` 拆出，2026-10-20 架构审查 §2.2）。
 *
 * 职责边界：**只管「一条/一批指令怎么发出去、发完怎么记账」**；历史列表与轮询在
 * `use-debug-history`，目标组装（多点位拆分/校验）在 `use-debug-fanout`。
 *
 * 三条必须守住的纪律（原样保留）：
 * 1. **逐条失败不中断整批**：失败的标识与后端原文留在结果里，让用户看到「哪几条没发出去」，
 *    而不是整批报错、不知道成功了几条；
 * 2. **客户端校验与后端失败分开**：`formError`（warning）只表示「没点下去」，
 *    `sendError`（error）必须是**后端原文**（含 `code` 与原始信封，可展开）；
 * 3. **勾选才发 `writeDesired`**：不写用户没要求的期望值（后端仅 `property_set` 接受该字段）。
 */
export function useDebugCommand({
  deviceId,
  productId,
  reloadHistory,
}: DebugCommandDeps) {
  // ---------------- 下发表单 ----------------

  /** 当前动作。 */
  const kind = ref<IotCommandApi.CommandKindCode>('property_set');

  /** 超时（毫秒）；留空 = 用后端全局默认。 */
  const timeoutMs = ref<number | undefined>(undefined);

  /**
   * 是否同时写影子期望值（`CommandSendReq.writeDesired`）。
   *
   * 只对属性设置（property_set）有意义：读属性没有期望值、服务调用对应动作而非属性，
   * 后端对其它 kind 会**显式拒绝** ⇒ 复选框只在 `property_set` 下渲染。
   */
  const writeDesired = ref(false);

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

  const sending = ref(false);

  /** 最近一批的下发结果（拆分成 N 条时逐条可见，避免「一次点击 N 条孤立记录」的困惑）。 */
  const sendResults = ref<SendResult[]>([]);

  /** 最近一批产生的 `requestId`（历史列表据此高亮「这 N 条是同一批」）。 */
  const batchRequestIds = ref<Set<string>>(new Set());

  /** 批次序号（**前端本地计数、不入库**，仅用于让用户看出「是一批」）。 */
  const batchSequence = ref(0);

  /** 后端失败详情（`message` 原样 + 原始 `code`/信封可展开）。 */
  const sendError = ref<ErrorDetail | undefined>(undefined);

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

  /** 供目标组装使用的当前表单快照（避免把 ref 传进纯函数模块）。 */
  function formState(): FanoutFormState {
    return {
      getSelection: getSelection.value,
      kind: kind.value,
      paramsText: paramsText.value,
      serviceIdentifier: serviceIdentifier.value,
      setRows: setRows.value,
      timeoutMs: timeoutMs.value,
      writeDesired: writeDesired.value,
    };
  }

  /** 下发（多点位时**逐条拆分**；顺序发出，避免一次轰出几十条并发）。 */
  async function onSend() {
    formError.value = '';
    const result = buildFanoutTargets(formState(), {
      deviceId: deviceId(),
      productId: productId(),
    });
    if (!result.ok) {
      formError.value = $t(result.errorKey, result.args ?? []);
      return;
    }
    const { targets } = result;
    sending.value = true;
    sendError.value = undefined;
    sendResults.value = [];
    batchSequence.value += 1;
    const batch = new Set<string>();
    try {
      for (const target of targets) {
        try {
          const instance = await sendDeviceCommand(
            deviceId() ?? '',
            target.req,
          );
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
      await reloadHistory();
    } finally {
      sending.value = false;
    }
  }

  /** 本批结果汇总（成功/失败条数）。 */
  const batchSummary = computed(() => {
    const failed = sendResults.value.filter((item) => item.error).length;
    return { failed, ok: sendResults.value.length - failed };
  });

  /** 设备切换/页签重开时的下发侧复位（历史侧由 `use-debug-history.reset()` 负责）。 */
  function reset() {
    batchRequestIds.value = new Set();
    sendResults.value = [];
    sendError.value = undefined;
    formError.value = '';
  }

  return {
    addSetRow,
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
    reset,
    sendError,
    sendResults,
    sending,
    serviceIdentifier,
    setRows,
    timeoutMs,
    writeDesired,
  };
}
