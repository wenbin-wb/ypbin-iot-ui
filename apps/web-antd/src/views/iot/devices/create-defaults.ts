/**
 * 创建设备的**默认值闭环**纯逻辑（看板 #12「默认值闭环」）。
 *
 * 核心：设备名跟随设备编码 —— 用户只填必填的 deviceCode，deviceName 为空时自动取 deviceCode，
 * 少填一个必填项（deviceName）即闭环；用户显式填了 name 则保留（不覆盖）。
 */

/**
 * 解析最终设备名：空/空白 → 设备编码；有值 → 保留（trim 后）。
 *
 * @param deviceName 用户填的设备名（可为空）
 * @param deviceCode 设备编码（作为默认名来源）
 * @returns 最终设备名
 */
export function resolveDeviceName(
  deviceName: null | string | undefined,
  deviceCode: null | string | undefined,
): string {
  const name = (deviceName ?? '').trim();
  const code = (deviceCode ?? '').trim();
  return name || code;
}

/**
 * 创建设备请求的最终组装（deviceName 默认回填 deviceCode；其余原样）。
 */
export function buildCreateDeviceValues<
  T extends { deviceCode?: null | string; deviceName?: null | string },
>(values: T): T & { deviceName: string } {
  return {
    ...values,
    deviceName: resolveDeviceName(values.deviceName, values.deviceCode),
  };
}
