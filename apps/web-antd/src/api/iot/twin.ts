import { requestClient } from '#/api/request';

/**
 * IoT 数字孪生 API（后端 `IotTwin*Controller`，网关 `/iot/**` + `StripPrefix=1`）。
 *
 * 语义边界（最容易混淆的一处）：
 * - `api/iot/point.ts` 是**采集域**映射：协议地址 ↔ 物模型属性；
 * - 本文件的点位是**展示域**映射：3D 空间锚点 ↔ 设备。
 * 两者语义正交，不要混用类型。
 *
 * 全部 Long 型 ID 按字符串处理（后端 `BaseEntity` 的 `ToStringSerializer` 保证），
 * 禁止 `Number()` 转换（会丢精度）。
 */
export namespace IotTwinApi {
  /**
   * 全部硬上限（**与后端 `TwinLimits` 同值**，改一处必须同改另一处）。
   *
   * 为什么要在前端镜像一份：表单校验必须**在提交前**就给出可理解的提示，而不是让用户填完
   * 点保存再看到后端拒绝。后端仍会独立复核（防御式双保险）。与
   * `DEVICE_IMPORT_FRONTEND_LIMITS` ←→ `DeviceImportLimits` 的既有模式一致。
   */
  export const TWIN_LIMITS = {
    /** 场景树最大深度（根为第 1 层）。 */
    maxSceneDepth: 4,
    /** 场景编码长度上限。 */
    maxSceneCodeLength: 64,
    /** 场景编码允许的字符集（与后端 `TwinLimits.SCENE_CODE_PATTERN` 逐字一致）。 */
    sceneCodePattern: /^[A-Za-z0-9_-]{1,64}$/,
    /** 场景名称长度上限。 */
    maxSceneNameLength: 128,
    /** 场景备注长度上限。 */
    maxSceneRemarkLength: 500,
    /** 场景视角配置 JSON 字节上限（16 KB）。 */
    maxViewJsonBytes: 16 * 1024,
    /** 单场景点位上限。 */
    maxPointsPerScene: 500,
    /** 单点位属性绑定上限。 */
    maxBindingsPerPoint: 12,
    /** 模型节点名长度上限。 */
    maxNodeNameLength: 255,
    /** 点位图标标识长度上限。 */
    maxIconLength: 64,
    /** 点位备注长度上限。 */
    maxPointRemarkLength: 500,
    /** 单位覆盖长度上限。 */
    maxUnitLength: 32,
    /** 小数位上限。 */
    maxDecimals: 6,
    /** 模型名称长度上限。 */
    maxAssetNameLength: 128,
    /** 外链地址长度上限。 */
    maxExternalUrlLength: 1024,
    /** 模型文件字节上限（64 MB，与后端 `TwinLimits.MAX_MODEL_BYTES` 同值）。 */
    maxModelBytes: 64 * 1024 * 1024,
    /** 允许的模型扩展名。 */
    allowedModelExtensions: ['.glb', '.gltf'] as const,
  } as const;

  /** 场景类型码。 */
  export type SceneType = 'building' | 'floor' | 'park' | 'room';

  /** 展示形态码。 */
  export type DisplayType =
    | 'color'
    | 'gauge'
    | 'sparkline'
    | 'switch'
    | 'value';

  /** 展示角色码。 */
  export type DisplayRole = 'primary' | 'secondary';

  /** 模型来源类型。 */
  export type AssetType = 'external' | 'upload';

  /** 模型格式。 */
  export type ModelFormat = 'glb' | 'gltf';

  /** 场景树节点（同时用于表单与树渲染）。 */
  export interface SceneResp {
    id: string;
    sceneCode: string;
    sceneName: string;
    /** 父场景 ID；根场景为 `"0"`（不是 null，与后端一致）。 */
    parentId: string;
    /** 父场景名（后端 `@RefText("twinScene")` 派生）。根场景该字段不存在。 */
    parentIdName?: string;
    sceneType: SceneType;
    modelAssetId?: null | string;
    /** 模型资产名（`@RefText("twinModelAsset")` 派生）。 */
    modelAssetIdName?: string;
    /** BigDecimal 全局序列化为字符串，坐标计算前必须 `Number()`。 */
    anchorX: string;
    anchorY: string;
    anchorZ: string;
    anchorRx: string;
    anchorRy: string;
    anchorRz: string;
    anchorScale: string;
    viewJson?: null | string;
    sort?: number;
    pointCount?: number;
    childCount?: number;
    remark?: string;
    createTime?: string;
  }

