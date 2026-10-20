import { computed, onUnmounted } from 'vue';

import { message } from 'ant-design-vue';

import { createTrailingDebounce } from '#/api/iot/realtime';
import { handleSessionExpired } from '#/api/request';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { useIotRealtime } from '../shared/use-iot-realtime';

/** alert 事件去抖窗口：一次批量确认/恢复会连发多条，合并成一次刷新。 */
const REALTIME_ALERT_DEBOUNCE_MS = 500;

/**
 * 告警中心的实时流接线（连接状态提示 + 鉴权失败常驻提示 + alert 事件去抖刷新）。
 *
 * 从 `index.vue` 拆出的原因（拆分批次 5-D）：这几个 computed 与文案全部来自
 * `shared/use-iot-realtime` 的四个返回字段，与页面业务状态无关；放在页面里会让
 * 「数据刷新」与「连接健康」两件事混在同一段脚本。
 *
 * 三条纪律（拆分类改动不改行为）：
 * 1. **断线必须可见**：`reconnecting` 才提示（首次 connecting 不闪提示）；
 * 2. **鉴权失败是持续状态**，不是一次性事件 ⇒ 常驻 Alert（401 给「重新登录」，403 只说明）；
 * 3. **不自动登出**（避免「登出 → 重订阅 → 再 401」循环），重新登录复用全局会话语义。
 *
 * @param onAlert 收到 SSE `alert` 事件后的刷新入口（由页面注入，保持「刷新只有一条路径」）
 */
export function useAlertRealtime(onAlert: () => void) {
  const {
    authError: realtimeAuthError,
    error: realtimeError,
    onEvent: onRealtimeEvent,
    state: realtimeState,
  } = useIotRealtime();

  /** 断线/重连中才提示；首次 `connecting` 不闪提示。 */
  const realtimeDisconnected = computed(
    () => realtimeState.value === 'reconnecting',
  );

  /**
   * 实时流鉴权失败：401 ⇒ `unauthorized`（会话可能过期，给「重新登录」入口）；
   * 403 ⇒ `forbidden`（角色无实时端点权限，重新登录也没有用，只给说明）。
   *
   * 为什么常驻而不是 toast：鉴权失败意味着「页面数据不再实时」，是持续状态而不是一次性事件，
   * 用户中途回到页面/切回标签页时仍必须看到。
   */
  const realtimeUnavailable = computed(() => realtimeAuthError.value !== '');

  /**
   * 重新登录：复用全局会话过期入口（清 token + 按登录过期模式弹窗/登出），
   * 不在本页自己实现登出，避免与请求拦截器的会话语义分叉。
   */
  async function reLogin() {
    try {
      await handleSessionExpired();
    } catch (error) {
      // 登出本身也可能失败（例如网络/存储异常）：必须给用户可见反馈，不能静默
      message.error(
        extractErrorMessage(error, $t('ui.actionMessage.operationFailed')),
      );
    }
  }

  /**
   * SSE `alert` 事件 → 去抖刷新**列表 + 摘要**。
   *
   * 去抖原因：一次批量确认/静默/恢复会向同一租户连发多条 alert，逐条刷新会把
   * `/alerts/page` 与 `/alerts/summary` 打成请求风暴；500ms 内合并为一次，
   * 语义仍是「最终一致」。刷新走页面注入的既有链路，不改丢弃/重发语义。
   */
  const refreshOnAlert = createTrailingDebounce(() => {
    onAlert();
  }, REALTIME_ALERT_DEBOUNCE_MS);

  onRealtimeEvent('alert', () => {
    refreshOnAlert();
  });

  onUnmounted(() => {
    refreshOnAlert.cancel();
  });

  return {
    realtimeAuthError,
    realtimeDisconnected,
    realtimeError,
    realtimeUnavailable,
    reLogin,
  };
}
