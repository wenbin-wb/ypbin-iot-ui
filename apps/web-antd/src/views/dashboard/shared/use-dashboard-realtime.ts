import { onScopeDispose } from 'vue';

import { useIotRealtime } from '../../iot/shared/use-iot-realtime';

/**
 * 仪表盘/工作台的实时刷新接线。
 *
 * - 复用 `useIotRealtime` 的模块级单例 SSE（一个标签页一条连接）；
 * - `latest` / `device-status` / `alert` 任一事件触发 `reload`，并用 trailing 去抖合并
 *   （MQTT 高频上报时不会把总览接口打爆）；
 * - 组件卸载时清掉定时器并退订；连接失败由页面根据 `state/error` 渲染可见提示；
 * - **鉴权失败原样透出**（`authError`）：SSE 走 Bearer 鉴权，token 过期后流会 401/403，
 *   这类失败的重连解决不了问题 —— 页面必须让用户看见并重新登录，
 *   否则页面会停在「上一次的数据」上装作一切正常。
 *
 * `authError` 的取值/语义完全沿用实时层（`use-iot-realtime.ts`：
 * 空串=无鉴权问题，401→`unauthorized`，403→`forbidden`），本文件只做透传，不重复定义。
 *
 * @param reload 重新拉取总览的函数（通常是 useIotOverview().load）
 * @param delayMs 去抖窗口（默认 1200ms）
 */
export function useDashboardRealtime(reload: () => void, delayMs = 1200) {
  const { authError, error, onEvent, state } = useIotRealtime();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule() {
    if (timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      reload();
    }, delayMs);
  }

  onEvent('alert', schedule);
  onEvent('device-status', schedule);
  onEvent('latest', schedule);

  onScopeDispose(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  });

  return { authError, error, state };
}
