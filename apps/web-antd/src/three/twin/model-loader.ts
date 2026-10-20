import type * as THREEType from 'three';

import type { TwinLoadProgress } from './types';

import { useAccessStore } from '@vben/stores';

/**
 * 模型加载器装配（GLTFLoader + Draco + KTX2 + Meshopt）。
 *
 * ## 两个必须做对的地方
 *
 * ### 1) 鉴权：自己 fetch 拿 ArrayBuffer，再 `parseAsync`
 *
 * `GLTFLoader` 内部用 `fetch`/`FileLoader` 拉模型，**不走** `requestClient` ⇒ 拿不到
 * Bearer token；而模型下载端点有 `@SaCheckPermission("iot:twin:list")`，裸请求会 401。
 * `LoadingManager.setURLModifier` 只能改 URL、改不了请求头。
 *
 * 因此本文件的策略是：**先自己 `fetch`（带 Authorization、带进度、可 abort）拿到
 * ArrayBuffer，再 `loader.parseAsync(buffer, basePath)` 只做解析**。这样请求完全由我们
 * 控制，也不影响 glTF 内部相对资源（`.bin`/贴图）通过 `basePath` 解析。
 *
 * ### 2) 压缩解码器按需装配
 *
 * - **Draco**：几何压缩（`KHR_draco_mesh_compression`）
 * - **KTX2**：纹理压缩（`KHR_texture_basisu`）
 * - **Meshopt**：网格优化（`EXT_meshopt_compression`）
 *
 * 三者都是可选的：模型没用对应扩展时不需要解码器。但**全部装上**更省心——解码器只在真正
 * 遇到对应扩展时才加载 wasm，不装则遇到扩展直接抛错（用户看到的是「模型打不开」）。
 */

/** 模型加载结果。 */
export interface LoadedModel {
  /** 场景根（调用方负责 attach/dispose）。 */
  scene: THREEType.Group;
  /** 全部具名节点名（去重、稳定顺序）。 */
  nodeNames: string[];
  /** 解析后的动画列表（本功能当前不使用，透出以便将来扩展）。 */
  animations: THREEType.AnimationClip[];
}

/** 加载选项。 */
export interface LoadModelOptions {
  /** 模型绝对地址（已由 `resolveModelUrl` 拼好）。 */
  url: string;
  /**
   * glTF 内部相对资源的基准路径（`loader.parseAsync` 的第二参数）。
   *
   * 自包含 GLB 传空串即可；**分离资源**的 `.gltf`（外链 `.bin` 与贴图）必须传
   * 「模型所在目录的绝对地址」，否则相对路径会解析到页面 URL 上而 404。
   */
  basePath?: string;
  /** 进度回调。 */
  onProgress?: (progress: TwinLoadProgress) => void;
  /** 中止信号（切换场景/离开页面时用）。 */
  signal?: AbortSignal;
  /**
   * Draco 解码器目录（指向 `draco_decoder.wasm` 所在目录）。
   *
   * 默认 `/draco/`（部署时需把 three 的 `examples/jsm/libs/draco/gltf/` 复制到前端
   * 静态目录）。若模型未用 Draco 压缩，该目录不存在也不影响加载。
   */
  dracoPath?: string;
}

/** 默认 Draco 解码器目录（随前端静态资源发布，见文档「部署注意」）。 */
const DEFAULT_DRACO_PATH = '/draco/';

/** 默认 KTX2 转码器目录。 */
const DEFAULT_KTX2_PATH = '/basis/';

/** 加载 chunk 时用的字节块大小（64KB：兼顾进度细腻度与分配次数）。 */
const DOWNLOAD_CHUNK_BYTES = 64 * 1024;

/**
 * 加载 glTF/GLB 模型。
 *
 * @param options 加载选项
 * @returns 加载结果
 * @throws Error 下载失败、解析失败、被中止（`AbortError`）
 */
export async function loadModel(
  options: LoadModelOptions,
): Promise<LoadedModel> {
  const buffer = await downloadWithAuth(options);

  // 动态 import：three 与 addons 只在真正加载模型时才进内存
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');

  const manager = new THREE.LoadingManager();
  const loader = new GLTFLoader(manager);
  await attachDraco(loader, manager, options.dracoPath);
  await attachMeshopt(loader);

  // 用 parseAsync 而不是 load：数据已在手（带鉴权下载完成），只做解析。
  // basePath 决定 glTF 内部相对资源（.bin/贴图）的解析基准，分离资源模型必传。
  const gltf = await loader.parseAsync(buffer, options.basePath ?? '');
  const scene = gltf.scene as THREEType.Group;
  return {
    animations: gltf.animations ?? [],
    nodeNames: collectNodeNames(scene),
    scene,
  };
}

/**
 * 装配 KTX2 纹理解码器（需要 renderer 提供 `detectSupport`）。
 *
 * 单独一个函数而不是塞进 `loadModel`：`setKTX2Loader` 必须在**解析之前**调用，而 KTX2
 * 探测需要 renderer ⇒ 由调用方（scene-manager）在解析前调本函数。失败不抛：
 * 未用 KTX2 的模型照常加载。
 *
 * @param loader GLTFLoader 实例
 * @param renderer WebGLRenderer 实例
 * @param transcoderPath 转码器目录
 * @returns 是否装配成功
 */