  /** 场景新增/编辑请求。 */
  export interface SceneSaveReq {
    sceneCode: string;
    sceneName: string;
    /** 根场景传 undefined（不是 0，也不是空串）。 */
    parentId?: string;
    sceneType: SceneType;
    modelAssetId?: string;
    anchorX?: number | string;
    anchorY?: number | string;
    anchorZ?: number | string;
    anchorRx?: number | string;
    anchorRy?: number | string;
    anchorRz?: number | string;
    anchorScale?: number | string;
    viewJson?: null | string;
    sort?: number;
    remark?: string;
  }

  /** 属性绑定（响应）。 */
  export interface BindingResp {
    id: string;
    serviceIdentifier: string;
    propertyIdentifier: string;
    /** 属性主键缓存（可能悬空）。 */
    propertyId?: null | string;
    /** 属性显示名（解析不到时回落属性标识本身）。 */
    propertyName: string;
    dataType?: null | string;
    unit?: null | string;
    displayType: DisplayType;
    displayRole: DisplayRole;
    decimals?: null | number;
    unitOverride?: null | string;
    sort?: number;
    /**
     * 该绑定是否已失效（属性在物模型里已不存在）。
     *
     * 🔴 页面**必须**显著标红并提示「请重新选择属性」，不得静默隐藏或丢弃——
     * 静默丢弃会让用户以为「我明明绑过」，而实际上什么都看不见。
     */
    stale: boolean;
  }

  /** 属性绑定（请求）。 */
  export interface BindingSaveReq {
    serviceIdentifier: string;
    propertyIdentifier: string;
    displayType: DisplayType;
    displayRole?: DisplayRole;
    decimals?: null | number;
    unitOverride?: null | string;
    sort?: number;
  }

  /** 点位（响应）。 */
  export interface PointResp {
    id: string;
    sceneId: string;
    deviceId: string;
    /** 设备名（`@RefText("device")` 派生；设备已删除时不存在，页面回落显示裸 ID）。 */
    deviceIdName?: string;
    nodeName?: null | string;
    localX: string;
    localY: string;
    localZ: string;
    normalX: string;
    normalY: string;
    normalZ: string;
    icon?: null | string;
    labelVisible: boolean;
    sort?: number;
    remark?: string;
    createTime?: string;
    /** 属性绑定列表（后端保证不为 null；无绑定时为空数组）。 */
    bindings: BindingResp[];
  }

  /** 点位新增/编辑请求（编辑时**整体替换**其绑定）。 */
  export interface PointSaveReq {
    deviceId: string;
    nodeName?: null | string;
    localX: number | string;
    localY: number | string;
    localZ: number | string;
    normalX?: number | string;
    normalY?: number | string;
    normalZ?: number | string;
    icon?: null | string;
    labelVisible?: boolean;
    sort?: number;
    remark?: string;
    /** 必填（可为空数组）；传 null 是调用方漏字段，后端会拒绝。 */
    bindings: BindingSaveReq[];
  }

  /** 运行态单个属性的最新值。 */
  export interface RuntimeValueResp {
    value?: null | string;
    quality?: null | string;
    /** epoch 毫秒（后端 Long ⇒ 字符串；展示前需 `Number()`）。 */
    ts?: null | string;
    stale: boolean;
  }

  /** 运行态单个点位。 */
  export interface RuntimePointResp {
    pointId: string;
    deviceId: string;
    deviceCode?: null | string;
    deviceName?: null | string;
    /** online | offline | unknown（unknown **不代表离线**）。 */
    onlineStatus?: null | string;
    /** 启停位：1 启用 0 停用。 */
    status?: null | number;
    lastSeenAt?: null | string;
    alertCount: number;
    /** 键=属性标识；无数据时为空对象（后端保证不为 null）。 */
    values: Record<string, RuntimeValueResp>;
  }

