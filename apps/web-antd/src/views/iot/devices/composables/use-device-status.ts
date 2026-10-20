/**
 * 设备台账「启停 + 实时状态」组合式。
 *
 * 两块职责放一起的原因：它们共同决定「这台设备现在是启用/停用、在线/实时」这一列的真实性——
 * 手动切换启停后要以后端为准重查；SSE `device-status` 事件到了也要重查；实时流鉴权失败时
 * 页面必须常驻提示（否则用户拿过期状态做处置，见审查 P1-1/2）。
 *
 * 不依赖 vxe：宿主注入 `refresh`（守卫刷新）与 `getVisibleDeviceIds`（事件命中判断）。
 */
import type { IotDeviceApi } from '#/api/iot';

import { computed, onUnmounted, ref } from 'vue';

import { message } from 'ant-design-vue';

import { updateDeviceStatus } from '#/api/iot';
import {
  createTrailingDebounce,
  deviceStatusTouchesDevices,
} from '#/api/iot/realtime';
import { handleSessionExpired } from '#/api/request';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { useIotRealtime } from '../../shared/use-iot-realtime';
import {
  DEVICE_DISABLED,
  DEVICE_ENABLED,
  isDeviceEnabled,
} from './device-status-codes';

export interface UseDeviceStatusOptions {
  /** 当前表格可见行的设备 id（实时事件命中判断）。 */
  getVisibleDeviceIds: () => string[];
  /** 守卫刷新（在途时补发，而不是被 vxe 静默丢弃）。 */
  refresh: () => void;
}

/**
 * `device-status` 实时事件的去抖窗口（800ms）。
 *
 * 启停/删除本身是低频写操作，但批量启停会一次推一条 `deviceIds`、紧接着可能还有别的写事件；
 * 800ms 合并既不会让用户觉得「状态没更新」，也不会把列表打成请求风暴。
 * 明确**不订阅** `latest`（高频读数事件），避免一屏点位上报把台账重查成轮询。
 */
const REALTIME_DEVICE_STATUS_DEBOUNCE_MS = 800;

