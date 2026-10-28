import type { ErrorDetail } from './debug-status';

import type { IotCommandApi } from '#/api/iot';

import { ref } from 'vue';

import { message } from 'ant-design-vue';

import {
  getDeviceCommands,
  isResendableStatus,
  isTerminalStatus,
  resendDeviceCommand,
} from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';

import { describeError } from './debug-status';

/** 历史列表单页条数（后端单页上限 100，这里取一屏能看全的数）。 */
const HISTORY_PAGE_SIZE = 10;

/** 轮询间隔：只用轮询，**不引入 ws/SSE**。 */
const POLL_INTERVAL_MS = 2000;

interface DebugHistoryDeps {
  /** 当前设备（无设备 ⇒ 没有可查的记录）。 */
  deviceId: () => string | undefined;
}

/**
 * 「在线调试」的历史列表 + 轮询 + 重发（从 `detail-debug.vue` 拆出，2026-10-20 架构审查 §2.2）。
 *
 * 抽出的理由：轮询生命周期（起停条件、失败即停、成功后自动恢复）与三态（加载/空/失败）
 * 是这一页最容易被改坏的部分，此前和下发状态机混在 900 行脚本里。
 *
 * 三条纪律（原样保留）：
 * 1. **失败绝不画成空态**：`historyError` 非空时页面走 Alert 分支，且**清空的是列表数据**，
 *    不是把「请求失败」显示成「暂无记录」；
 * 2. **轮询失败不清空列表**：只提示「列表为上次成功结果」并**停掉轮询**——全局拦截器每次失败
 *    都会弹一次 `message.error`，2 秒一次地弹会让故障期的页面没法用；成功后自动恢复；
 * 3. **重发是「重发同一请求」**：同一 `requestId`（后端 `retry_count+1`），且只有
 *    `failed`/`timeout` 可重发（前端先禁用，后端仍会二次校验）。
 */
export function useDebugHistory({ deviceId }: DebugHistoryDeps) {
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

  /**
   * 拉取历史列表。
   *
   * `silent = true` 用于轮询：失败时**不清空**已展示记录（否则一次网络抖动会把列表擦成空态，
   * 看起来像「没有指令记录」），只把原因写进 `pollError`，并**停掉轮询**；
   * 停掉后由用户点「刷新」重试（成功即自动恢复轮询）。
   */
  async function loadHistory(options: { silent?: boolean } = {}) {
    const id = deviceId();
    if (!id) {
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
      const result = await getDeviceCommands(id, {
        page: historyPage.value,
        pageSize: HISTORY_PAGE_SIZE,
        statusCode:
          historyStatus.value === '' ? undefined : historyStatus.value,
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
    if (
      hasPending &&
      pollTimer === undefined &&
      pollError.value === undefined
    ) {
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

  /** 设备切换/页签重开：停轮询、回到第 1 页、清三态后重查。 */
  async function resetAndLoad() {
    stopPolling();
    historyPage.value = 1;
    historyLoaded.value = false;
    historyError.value = undefined;
    pollError.value = undefined;
    history.value = [];
    historyTotal.value = 0;
    await loadHistory();
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
   * 重发**同一条**指令（同一 `requestId`，后端 `retry_count+1`）。
   *
   * 参数是表格插槽给的**结构类型**行（只取需要的两个字段，不对插槽类型做强断言）。
   *
   * @returns 失败详情（调用方负责把原始 code/信封塞进「下发失败」区并展示）；
   *          成功或前置校验不通过时返回 `undefined`。
   */
  async function resend(record: {
    requestId?: string;
    statusCode?: string;
  }): Promise<ErrorDetail | undefined> {
    const requestId = record.requestId;
    if (!requestId) {
      message.warning($t('page.iot.debug.resendNotAllowed'));
      return undefined;
    }
    if (!isResendableStatus(record.statusCode)) {
      message.warning($t('page.iot.debug.resendNotAllowed'));
      return undefined;
    }
    try {
      const instance = await resendDeviceCommand(deviceId() ?? '', requestId);
      message.success(
        $t('page.iot.debug.resendOk', [instance.requestId ?? requestId]),
      );
      await loadHistory();
      return undefined;
    } catch (error) {
      const detail = describeError(error, $t('page.iot.debug.resendFailed'));
      message.error(detail.message);
      return detail;
    }
  }

  return {
    history,
    historyError,
    historyLoaded,
    historyLoading,
    historyPage,
    historyPageSize: HISTORY_PAGE_SIZE,
    historyStatus,
    historyTotal,
    loadHistory,
    onPageChange,
    onStatusFilterChange,
    pollError,
    resetAndLoad,
    resend,
    stopPolling,
  };
}