  /** 运行态场景快照。 */
  export interface RuntimeResp {
    sceneId: string;
    /** 服务端组装时刻（**不是**「所有读数的同一时刻」）。 */
    serverTime: string;
    pointCount: number;
    truncated: boolean;
    points: RuntimePointResp[];
  }

  /** 模型资产（响应）。 */
  export interface ModelAssetResp {
    id: string;
    assetName: string;
    assetType: AssetType;
    modelFormat: ModelFormat;
    externalUrl?: null | string;
    /** 页面实际使用的模型地址（upload ⇒ 平台下载端点；external ⇒ 外链原文）。 */
    contentUrl: string;
    originalName?: null | string;
    /**
     * 文件字节数。
     *
     * ⚠️ 后端 `Long` 经全局 Jackson 配置（`ypbin.json.write-big-number-as-string=true`）
     * **序列化为字符串** ⇒ 真实返回是 `"1048576"` 而不是 `1048576`。
     * 消费方必须用 `toBackendNumber`（`#/utils/backend-number`）显式转数：
     * 直接做 `bytes > FLY_MAX_MODEL_BYTES` 会变成**字符串比较**（`"5" > "2"` 恒真），
     * 从而静默误判飞行模式是否可用。与 `api/iot/page.ts` 的 `PageResult` 同口径。
     */
    fileSize?: null | number | string;
    contentHash?: null | string;
    nodeNames: string[];
    sceneCount: number;
    createTime?: string;
  }

  /** 外链模型登记请求。 */
  export interface ModelExternalReq {
    assetName: string;
    modelFormat?: ModelFormat;
    externalUrl: string;
  }

  /** 设备可绑定的物模型属性。 */
  export interface DevicePropertyResp {
    serviceId: string;
    serviceIdentifier: string;
    serviceName: string;
    propertyId: string;
    propertyIdentifier: string;
    propertyName: string;
    dataType: string;
    accessMode: string;
    unit?: null | string;
    minValue?: null | string;
    maxValue?: null | string;
    /**
     * 该属性在本设备上是否已建立采集点位映射。
     *
     * 🔴 为 `false` 时属性**永远拿不到实时值**。配置页必须给出
     * 「该属性未配置采集点位，绑定后不会有数据」的提示——否则用户绑一堆没数据的属性，
     * 然后认为孪生功能坏了。
     */
    mapped: boolean;
  }
}

/** 查询全部场景（树形由调用方按 parentId 组装）。 */
export async function getTwinSceneList() {
  return requestClient.get<IotTwinApi.SceneResp[]>('/iot/twin/scenes');
}

/** 查询单个场景。 */
export async function getTwinScene(id: string) {
  return requestClient.get<IotTwinApi.SceneResp>(`/iot/twin/scenes/${id}`);
}

/** 新建场景（返回新场景主键）。 */
export async function createTwinScene(data: IotTwinApi.SceneSaveReq) {
  return requestClient.post<number>('/iot/twin/scenes', data);
}

/** 编辑场景。 */
export async function updateTwinScene(
  id: string,
  data: IotTwinApi.SceneSaveReq,
) {
  return requestClient.put<null>(`/iot/twin/scenes/${id}`, data);
}

/** 删除场景（有子场景或点位时后端拒绝，不级联）。 */
export async function deleteTwinScene(id: string) {
  return requestClient.delete<null>(`/iot/twin/scenes/${id}`);
}

/** 查询场景下全部点位（含绑定）。 */
export async function getTwinPointList(sceneId: string) {
  return requestClient.get<IotTwinApi.PointResp[]>(
    `/iot/twin/scenes/${sceneId}/points`,
  );
}

/** 新增点位（可同时带绑定）。 */
export async function createTwinPoint(
  sceneId: string,
  data: IotTwinApi.PointSaveReq,
) {
  return requestClient.post<number>(`/iot/twin/scenes/${sceneId}/points`, data);
}