export async function attachKtx2(
  loader: {
    setKTX2Loader: (
      ktx2Loader:
        | import('three/addons/loaders/KTX2Loader.js').KTX2Loader
        | null,
    ) => void;
  },
  renderer: THREEType.WebGLRenderer,
  transcoderPath = DEFAULT_KTX2_PATH,
): Promise<boolean> {
  try {
    const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
    const ktx2Loader = new KTX2Loader();
    ktx2Loader.setTranscoderPath(transcoderPath);
    ktx2Loader.detectSupport(renderer);
    loader.setKTX2Loader(ktx2Loader);
    return true;
  } catch (error) {
    console.warn(
      '[iot/twin] KTX2 解码器装配失败，使用 KTX2 压缩纹理的模型将无法显示贴图：',
      error,
    );
    return false;
  }
}

/**
 * 装配 Draco 几何解码器。
 *
 * @param loader GLTFLoader 实例
 * @param manager LoadingManager 实例
 * @param dracoPath 解码器目录
 * @returns 是否装配成功
 */
async function attachDraco(
  // 参数类型用 DRACOLoader 的真实类型：unknown/any 都会因方法参数逆变而不兼容。
  loader: {
    setDRACOLoader: (
      dracoLoader:
        | import('three/addons/loaders/DRACOLoader.js').DRACOLoader
        | null,
    ) => void;
  },
  manager: THREEType.LoadingManager,
  dracoPath?: string,
): Promise<boolean> {
  try {
    const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
    const dracoLoader = new DRACOLoader(manager);
    dracoLoader.setDecoderPath(dracoPath ?? DEFAULT_DRACO_PATH);
    loader.setDRACOLoader(dracoLoader);
    return true;
  } catch (error) {
    // 解码器文件缺失不应让**未压缩**模型加载失败：留痕后继续
    console.warn(
      '[iot/twin] Draco 解码器装配失败，使用 Draco 压缩的模型将无法加载：',
      error,
    );
    return false;
  }
}

/**
 * 装配 Meshopt 解码器（纯 JS，随 three 包提供，无额外资源依赖）。
 *
 * @param loader GLTFLoader 实例
 * @returns 是否装配成功
 */
async function attachMeshopt(loader: {
  setMeshoptDecoder: (
    decoder: typeof import('three/addons/libs/meshopt_decoder.module.js').MeshoptDecoder,
  ) => void;
}): Promise<boolean> {
  try {
    const { MeshoptDecoder } =
      await import('three/addons/libs/meshopt_decoder.module.js');
    loader.setMeshoptDecoder(MeshoptDecoder);
    return true;
  } catch (error) {
    console.warn(
      '[iot/twin] Meshopt 解码器装配失败，使用 meshopt 压缩的模型将无法加载：',
      error,
    );
    return false;
  }
}

/**
 * 带 Bearer 鉴权下载模型字节，并上报进度。
 *
 * 用 `response.body` 的 reader 分块读并累加字节来算进度：`content-length` 只给总量，
 * 已读量必须自己数。
 *
 * @param options 加载选项
 * @returns 完整字节
 */
async function downloadWithAuth(
  options: LoadModelOptions,
): Promise<ArrayBuffer> {
  const headers: Record<string, string> = {};
  const accessStore = useAccessStore();
  if (accessStore.accessToken) {
    headers.Authorization = `Bearer ${accessStore.accessToken}`;
  }

  const response = await fetch(options.url, {
    headers,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `模型下载失败：HTTP ${response.status} ${response.statusText}`,
    );
  }
  const total = Number(response.headers.get('content-length') ?? 0);
  const body = response.body;
  if (!body) {
    // 没有流（极旧浏览器/被代理剥离）：退化为一次性读取，进度直接到 100
    const buffer = await response.arrayBuffer();
    options.onProgress?.({
      loaded: buffer.byteLength,
      percent: 100,
      total: buffer.byteLength,
    });
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.byteLength;
    options.onProgress?.({
      loaded,
      percent:
        total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : -1,
      total,
    });
    // 让出一帧：64MB 模型在慢网下若不让出，主线程会被读循环占满（相机拖不动）
    if (loaded % (DOWNLOAD_CHUNK_BYTES * 16) === 0) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    }
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

/**
 * 遍历场景提取全部具名节点名（去重、按遍历顺序稳定）。
 *
 * 为什么排除相机/灯光：它们对「设备锚点预匹配」没有价值，留着会让下拉候选里混入
 * `DirectionalLight`/`Camera001` 这类噪音。
 *
 * @param root 场景根
 * @returns 节点名列表
 */
function collectNodeNames(root: THREEType.Object3D): string[] {
  const names = new Set<string>();
  root.traverse((object) => {
    if (!object.name) {
      return;
    }
    // three.js 内部节点命名以这些前缀开头的（如 GLTFLoader 建的 `_rootJoint`）不是业务节点
    if (object.name.startsWith('_')) {
      return;
    }
    if ((object as THREEType.Camera).isCamera) {
      return;
    }
    if ((object as THREEType.Light).isLight) {
      return;
    }
    names.add(object.name);
  });
  return [...names];
}
