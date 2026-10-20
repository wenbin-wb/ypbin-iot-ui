import type { RefreshGuard } from '../../shared/refresh-guard';
import type { BatchOutcome, PagerSnapshot } from '../list-actions';

/**
 * 设备台账「批量运维」组合式：勾选状态 + 批量启停/删除 + 批量标签/命令入口 + 结果播报。
 *
 * 为什么抽出来（审查 P2-7）：本页 1200 行里「批量」占了最多分支（6 个动作 × 成功/失败/部分生效），
 * 且它与 vxe 勾选强耦合、与分页（删除后页码回落）耦合。抽出来后：
 * 1. **勾选状态只有一个写入方**（本组合式的 `selectedIds`），否则「界面上看不到勾选、按钮却可用」
 *    的老 bug 会回来 —— 列表查询开始时通过 `setQueryStartHandler` 调 `resetSelectedIds()` 清空；
 * 2. 批量播报统一走后端**实际生效台数**（P1-5），不再用勾选数；
 * 3. 删除后页码回落（P1-9）与播报共用同一个 `outcome`，两处口径不会漂移。
 *
 * 不依赖 vxe 类型：宿主只注入窄能力（`readSelectedRows`/`clearGridCheckbox`/`refresh`/分页快照），
 * 组合式本身可脱离表格单测。
 */
