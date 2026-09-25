import { requestClient } from '#/api/request';

/** IoT 产品与物模型 API。 */
export namespace IotProductApi {
  export interface ProductResp {
    id: string;
    productCode: string;
    productName: string;
    protocol: string;
    dataFormat?: string;
    deviceType?: string;
    manufacturerId?: string;
    manufacturerName?: string;
    modelStatus?: string;
    currentVersion?: string;
    remark?: string;
    createTime?: string;
  }

  export interface ProductQuery {
    keyword?: string;
    page?: number;
    pageSize?: number;
    protocol?: string;
    modelStatus?: string;
  }

  export interface ProductSaveReq {
    productCode: string;
    productName: string;
    protocol: string;
    dataFormat?: string;
    deviceType?: string;
    manufacturerId?: string;
    manufacturerName?: string;
    remark?: string;
  }

  /** 物模型版本（后端 `IotProductVersionResp`）。 */
  export interface ProductVersionResp {
    id: string;
    productId: string;
    versionNo: string;
    /** draft | published。 */
    modelStatus: string;
    publishedAt?: string;
    remark?: string;
    createTime?: string;
  }

  export interface PageResult<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
  }
}

/** 产品下拉一次取多少条（与 `getDeviceOptions` 同口径）。 */
const PRODUCT_OPTION_PAGE_SIZE = 200;

export async function getProductPage(params: IotProductApi.ProductQuery) {
  return requestClient.get<
    IotProductApi.PageResult<IotProductApi.ProductResp>
  >('/iot/products', { params });
}

export async function getProductOptions() {
  const result = await getProductPage({
    page: 1,
    pageSize: PRODUCT_OPTION_PAGE_SIZE,
  });
  return result.items;
}

/**
 * 设备表单里的「所属产品」下拉：**只列已发布产品**。
 *
 * 为什么只列已发布：设备要绑定物模型版本，草稿态产品的结构随时会变，
 * 绑上去的设备无从校验（`IotDeviceReq.productId` 的语义是「绑定已发布版本」）。
 * 页面必须把这条原因写在字段说明里，否则用户会以为下拉「少数据」（方案 §10 风险 R11）。
 */
export async function getPublishedProductOptions() {
  const products = await getProductOptions();
  return products.filter((product) => product.modelStatus === 'published');
}

/** 产品详情。 */
export async function getProductDetail(id: string) {
  return requestClient.get<IotProductApi.ProductResp>(`/iot/products/${id}`);
}

/** 物模型版本列表。 */
export async function getProductVersions(id: string) {
  return requestClient.get<IotProductApi.ProductVersionResp[]>(
    `/iot/products/${id}/versions`,
  );
}

/** 新建草稿（已发布产品置回可编辑态，推进下一个版本号）。 */
export async function newProductDraft(id: string) {
  return requestClient.post<string>(`/iot/products/${id}/draft`);
}

export async function createProduct(data: IotProductApi.ProductSaveReq) {
  return requestClient.post<number>('/iot/products', data);
}

export async function updateProduct(
  id: string,
  data: IotProductApi.ProductSaveReq,
) {
  return requestClient.put(`/iot/products/${id}`, data);
}

export async function deleteProduct(id: string) {
  return requestClient.delete(`/iot/products/${id}`);
}

export async function publishProduct(id: string) {
  return requestClient.post<string>(`/iot/products/${id}/publish`);
}
