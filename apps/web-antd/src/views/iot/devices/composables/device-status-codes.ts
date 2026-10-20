/**
 * 设备启停位的码值与判据（`EntityStatus`：1 启用 / 0 停用）。
 *
 * 单独一处常量而不是散落字面量：这两个数字同时出现在「开关取值」「行是否停用」「批量启停」
 * 三处判断里，写错一处就会出现「行显示已停用、开关却是开的」这种自相矛盾的界面。
 */
import type { IotDeviceApi } from '#/api/iot';

import { toBackendNumber } from '#/utils/backend-number';

/** 启用（后端 `EntityStatus.ENABLED`）。 */
export const DEVICE_ENABLED = 1;

/** 停用（后端 `EntityStatus.DISABLED`）。 */
export const DEVICE_DISABLED = 0;

/**
 * 后端启停位按「启用」处理当且仅当它显式等于 1。
 *
 * `null/undefined` 视为启用，与 DB 默认值（建表默认 1）一致；停用是显式写入的，
 * 所以「没给值」只可能是老数据/并行开发期的不完整响应，按默认语义理解不会误导。
 */
export function isDeviceEnabled(row: IotDeviceApi.DeviceResp): boolean {
  return toBackendNumber(row.status ?? DEVICE_ENABLED) === DEVICE_ENABLED;
}
