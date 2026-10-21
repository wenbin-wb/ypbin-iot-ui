/**
 * 「点击锚点 → 设备详情」的深链构造（工单 #127）。
 *
 * ## 为什么要单独成模块而不是内联拼字符串
 *
 * 设备详情的 URL 形态是**全站约定**，不是孪生页的私有知识。目前仓内约定是：
 * 设备台账页通过 `?deviceId=` 打开详情抽屉（见
 * `views/iot/devices/composables/use-device-drawers.ts:109` 读 `route.query.deviceId`，
 * `:165` 用 `router.push({ path, query: { deviceId } })` 跳转）。
 *
 * 孪生页必须**复用同一约定**，否则会出现「从孪生页点进去打不开」或
 * 「两处链接格式不一致」的割裂。把构造逻辑收口到这里，将来设备详情路由变形态时
 * 只需改一处（并由单测钉住约定本身）。
 */

/** 设备台账页路由（设备详情抽屉由 `?deviceId=` 驱动）。 */
export const DEVICE_LEDGER_PATH = '/iot/devices';

/** 设备详情深链的目标形态。 */
export interface DeviceDetailTarget {
  /** 路由 path。 */
  path: string;
  /** 路由 query（`deviceId` 为字符串，与既有约定一致）。 */
  query: { deviceId: string };
}

/**
 * 构造设备详情深链。
 *
 * @param deviceId 设备主键（可为空：点位对应设备可能已被删除）
 * @returns 路由目标；`deviceId` 为空时返回 `undefined`（调用方据此提示，不跳转）
 */
export function buildDeviceDetailTarget(
  deviceId?: null | string,
): DeviceDetailTarget | undefined {
  if (!deviceId || deviceId.trim() === '') {
    // 设备已被删除 / 数据缺失：**不**构造一个会跳到空详情页的链接
    return undefined;
  }
  return {
    path: DEVICE_LEDGER_PATH,
    query: { deviceId: deviceId.trim() },
  };
}
