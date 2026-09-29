import { requestClient } from '#/api/request';

/**
 * IoT 设备批量导入（CSV）+ 批次管理 API（看板 #7）。
 *
 * 网关路由 `/iot/**`（StripPrefix=1），服务内路径是 `/devices/import`。
 *
 * 四个函数对应**用户的四步闭环**：下载模板 → 上传 → 看结果 → 拿走失败行。
 * 页面不做任何「前端拼 CSV」的活：失败行由后端端点生成（分页场景下前端只加载了当前页，
 * 自己拼会漏掉没加载到的失败行 —— 那是「以为改完这些就好了」的静默错误）。
 */
export namespace IotDeviceImportApi {
  /**
   * 批次状态码（后端 `DeviceImportStatus` 的 code）。
   *
   * ⚠️ 三态而非两态：批量导入的常态恰恰是「一部分成功、一部分失败」；
   * 压成成功/失败二选一会让页面无法回答「我到底进去了几台」。
   */
  export type BatchStatus = 'failed' | 'partial-failed' | 'running' | 'success';

  /** 单行结果码（后端 `DeviceImportRowResult` 的 code）。 */
  export type RowResult = 'failed' | 'success';

  /** 批次头（后端 `DeviceImportBatchResp`；计数字段是 int，不是 Long ⇒ 不是字符串）。 */
  export interface BatchResp {
    id: string;
    fileName?: string;
    totalRows?: number;
    successRows?: number;
    failedRows?: number;
    batchStatus?: BatchStatus | string;
    /** 错误摘要（面向用户的一句话；全部成功时为空）。 */
    errorSummary?: null | string;
    startTime?: string;
    endTime?: string;
    operatorUserId?: string;
    createTime?: string;
  }

  /** 逐行明细（后端 `DeviceImportRowResp`）。 */
  export interface RowResp {
    id: string;
    rowNo: number;
    rawLine?: string;
    rowResult?: RowResult | string;
    /** 错误码（成功行为空）。 */
    errorCode?: null | string;
    /** 面向用户的错误信息（成功行为空）。 */
    errorMessage?: null | string;
    deviceId?: null | string;
    deviceCode?: null | string;
  }

  /**
   * 分页信封（后端 `PageResult`）。
   *
   * ⚠️ 与 `IotDeviceApi.PageResult` 同一口径：`total/page/pageSize` 是 `long`，
   * 后端全局序列化成**字符串** ⇒ 这里按真实返回声明为 `number | string`，
   * 消费方用 `toBackendNumber` 显式转数（不许 `as number` 把分歧藏起来）。
   */
  export interface PageResult<T> {
    items: T[];
    total: number | string;
    page: number | string;
    pageSize: number | string;
  }

  /** 批次详情 = 批次头 + 该批次某一页明细（一次请求一份快照，避免「头已显示、明细还空」的中间态）。 */
  export interface BatchDetailResp {
    batch: BatchResp;
    rows: PageResult<RowResp>;
  }

  /** 明细查询（按结果筛选 + 分页）。 */
  export interface RowQuery {
    page?: number;
    pageSize?: number;
    /** 结果筛选：success / failed；不传表示全部。 */
    rowResult?: RowResult;
  }
}

/** 上传前端**先做**的校验（与后端同一批常量口径，见下方常量说明）。 */
export const DEVICE_IMPORT_FRONTEND_LIMITS = {
  /** 单次导入的数据行上限（后端 `DeviceImportLimits.MAX_ROWS`）。 */
  maxRows: 10_000,
  /** 文件字节上限（后端 `DeviceImportLimits.MAX_FILE_BYTES` = 2MB）。 */
  maxBytes: 2 * 1024 * 1024,
  /** 允许的扩展名（后端按内容解析，这里只挡明显传错文件的场景）。 */
  allowedExtensions: ['.csv', '.txt'] as const,
} as const;

/**
 * 上传 CSV 并执行批量导入（权限 `iot:device:import`）。
 *
 * ⚠️ 后端**恒返回 HTTP 200 + 批次信息**（即使整个文件被拒）：这是一条业务结论而不是请求错误。
 * 页面因此必须把返回值当作**批次记录**展示，而不是靠 catch 分支处理。
 *
 * @param file CSV 文件
 */
export async function importDevicesCsv(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return requestClient.post<IotDeviceImportApi.BatchResp>(
    '/iot/devices/import',
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  );
}

/**
 * 分页查询导入批次（最近在前）。
 *
 * @param page     页码
 * @param pageSize 每页条数
 */
export async function getDeviceImportBatchPage(page = 1, pageSize = 10) {
  return requestClient.get<
    IotDeviceImportApi.PageResult<IotDeviceImportApi.BatchResp>
  >('/iot/devices/import', { params: { page, pageSize } });
}

/**
 * 查询批次详情（批次头 + 分页明细，可按结果筛选）。
 *
 * @param batchId 批次 ID
 * @param query   明细筛选/分页
 */
export async function getDeviceImportBatchDetail(
  batchId: string,
  query: IotDeviceImportApi.RowQuery = {},
) {
  return requestClient.get<IotDeviceImportApi.BatchDetailResp>(
    `/iot/devices/import/${batchId}`,
    { params: query },
  );
}

/**
 * 下载 CSV 模板（含表头 + 说明行 + 示例行）。
 *
 * 用 `requestClient.download` 而非 `get + responseType:'blob'`：后者走实例默认的
 * `responseReturn:'data'`，默认响应拦截器会去读响应体的 `code` 字段，而下载端点返回的是
 * **裸 CSV 字节**（没有 `{code,data}` 包装）⇒ 拦截器读不到 code 会抛错。
 * `download` 内部传 `responseReturn:'body'`，拦截器直接返回 Blob、不判 code。
 * 与 `api/system/license.ts` 的下载口径完全一致。
 */
export async function downloadDeviceImportTemplate() {
  return requestClient.download<Blob>('/iot/devices/import/template');
}

/**
 * 下载某批次的失败行 CSV（含 errorCode/errorMessage 两列，改完可原样重传）。
 *
 * @param batchId 批次 ID
 */
export async function downloadDeviceImportFailedCsv(batchId: string) {
  return requestClient.download<Blob>(
    `/iot/devices/import/${batchId}/failed.csv`,
  );
}