export function useDeviceStatus(options: UseDeviceStatusOptions) {
  // ---------------------------------------------------------------- 实时状态

  /**
   * 实时鉴权失败原因（实时层在 401/403 后写入：401 ⇒ `unauthorized`，403 ⇒ `forbidden`）。
   *
   * 为什么需要它：`state === 'unauthorized'` 时实时流**不会自动重连**（401/403 重试没有意义，
   * 且会被后端当异常流量），页面若只看 `reconnecting` 就完全不提示 ⇒ 用户拿过期数据做处置。
   * 所以鉴权失败必须是一条**常驻**提示（见模板里的 Alert），并在重登后由实时层自愈。
   */
  const {
    authError: realtimeAuthError,
    error: realtimeError,
    onEvent: onRealtimeEvent,
    state: realtimeState,
  } = useIotRealtime();

  /** 断线/重连中才提示；首次 `connecting` 不闪提示（与告警中心同一口径）。 */
  const realtimeDisconnected = computed(
    () => realtimeState.value === 'reconnecting',
  );

  /** 实时鉴权失败（持续状态，必须常驻提示而不是一次性 toast）。 */
  const realtimeUnauthorized = computed(() => realtimeAuthError.value !== '');

  /**
   * 重新登录：复用全局会话过期入口（清 token + 按登录过期模式弹窗/登出），
   * 不在本页自己实现登出，避免与请求拦截器的会话语义分叉。
   *
   * 403（无实时端点权限）不给这个按钮：重新登录不会改变角色权限。
   */
  async function handleRealtimeReLogin() {
    try {
      await handleSessionExpired();
    } catch (error) {
      // 登出本身也可能失败（例如网络/存储异常）：必须给用户可见反馈，不能静默
      message.error(
        extractErrorMessage(error, $t('ui.actionMessage.operationFailed')),
      );
    }
  }

  /** 工具栏实时状态 Tag：`closed`（无 token/已释放）不渲染，避免误报「实时」。 */
  const realtimeTag = computed(() => {
    switch (realtimeState.value) {
      case 'connecting': {
        return {
          color: 'processing',
          text: $t('page.iot.realtime.connecting'),
        };
      }
      case 'live': {
        return { color: 'success', text: $t('page.iot.realtime.live') };
      }
      case 'reconnecting': {
        return {
          color: 'warning',
          text: $t('page.iot.realtime.reconnecting'),
        };
      }
      default: {
        // `closed` / `unauthorized` 等状态**不得**显示成绿色「实时连接」：
        // 那是「数据在实时更新」的承诺，此时恰恰没有实时数据（鉴权失败另有常驻 Alert）。
        return null;
      }
    }
  });

  /**
   * `device-status` → 当前页去抖刷新。
   *
   * 只对**命中当前可见行**的事件刷新（单台 deviceId / 批量 deviceIds / 删除 deviceIds 或
   * deletedIds）；无关设备的事件不产生任何请求。无设备上下文的事件按保守策略刷新一次。
   *
   * 走守卫 `request()`：实时事件常与用户操作/上一轮查询重叠，直接 `query()` 会被 vxe 静默丢弃
   * （表现为「提示已离线但列表状态没变」）。
   */
  const refreshOnDeviceStatus = createTrailingDebounce(() => {
    options.refresh();
  }, REALTIME_DEVICE_STATUS_DEBOUNCE_MS);

  onRealtimeEvent('device-status', (payload) => {
    if (deviceStatusTouchesDevices(payload, options.getVisibleDeviceIds())) {
      refreshOnDeviceStatus();
    }
  });

  // ---------------------------------------------------------------- 启停切换

  /**
   * 正在切换启停的设备 id 集合（开关的 `loading` 与防重复提交）。
   *
   * 按行记而不是一个全局布尔：并发切换两台设备时，全局布尔会让**所有**开关一起转，
   * 也会把第二台设备的点击误判成「已在提交中」而静默丢弃（点了没反应）。
   */
  const statusPending = ref<Record<string, boolean>>({});

  /**
   * 切换设备启停。
   *
   * 🔴 为什么要二次确认：停用是**破坏性**动作——接入侧会解绑该设备并撤销其全部点位订阅，
   * 采集立刻停止。确认文案必须把这个后果说清楚，而不是干巴巴一句「确定吗」。
   *
   * 失败时**不保留乐观状态**：`.finally` 里无条件重查列表，让开关回到后端的真实值；
   * 成功时也重查（不能只翻本地位，否则「停用是否真的生效」在界面上无从体现）。
   */
  function onToggleStatus(row: IotDeviceApi.DeviceResp, checked: boolean) {
    const target = checked ? DEVICE_ENABLED : DEVICE_DISABLED;
    statusPending.value = { ...statusPending.value, [row.id]: true };
    updateDeviceStatus(row.id, target)
      .then(() => {
        message.success(
          $t(
            target === DEVICE_ENABLED
              ? 'page.iot.device.statusEnableDone'
              : 'page.iot.device.statusDisableDone',
          ),
        );
      })
      .catch((error: unknown) => {
        // 原样展示后端 message：全局拦截器也会弹一次，但这里给出的是「这次切换没生效」的明确结论
        message.error(
          extractErrorMessage(error, $t('page.iot.device.statusUpdateFailed')),
        );
      })
      .finally(() => {
        // 用「删键后重新赋值」而不是 `delete`：oxlint 的 `no-dynamic-delete` 禁止对动态键做
        // delete（频繁删除会把对象推进字典模式、伤内联缓存）。这里用解构剔除该 id，
        // 语义与原写法一致（未在途的行不再有 loading 标记）。
        const { [row.id]: _removed, ...rest } = statusPending.value;
        void _removed;
        statusPending.value = rest;
        // 启停结果必须以后端为准（失败也要把开关拉回真实值）⇒ 守卫刷新
        options.refresh();
      });
  }

  onUnmounted(() => {
    refreshOnDeviceStatus.cancel();
  });

  return {
    handleRealtimeReLogin,
    isDeviceEnabled,
    onToggleStatus,
    realtimeAuthError,
    realtimeDisconnected,
    realtimeError,
    realtimeTag,
    realtimeUnauthorized,
    statusPending,
  };
}
