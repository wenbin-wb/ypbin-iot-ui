import { requestClient } from '#/api/request';

/**
 * IoT 物模型 API（后端 `IotThingModelController`，挂在产品下）。
 *
 * ⚠️ 层级必须记牢：**属性/命令/事件都挂在「服务」下**（`/services/{serviceId}/properties`），
 * 服务才挂在产品下。这与阿里云 TSL 的「平级三元」不同，是本方（IoTDA 同构）的层级，
 * 页面上因此是先选服务、再看它下面的三类元素。
 *
 * 权限码沿用产品域（后端已如此约定）：读 `iot:product:list`、写 `iot:product:update`、
 * TSL 导入导出 `iot:product:tsl-import` / `iot:product:tsl-export`。
 */
export namespace IotThingModelApi {
  export interface ServiceResp {
    id: string;
    productId: string;
    serviceId: string;
    serviceName: string;
    serviceOption: string;
    sort?: number;
    description?: string;
    createTime?: string;
  }

  export interface ServiceSaveReq {
    serviceId: string;
    serviceName: string;
    serviceOption: string;
    sort?: number;
    description?: string;
  }

  export interface PropertyResp {
    id: string;
    serviceId: string;
    identifier: string;
    propertyName: string;
    dataType: string;
    accessMode: string;
    required?: boolean;
    minValue?: string;
    maxValue?: string;
    step?: string;
    maxLength?: number;
    unit?: string;
    enumList?: string;
    defaultValue?: string;
    expand?: string;
    sort?: number;
    createTime?: string;
  }

  export interface PropertySaveReq {
    identifier: string;
    propertyName: string;
    dataType: string;
    accessMode: string;
    required?: boolean;
    minValue?: number | string;
    maxValue?: number | string;
    step?: number | string;
    maxLength?: number;
    unit?: string;
    enumList?: string;
    defaultValue?: string;
    sort?: number;
  }

  export interface CommandResp {
    id: string;
    serviceId: string;
    identifier: string;
    commandName: string;
    inputParams?: string;
    outputParams?: string;
    timeoutMs?: number;
    sort?: number;
    createTime?: string;
  }

  export interface CommandSaveReq {
    identifier: string;
    commandName: string;
    inputParams?: string;
    outputParams?: string;
    timeoutMs?: number;
    sort?: number;
  }

  export interface EventResp {
    id: string;
    serviceId: string;
    identifier: string;
    eventName: string;
    dataType: string;
    maxLength?: number;
    unit?: string;
    enumList?: string;
    sort?: number;
    createTime?: string;
  }

  export interface EventSaveReq {
    identifier: string;
    eventName: string;
    dataType: string;
    maxLength?: number;
    unit?: string;
    enumList?: string;
    sort?: number;
  }

  /** TSL 文档（导入/导出共用；结构以后端 `TslDocument` 为准）。 */
  export interface TslDocument {
    devices?: Record<string, unknown>[];
    services?: Record<string, unknown>[];
  }

  export interface TslImportResult {
    successCount: number;
    /** 逐项错误（空数组表示导入成功）。 */
    errors: string[];
  }
}

/** 数据类型（后端 `@Pattern` 白名单，9 类）。 */
export const IOT_DATA_TYPES = [
  'int',
  'long',
  'decimal',
  'string',
  'bool',
  'enum',
  'date_time',
  'json_object',
  'array',
] as const;

/** 读写权限（后端白名单）。 */
export const IOT_ACCESS_MODES = ['R', 'W', 'RW'] as const;

/** 服务选项（后端白名单；`service_option` 列名避 MySQL 保留字）。 */
export const IOT_SERVICE_OPTIONS = [
  'master',
  'mandatory',
  'optional',
] as const;

// ---------- 服务 ----------

export async function listServices(productId: string) {
  return requestClient.get<IotThingModelApi.ServiceResp[]>(
    `/iot/products/${productId}/services`,
  );
}

export async function createService(
  productId: string,
  data: IotThingModelApi.ServiceSaveReq,
) {
  return requestClient.post<number>(
    `/iot/products/${productId}/services`,
    data,
  );
}