import type { IotDeviceApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { deleteDevice } from '#/api/iot';
import { batchDeleteDevices, batchUpdateDeviceStatus } from '#/api/iot/device';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import {
  resolveBatchDisabledReason,
  resolveBatchOutcome,
  resolvePageAfterDelete,
} from '../list-actions';
import BatchCommand from '../modules/batch-command.vue';
import BatchTags from '../modules/batch-tags.vue';
import { DEVICE_ENABLED } from './device-status-codes';

export interface UseDeviceBatchOptions {
  /** 清空 vxe 勾选视觉态（ref 由本组合式维护）。 */
  clearGridCheckbox: () => void;
  /** 守卫刷新（在途时补发，而不是被 vxe 静默丢弃）。 */
  getGuard: () => RefreshGuard;
  /** 当前勾选行（批量下发命令要设备对象）。 */
  readSelectedRows: () => IotDeviceApi.DeviceResp[];
  /** 当前页可见行（删除后页码回落要按「本页还剩几行」判断）。 */
  readVisibleRows: () => IotDeviceApi.DeviceResp[];
  /** 删除前分页快照（拿不到时不做页码判断）。 */
  readPagerSnapshot: () => PagerSnapshot | undefined;
  /** 设置 vxe 当前页码。 */
  setGridCurrentPage: (page: number) => void;
}

export function useDeviceBatch(options: UseDeviceBatchOptions) {
  const [BatchTagsDrawer, BatchTagsDrawerApi] = useVbenDrawer({
    connectedComponent: BatchTags,
  });
  const [BatchCommandDrawer, BatchCommandDrawerApi] = useVbenDrawer({
    connectedComponent: BatchCommand,
  });

  /** 勾选设备的 id 列表（批量启停/删除的目标；由 vxe `checkbox-change` 同步）。 */
  const selectedIds = ref<string[]>([]);

  /** 批量请求在途：防重复提交（按钮同时进入禁用态）。 */
  const batchPending = ref(false);

  /**
   * 批量按钮的**禁用原因**（空串 = 可用）。
   *
   * 🔴 为什么要把原因分开：「未勾选」与「请求在途」在视觉上都只是一排灰按钮，
   * 用户无法判断该做什么（勾选？还是等？）。拆出原因后由模板给出 Tooltip。
   */
  const batchDisabledReason = computed(() =>
    resolveBatchDisabledReason(selectedIds.value.length, batchPending.value),
  );

  /** 批量按钮是否禁用（与 {@link batchDisabledReason} 同源，避免两处判断漂移）。 */
  const batchActionDisabled = computed(() => batchDisabledReason.value !== '');

  /** 禁用原因的人话（可用时为空串 ⇒ 不渲染 Tooltip）。 */
  const batchDisabledTooltip = computed(() => {
    switch (batchDisabledReason.value) {
      case 'noSelection': {
        return $t('page.iot.common.disabledSelectFirst');
      }
      case 'pending': {
        return $t('page.iot.common.disabledPending');
      }
      default: {
        return '';
      }
    }
  });

  /** 批量打标签/移除标签的禁用原因（只受「未勾选」影响，与批量写操作不同源）。 */
  const tagDisabledTooltip = computed(() =>
    selectedIds.value.length === 0
      ? $t('page.iot.common.disabledSelectFirst')
      : '',
  );

  /** vxe 勾选变化 → 同步批量操作的目标 id（字符串，铁律 9）。由 gridEvents.checkboxChange 调用。 */
  function onCheckboxChange(params: {
    records?: Array<{ id: number | string }>;
  }) {
    selectedIds.value = (params?.records ?? []).map((item) => String(item.id));
  }

  /** 只清 ref（列表查询开始时用：vxe 自己会重载表格，不需要再清视觉态）。 */
  function resetSelectedIds() {
    selectedIds.value = [];
  }

  /**
   * 清空勾选：既清 ref，也清 vxe 的勾选视觉态。
   *
   * 只把 `selectedIds` 置空是不够的——表格行首的复选框仍会勾着（用户会以为还会对这些行操作）。
   * `clearCheckboxRow()` 在未挂载/测试桩上可能不存在，由宿主用可选链兜底。
   */
  function clearSelection() {
    selectedIds.value = [];
    options.clearGridCheckbox();
  }

  /**
   * 删除成功后的刷新（单删与批量删共用）。
   *
   * 🔴 不能只 `query()`：vxe 只在 `initial`/`reload` 时重置页码（4.22.4 `grid.js:968`），
   * `query` **保留当前页** ⇒ 删光最后一页的最后一条后仍查 `page=N`，得到一张空表，
   * 而空态插槽会把「本页空了」说成「还没有设备」。这里先按
   * {@link resolvePageAfterDelete} 判断是否需要回退页码，再走守卫刷新。
   *
   * @param deletedCount 本次**实际生效**的删除台数（后端 `R<Integer>`）
   */
  function refreshAfterDelete(deletedCount: number) {
    const pager = options.readPagerSnapshot();
    if (pager) {
      const rows = options.readVisibleRows();
      const nextPage = resolvePageAfterDelete({
        ...pager,
        deletedCount,
        visibleCount: rows.length,
      });
      if (nextPage !== pager.currentPage) {
        options.setGridCurrentPage(nextPage);
        message.info($t('page.iot.device.pageRollbackHint'));
      }
    }
    options.getGuard().request();
  }

  /**
   * 按后端**实际生效台数**播报批量结果（审查 P1-5）。
   *
   * 为什么不能用勾选数：勾中的设备可能已被他人删除、或已处于目标状态未命中 `UPDATE`，
   * 后端 `R<Integer>` 才是真相。报「已删除 3 台」而实际只删掉 2 台，会让用户以为处理完了。
   */
  function announceBatchOutcome(outcome: BatchOutcome, fullSuccessKey: string) {
    if (outcome.level === 'none') {
      message.info($t('page.iot.device.batchNoChange'));
      return;
    }
    if (outcome.level === 'partial') {
      message.warning(
        $t('page.iot.device.batchPartialDone', [
          String(outcome.affected),
          String(outcome.notEffective),
        ]),
      );
      return;
    }
    message.success($t(fullSuccessKey, [String(outcome.affected)]));
  }

  /** 单删（行内「更多」下拉）。失败由全局拦截器提示，这里只兜底未处理拒绝。 */
  function onDelete(row: { id: string }) {
    deleteDevice(row.id)
      .then(() => {
        message.success($t('common.success'));
        // 单删同样可能删空当前页 ⇒ 走统一的「页码回落 + 守卫刷新」
        refreshAfterDelete(1);
      })
      .catch(() => {});
  }

  /**
   * 批量启用/停用（`iot:device:update`）。
   *
   * - 停用是破坏性动作（接入侧解绑、撤销点位订阅）⇒ 调用方（模板）用 Popconfirm 讲清后果；
   * - 成功：按**后端实际生效台数**播报 + 清空勾选 + 刷新列表（不能只改本地行状态）；
   * - 失败：原样展示后端 message（不静默、不假装成功），且**不清空勾选**，用户可直接重试。
   */
  async function onBatchStatus(status: number) {
    const ids = [...selectedIds.value];
    if (ids.length === 0 || batchPending.value) {
      return;
    }
    batchPending.value = true;
    try {
      const affected = await batchUpdateDeviceStatus(ids, status);
      announceBatchOutcome(
        resolveBatchOutcome(ids.length, affected),
        status === DEVICE_ENABLED
          ? 'page.iot.device.batchEnableDone'
          : 'page.iot.device.batchDisableDone',
      );
      clearSelection();
      // 启停不改行数 ⇒ 不需要页码回落，但仍走守卫（在途时补发）
      options.getGuard().request();
    } catch (error) {
      message.error(
        extractErrorMessage(error, $t('page.iot.device.batchStatusFailed')),
      );
    } finally {
      batchPending.value = false;
    }
  }

  /**
   * 批量删除（`iot:device:delete`）。
   *
   * 删除不可恢复 ⇒ 模板用 Popconfirm + danger；成功按后端实际删除台数播报 +
   * 清空勾选 + **页码回落**后刷新；失败原样展示后端 message 且保留勾选。
   */
  async function onBatchDelete() {
    const ids = [...selectedIds.value];
    if (ids.length === 0 || batchPending.value) {
      return;
    }
    batchPending.value = true;
    try {
      const affected = await batchDeleteDevices(ids);
      // 同一个 outcome 既用于播报、也用于页码回落：部分未生效时本页未必被删空，
      // 页码不能按勾选数算（两处必须同源，否则会「报 2 台却按 3 台回退」）
      const outcome = resolveBatchOutcome(ids.length, affected);
      announceBatchOutcome(outcome, 'page.iot.device.batchDeleteDone');
      clearSelection();
      refreshAfterDelete(outcome.affected);
    } catch (error) {
      message.error(
        extractErrorMessage(error, $t('page.iot.device.batchDeleteFailed')),
      );
    } finally {
      batchPending.value = false;
    }
  }

  /**
   * 打开批量标签抽屉：目标 = 当前勾选设备（字符串 id），`mode` 决定表单与接口。
   *
   * 未勾选时按钮已禁用，这里再短路一道防呆（避免程序化调用时对空清单发请求）。
   */
  function openBatchTags(mode: 'remove' | 'set') {
    if (selectedIds.value.length === 0) {
      return;
    }
    BatchTagsDrawerApi.setData({
      deviceIds: [...selectedIds.value],
      mode,
    }).open();
  }

  /** 批量标签成功：清空勾选 + 刷新列表（与批量启停/删除同口径；在途时由守卫补发）。 */
  function onBatchTagsSuccess() {
    clearSelection();
    options.getGuard().request();
  }

  /**
   * 打开批量下发命令抽屉：目标是当前勾选的设备。
   *
   * 未勾选时按钮已禁用，这里再短路一道防呆（程序化调用时不能对空清单发请求）。
   * 传的是**设备对象**（需要 deviceName/deviceCode/productId 用于弹窗展示与物模辨预判），
   * 不只是 id —— 弹窗要展示「将下发到 N 台」的清单，光有 id 只能显示数字。
   */
  function openBatchCommand() {
    const rows = options.readSelectedRows();
    const selected: IotDeviceApi.DeviceResp[] =
      rows.length > 0
        ? rows
        : // 测试桩/异常情况下退化为只有勾选 id（至少不丢目标）
          selectedIds.value.map((id) => ({ id }) as IotDeviceApi.DeviceResp);
    if (selected.length === 0) {
      return;
    }
    BatchCommandDrawerApi.setData({
      devices: selected.map((row) => ({
        deviceCode: row.deviceCode,
        deviceId: String(row.id),
        deviceName: row.deviceName,
        productId: row.productId,
      })),
    }).open();
  }

  /** 批量下发成功（**部分失败也算成功返回**，由弹窗逐台如实展示）：保留勾选，只刷新列表。 */
  function onBatchCommandSuccess() {
    options.getGuard().request();
  }

  return {
    BatchCommandDrawer,
    BatchTagsDrawer,
    batchActionDisabled,
    batchDisabledTooltip,
    onBatchCommandSuccess,
    onBatchDelete,
    onBatchStatus,
    onBatchTagsSuccess,
    onCheckboxChange,
    onDelete,
    openBatchCommand,
    openBatchTags,
    resetSelectedIds,
    selectedIds,
    tagDisabledTooltip,
  };
}
