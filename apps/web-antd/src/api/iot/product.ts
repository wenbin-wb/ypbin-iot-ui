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

  export interface PageResult<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
  }
}

export async function getProductPage(params: IotProductApi.ProductQuery) {
  return requestClient.get<
    IotProductApi.PageResult<IotProductApi.ProductResp>
  >('/iot/products', { params });
}

export async function getProductOptions() {
  const result = await getProductPage({ page: 1, pageSize: 200 });
  return result.items;
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