/** 编辑点位并整体替换其绑定。 */
export async function updateTwinPoint(
  sceneId: string,
  pointId: string,
  data: IotTwinApi.PointSaveReq,
) {
  return requestClient.put<null>(
    `/iot/twin/scenes/${sceneId}/points/${pointId}`,
    data,
  );
}

/** 删除点位（连同其绑定）。 */
export async function deleteTwinPoint(sceneId: string, pointId: string) {
  return requestClient.delete<null>(
    `/iot/twin/scenes/${sceneId}/points/${pointId}`,
  );
}

/** 查询设备可绑定的物模型属性（设备未绑定产品时返回空数组）。 */
export async function getTwinDeviceProperties(deviceId: string) {
  return requestClient.get<IotTwinApi.DevicePropertyResp[]>(
    `/iot/twin/devices/${deviceId}/properties`,
  );
}

/** 查询场景运行态快照（进入场景时一次拉齐）。 */
export async function getTwinRuntime(sceneId: string) {
  return requestClient.get<IotTwinApi.RuntimeResp>(
    `/iot/twin/scenes/${sceneId}/runtime`,
  );
}

/** 查询全部模型资产（含被场景引用数）。 */
export async function getModelAssetList() {
  return requestClient.get<IotTwinApi.ModelAssetResp[]>(
    '/iot/twin/model-assets',
  );
}

/**
 * 上传模型文件。
 *
 * `nodeNames` 以**重复表单字段**形式提交（`nodeNames=a&nodeNames=b`），后端用
 * `@RequestParam List<String>` 接收。不用 JSON body 是因为文件本身必须走 multipart，
 * 混用 multipart + JSON body 需要在后端做手工解析，不值得。
 *
 * `onProgress` 用 axios 的 `onUploadProgress`：64MB 模型在慢网下需要进度反馈，
 * 否则用户会以为卡死。
 */
export async function uploadModelAsset(
  file: File,
  options?: {
    assetName?: string;
    nodeNames?: string[];
    onProgress?: (percent: number) => void;
  },
) {
  const formData = new FormData();
  formData.append('file', file);
  if (options?.assetName) {
    formData.append('assetName', options.assetName);
  }
  for (const name of options?.nodeNames ?? []) {
    formData.append('nodeNames', name);
  }
  return requestClient.post<IotTwinApi.ModelAssetResp>(
    '/iot/twin/model-assets/upload',
    formData,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (event) => {
        if (!options?.onProgress || !event.total) {
          return;
        }
        options.onProgress(Math.round((event.loaded / event.total) * 100));
      },
      // 大文件上传容易超过默认超时（默认 10s）
      timeout: 10 * 60 * 1000,
    },
  );
}

/** 登记外链模型。 */
export async function createModelAssetExternal(
  data: IotTwinApi.ModelExternalReq,
) {
  return requestClient.post<IotTwinApi.ModelAssetResp>(
    '/iot/twin/model-assets/external',
    data,
  );
}

/** 删除模型资产（被场景引用时后端拒绝）。 */
export async function deleteModelAsset(id: string) {
  return requestClient.delete<null>(`/iot/twin/model-assets/${id}`);
}

/**
 * 把后端给的模型地址拼成**绝对地址**（供 three.js 的 loader 使用）。
 *
 * 为什么需要它：`GLTFLoader` 内部走 `fetch`，不走 `requestClient` ⇒ 需要绝对地址。
 * 鉴权由 `model-loader.ts` 在读流时注入 `Authorization` 头完成（不把 token 拼进 URL：
 * 那会进浏览器历史与日志）。
 *
 * 用 `requestClient.getBaseUrl()` 而不是自己读 env：baseURL 已经过 `useAppConfig` 解析
 * （含相对/绝对两种形态），自己再拼一份必然与之漂移。
 *
 * @param contentUrl 后端返回的 `contentUrl`
 * @returns 绝对地址
 */
export function resolveModelUrl(contentUrl: string) {
  if (/^https?:\/\//i.test(contentUrl)) {
    return contentUrl;
  }
  const base = requestClient.getBaseUrl() ?? '';
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${prefix}${contentUrl.startsWith('/') ? '' : '/'}${contentUrl}`;
}
