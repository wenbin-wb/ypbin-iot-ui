/**
 * 上传前解析 glTF/GLB 的**具名节点**（工单 #130 遗留项）。
 *
 * ## 为什么需要
 *
 * 后端 `iot_twin_model_asset.node_names_json` 存了「模型节点名快照」，用于
 * **按节点名预匹配**点位锚点（用户填了 `nodeName` 就能把锚点对齐到模型里对应部件）。
 * 但此前前端上传时**从不传 `nodeNames`** ⇒ 快照永远为空 ⇒ 这个能力一直是死的。
 *
 * ## 为什么用动态 import
 *
 * 本文件位于**视图层**（`views/iot/twin/`），而 `three` 必须保持「只在进场景时加载」——
 * 引擎层的 `layering-guard.test.ts` 已经钉死了这条约束。
 * 若这里静态 `import 'three'`，会把 740KB 的 three 重新拉回首屏（工单 #125 的回归）。
 * 因此解析器全部走 `await import(...)`，且**只在用户选完文件、真正上传时**才触发。
 *
 * ## 失败策略
 *
 * 解析失败**不阻断上传**：节点名只是辅助索引（后端注释也写明「不是权威数据」）。
 * 让「因为解析不了节点名就传不上模型」成为阻塞，代价远大于收益
 * （有些 .gltf 依赖外部 .bin/贴图，在浏览器里解析本来就可能失败）。
 * 失败时记 `console.warn` 留痕并返回空数组。
 */

/** 节点名长度上限（与后端 DDL `node_name VARCHAR(255)` 及 `TwinLimits` 同值）。 */
const MAX_NODE_NAME_LENGTH = 255;

/** 单次上传最多提交的节点名个数（防止超大模型把表单撑爆）。 */
const MAX_NODE_NAMES = 500;

/**
 * 从 glTF/GLB 文件解析具名节点列表（去重、过滤内部节点、按遍历顺序稳定）。
 *
 * @param file 用户选择的模型文件
 * @returns 节点名数组；解析失败时返回空数组（不抛）
 */
export async function extractNodeNames(file: File): Promise<string[]> {
  try {
    const buffer = await file.arrayBuffer();
    // 动态 import：three 与 addons 只在真正解析模型时才进内存
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');

    const loader = new GLTFLoader();
    // 自包含 GLB 传空 basePath 即可；分离资源的 .gltf 在此解析大概率失败，
    // 由下面的 catch 兜底（不阻断上传）。
    const gltf = await loader.parseAsync(buffer, '');
    const names = new Set<string>();
    (gltf.scene as InstanceType<typeof THREE.Group>).traverse((object) => {
      // 用鸭子类型判断相机/灯光（避免 instanceof 在跨 realm/mock 环境失效）
      const asAny = object as unknown as { isCamera?: boolean; isLight?: boolean };
      if (asAny.isCamera || asAny.isLight) {
        return;
      }
      const name = object.name?.trim();
      if (!name) {
        return;
      }
      // GLTFLoader 内部生成的节点常以 `_` 开头（如 `_rootJoint`），不是业务部件
      if (name.startsWith('_')) {
        return;
      }
      if (name.length > MAX_NODE_NAME_LENGTH) {
        return;
      }
      names.add(name);
    });
    return [...names].slice(0, MAX_NODE_NAMES);
  } catch (error) {
    // 不阻断上传：节点名只是辅助索引，不是权威数据
    console.warn(
      '[iot/twin] 模型节点名解析失败（不影响上传），nodeName 预匹配对本模型不可用：',
      error,
    );
    return [];
  }
}
