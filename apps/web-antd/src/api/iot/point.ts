import { requestClient } from '#/api/request';

/**
 * IoT 点位映射 API（后端 /iot/devices/{deviceId}/points，iot:point:list/create/update/delete）。
 *
 * 点位映射是**设备级**配置（产品侧只有属性定义）：属性来自产品物模型（只读），
 * 地址/周期/缩放是每台设备自己的（views/iot/devices/modules/detail-points.vue 的左右并排即此意）。
 */
export namespace IotPointApi {
  export interface PointMappingResp {
    id: string;
    deviceId: string;
    /** 关联属性（或命令）ID —— 与产品物模型的属性/命令 ID 对齐。 */
    propertyId: string;
    /** 关联类型：property | command。 */
    refType: string;
    rawAddress: string;
    /** 地址类型：holding|input|coil|discrete|nodeid|topic。 */
    addressType: string;
    pollIntervalMs?: number;
    /** BigDecimal 全局序列化为字符串。 */
    scaleFactor?: string;
    /** BigDecimal 全局序列化为字符串。 */
    offsetValue?: string;
    /**
     * 字序（word order）：`big` = 高字在前（ABCD）；`little` = 低字在前（CDAB）。
     * 仅 Modbus 寄存器点位（addressType 为 holding|input）且 `wordCount = 2` 时有意义，可空。
     */
    byteOrder?: string;
    /**
     * 寄存器宽度（Modbus 寄存器点位）：1 = 16 位（单寄存器）；2 = 32 位（双寄存器）。
     * 后端默认 1；coil/discrete/nodeid/topic 等非寄存器点位不适用。
     */
    wordCount?: number;
    /**
     * 数值符号（Modbus 寄存器点位）：`true` = 有符号；`false` = 无符号（默认）。
     * 与同 DTO 的 `enabled` 一致按 Boolean 处理（DB 列 TINYINT 0/1）。
     */
    signed?: boolean;
    /**
     * 寄存器值形态（Modbus 寄存器解码，仅 holding|input）：
     * - `int`（默认）：整数，等价 v1 —— wordCount 1|2 + signed + 字序；
     * - `float`：IEEE754 **单精度**浮点（4 字节），固定占 2 个寄存器；**不发 signed**；
     *   字序生效（little = 低字在前 CDAB，即 2 寄存器整体翻转）；
     * - `double`（v4）：IEEE754 **双精度**（8 字节），固定占 4 个寄存器；**不发 signed**；
     *   字序生效（little = 低字在前 DCBA，即 4 寄存器整体翻转）；不支持 BADC/CDAB 中间排列；
     * - `bits`：单寄存器内位域，固定 1 个寄存器；**不发 signed / 字序**；必填 bitOffset + bitLength；
     * - `string`（v3）：多寄存器拼**固定 UTF-8**（序列号/设备 ID 等）；wordCount 语义变为
     *   **寄存器个数 1..32**；**不发 signed / 字序 / 位域**。
     */
    registerFormat?: 'bits' | 'double' | 'float' | 'int' | 'string';
    /** 位域起始位（仅 registerFormat=bits，0..15）。 */
    bitOffset?: number;
    /** 位域位宽（仅 registerFormat=bits，≥1 且 bitOffset + bitLength ≤ 16）。 */
    bitLength?: number;
    /** 读写：R|W|RW（与属性 accessMode 联动校验）。 */
    rw: string;
    enabled?: boolean;
    createTime?: string;
  }

  /**
   * 创建/更新请求（后端 IotPointMappingReq 校验约束）：
   * propertyId @NotNull；refType/addressType/rawAddress/rw @NotBlank；
   * rawAddress @Size(max=128)；pollIntervalMs @Min(0)；scaleFactor/offsetValue/byteOrder/enabled 可空。
   *
   * Modbus 寄存器解码 v1（仅 addressType 为 holding|input 有意义）：
   * wordCount 1|2（默认 1）；signed boolean（默认 false = 无符号）；
   * byteOrder big|little（默认不发送）——语义是**字序**（big=高字在前 ABCD / little=低字在前 CDAB），
   * 不是 BADC/DCBA 字节交换。
   * Modbus 寄存器解码「寄存器值形态」：
   * registerFormat `int`（默认）| `float` | `double` | `bits` | `string`；
   * - float：wordCount 固定 2（IEEE754 **单精度**）、signed 不发（后端要求 false）、字序生效；
   * - double（v4）：wordCount 固定 4（IEEE754 **双精度**）、signed 不发、字序生效
   *   （little = DCBA，4 寄存器整体翻转）；
   * - bits：wordCount 固定 1、signed/字序不发、必填 bitOffset(0..15) + bitLength(≥1 且和 ≤16)；
   * - string（v3）：wordCount 语义为**寄存器个数 1..32**，固定 UTF-8 解码；
   *   只下发 registerFormat + wordCount（signed / 字序 / 位域一律不发）；
   * 各形态只对 holding|input 下发，其它地址类型一律不带。
   * 仍不支持编码选择、BADC·CDAB（字内字节交换）与寄存器倒序。
   */
  export interface PointMappingSaveReq {
    deviceId?: string;
    propertyId: string;
    refType: string;
    rawAddress: string;
    addressType: string;
    pollIntervalMs?: number;
    scaleFactor?: string;
    offsetValue?: string;
    byteOrder?: string;
    /** Modbus 寄存器宽度：1 = 16 位；2 = 32 位（默认 1）。仅 holding|input 有意义。 */
    wordCount?: number;
    /** Modbus 数值符号：`true` = 有符号；`false` = 无符号（默认）。仅 holding|input 有意义。 */
    signed?: boolean;
    /**
     * 寄存器值形态：int（默认）| float（IEEE754 单精度，固定 2 寄存器）
     * | double（IEEE754 双精度，固定 4 寄存器）| bits（单寄存器位域）
     * | string（多寄存器拼 **固定 UTF-8**，wordCount = 寄存器个数 1..32）。仅 holding|input 有意义。
     */
    registerFormat?: 'bits' | 'double' | 'float' | 'int' | 'string';
    /** 位域起始位（仅 bits，0..15）。 */
    bitOffset?: number;
    /** 位域位宽（仅 bits，≥1 且 bitOffset + bitLength ≤ 16）。 */
    bitLength?: number;
    rw: string;
    enabled?: boolean;
  }
}

/** 查询某设备的点位映射列表（无数据为空数组）。 */
export async function getDevicePoints(deviceId: string) {
  return requestClient.get<IotPointApi.PointMappingResp[]>(
    `/iot/devices/${deviceId}/points`,
  );
}

/** 新增点位映射（返回新记录 id）。 */
export async function createDevicePoint(
  deviceId: string,
  data: IotPointApi.PointMappingSaveReq,
) {
  return requestClient.post<number>(`/iot/devices/${deviceId}/points`, data);
}

/** 更新点位映射。 */
export async function updateDevicePoint(
  deviceId: string,
  id: string,
  data: IotPointApi.PointMappingSaveReq,
) {
  return requestClient.put<null>(`/iot/devices/${deviceId}/points/${id}`, data);
}

/** 删除点位映射。 */
export async function deleteDevicePoint(deviceId: string, id: string) {
  return requestClient.delete<null>(`/iot/devices/${deviceId}/points/${id}`);
}