export async function updateService(
  productId: string,
  id: string,
  data: IotThingModelApi.ServiceSaveReq,
) {
  return requestClient.put(
    `/iot/products/${productId}/services/${id}`,
    data,
  );
}

export async function deleteService(productId: string, id: string) {
  return requestClient.delete(`/iot/products/${productId}/services/${id}`);
}

// ---------- 属性 ----------

export async function listProperties(productId: string, serviceId: string) {
  return requestClient.get<IotThingModelApi.PropertyResp[]>(
    `/iot/products/${productId}/services/${serviceId}/properties`,
  );
}

export async function createProperty(
  productId: string,
  serviceId: string,
  data: IotThingModelApi.PropertySaveReq,
) {
  return requestClient.post<number>(
    `/iot/products/${productId}/services/${serviceId}/properties`,
    data,
  );
}

export async function updateProperty(
  productId: string,
  serviceId: string,
  id: string,
  data: IotThingModelApi.PropertySaveReq,
) {
  return requestClient.put(
    `/iot/products/${productId}/services/${serviceId}/properties/${id}`,
    data,
  );
}

export async function deleteProperty(
  productId: string,
  serviceId: string,
  id: string,
) {
  return requestClient.delete(
    `/iot/products/${productId}/services/${serviceId}/properties/${id}`,
  );
}

// ---------- 命令 ----------

export async function listCommands(productId: string, serviceId: string) {
  return requestClient.get<IotThingModelApi.CommandResp[]>(
    `/iot/products/${productId}/services/${serviceId}/commands`,
  );
}

export async function createCommand(
  productId: string,
  serviceId: string,
  data: IotThingModelApi.CommandSaveReq,
) {
  return requestClient.post<number>(
    `/iot/products/${productId}/services/${serviceId}/commands`,
    data,
  );
}

export async function updateCommand(
  productId: string,
  serviceId: string,
  id: string,
  data: IotThingModelApi.CommandSaveReq,
) {
  return requestClient.put(
    `/iot/products/${productId}/services/${serviceId}/commands/${id}`,
    data,
  );
}

export async function deleteCommand(
  productId: string,
  serviceId: string,
  id: string,
) {
  return requestClient.delete(
    `/iot/products/${productId}/services/${serviceId}/commands/${id}`,
  );
}

// ---------- 事件 ----------

export async function listEvents(productId: string, serviceId: string) {
  return requestClient.get<IotThingModelApi.EventResp[]>(
    `/iot/products/${productId}/services/${serviceId}/events`,
  );
}

export async function createEvent(
  productId: string,
  serviceId: string,
  data: IotThingModelApi.EventSaveReq,
) {
  return requestClient.post<number>(
    `/iot/products/${productId}/services/${serviceId}/events`,
    data,
  );
}

export async function updateEvent(
  productId: string,
  serviceId: string,
  id: string,
  data: IotThingModelApi.EventSaveReq,
) {
  return requestClient.put(
    `/iot/products/${productId}/services/${serviceId}/events/${id}`,
    data,
  );
}

export async function deleteEvent(
  productId: string,
  serviceId: string,
  id: string,
) {
  return requestClient.delete(
    `/iot/products/${productId}/services/${serviceId}/events/${id}`,
  );
}

// ---------- TSL 导入导出 ----------

/** 导出产品的 TSL 文档（平台表 → TSL JSON）。 */
export async function exportTsl(productId: string) {
  return requestClient.get<IotThingModelApi.TslDocument>(
    `/iot/products/${productId}/tsl`,
  );
}

/**
 * 导入 TSL（**全量替换当前草稿结构**；校验失败整体不落库，错误逐项返回）。
 *
 * 后端契约：`R<TslImportResult>`，成功时 `errors` 为空数组。
 */
export async function importTsl(
  productId: string,
  doc: IotThingModelApi.TslDocument,
) {
  return requestClient.post<IotThingModelApi.TslImportResult>(
    `/iot/products/${productId}/tsl`,
    doc,
  );
}
