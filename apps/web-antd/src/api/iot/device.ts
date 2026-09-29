import { requestClient } from '#/api/request';

/**
 * IoT 设备台账 API（网关路由 /iot/**，StripPrefix=1）。
 */
export namespace IotDeviceApi {
  export interface DeviceResp {
    id: string;
    deviceCode: string;
    deviceName: string;
    protocol: string;
    endpoint: string;
    productId?: string;
    productVersion?: string;
    onlineStatus?: string;
    /**
     * 启停位：1 启用 / 0 停用（后端 `EntityStatus` 的码值）。
     *
     * ⚠️ 与 `onlineStatus` **不是一回事**：那是「设备现在连没连上」的观测值，本字段是运维意图。
     * 停用后该设备不再进入采集规格下发（后端 `DeviceSpecServiceImpl` 只取 `status=1`）⇒ 停止采集。
     * 后端可能返回 `undefined`（老数据的意外形态）⇒ 消费方按「启用」处理前必须显式判空。
     */
    status?: null | number;
    lastSeenAt?: string;
    remark?: string;
    createTime?: string;
  }

  export interface DeviceQuery {
    keyword?: string;
    page?: number;
    pageSize?: number;
    protocol?: string;
  }

  export interface DeviceSaveReq {
    deviceCode: string;
    deviceName: string;
    protocol: string;
    endpoint: string;
    productId?: string;
    productVersion?: string;
    /** 启停位：1 启用 / 0 停用；**不传表示不改**（新建由 DB 默认值 1 兜底）。 */
    status?: number;
    remark?: string;
  }

  /**
   * 一条点位最新值（后端 `LatestValueResp`，读自 Redis 最新值哈希）。
   *
   * ⚠️ 语义边界：这是「最新一条」，不是历史序列——回溯一律用历史曲线（`getDeviceSeries`）。
   * `ts` 是读数时刻的 epoch 毫秒；后端 Long 全局按字符串序列化 ⇒ 展示前需 `Number()`。
   */
  export interface LatestValueResp {
    propertyId: string;
    value?: null | string;
    quality?: null | string;
    ts?: null | number | string;
  }

  /**
   * 分页信封（后端 `PageResult`）。
   *
   * ⚠️ **计数与页码是字符串**：后端把 Long 全局序列化成字符串（`PageResult.total/page/pageSize`
   * 在服务端都是 `long`；实测响应形如 `{"total":"17","page":"1","pageSize":"10"}`）
   * ⇒ 这里按**真实返回**声明为 `number | string`，消费方负责显式转数
   * （用 `#/utils/backend-number` 的 `toBackendNumber`，**不许** `as number` 把分歧藏起来）。
   * 口径与 `api/iot/command.ts` 完全一致。
   */
  export interface PageResult<T> {
    items: T[];
    total: number | string;
    page: number | string;
    pageSize: number | string;
  }
}

/**
 * 设备名回填的批量查询口径（**不是逐行查询**）。
 *
 * 维护窗口列表返回的是裸 `deviceId`，必须换成设备名；页数上限是防失控的硬边界：
 * 单页 200 条、最多 10 页 ⇒ 最多 10 次请求（且目标 id 全部找到就提前停）。
 * 超出范围的名字保持「未解析」状态，由页面回落显示裸 ID —— 不编造名字。
 */
const DEVICE_NAME_LOOKUP_PAGE_SIZE = 200;

const DEVICE_NAME_LOOKUP_MAX_PAGES = 10;

/** 分页查询设备（服务端分页：vxe 需要 `items` + `total`）。 */
export async function getDevicePage(params: IotDeviceApi.DeviceQuery) {
  return requestClient.get<IotDeviceApi.PageResult<IotDeviceApi.DeviceResp>>(
    '/iot/devices',
    { params },
  );
}

/** 查询设备下拉（维护窗口声明用；取前 200 条）。 */
export async function getDeviceOptions(keyword?: string) {
  const result = await getDevicePage({ keyword, page: 1, pageSize: 200 });
  return result.items;
}

/**
 * 批量把设备 ID 解析成设备名（`id → 名称` 映射）。
 *
 * 空入参**短路返回空映射**（不发请求）；按页批量拉取，命中全部目标即提前结束，
 * 绝不按行发请求（N+1 会让维护窗口一屏打出几十个请求）。
 */
export async function getDeviceNameMap(ids: string[]) {
  const wanted = new Set(ids.filter((id) => !!id));
  const names: Record<string, string> = {};
  if (wanted.size === 0) {
    return names;
  }
  for (let page = 1; page <= DEVICE_NAME_LOOKUP_MAX_PAGES; page += 1) {
    const result = await getDevicePage({
      page,
      pageSize: DEVICE_NAME_LOOKUP_PAGE_SIZE,
    });
    for (const device of result.items) {
      if (wanted.has(device.id)) {
        names[device.id] = device.deviceName || device.deviceCode || device.id;
      }
    }
    if (Object.keys(names).length >= wanted.size) {
      break;
    }
    if (result.items.length < DEVICE_NAME_LOOKUP_PAGE_SIZE) {
      break;
    }
  }
  return names;
}

/** 查询某设备全部点位的最新值（后端 G1 端点；无数据或最新值存储不可用时为空数组）。 */
export async function getDeviceLatest(deviceId: string) {
  return requestClient.get<IotDeviceApi.LatestValueResp[]>(
    `/iot/devices/${deviceId}/latest`,
  );
}

export async function createDevice(data: IotDeviceApi.DeviceSaveReq) {
  return requestClient.post<number>('/iot/devices', data);
}

export async function updateDevice(
  id: string,
  data: IotDeviceApi.DeviceSaveReq,
) {
  return requestClient.put(`/iot/devices/${id}`, data);
}

/**
 * 启用/停用设备（后端 `PUT /iot/devices/{id}/status/{status}`，权限 `iot:device:update`）。
 *
 * ⚠️ 为什么走**独立端点**而不是复用 `updateDevice`：编辑端点收的是整表单（设备编码/名称/协议/端点
 * 都带 `@NotBlank`），列表里的启停开关只改一个位，回填其余字段等于「读到什么就写回什么」——
 * 一旦读到的是旧值，就会把别人刚改的名称静默覆盖掉。
 */
export async function updateDeviceStatus(id: string, status: number) {
  return requestClient.put(`/iot/devices/${id}/status/${status}`);
}

export async function deleteDevice(id: string) {
  return requestClient.delete(`/iot/devices/${id}`);
}
