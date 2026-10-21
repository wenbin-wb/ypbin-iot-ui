import type * as THREEType from 'three';

/**
 * three.js 的 **GPU 资源递归回收**（本文件是「反复切换场景不涨内存」的唯一实现点）。
 *
 * ## 为什么必须自己做
 *
 * three.js **不会**自动回收 GPU 资源：`geometry`/`material`/`texture` 创建后由 WebGL
 * 上下文持有，`scene.remove(obj)` 只断开引用，**显存不释放**。`THREE.Cache` 缓存的是
 * HTTP 响应（ArrayBuffer/JSON），**不管显存**。
 *
 * 这类数字孪生页面的典型事故是：进楼层 → 返回 → 进另一层，重复十几次后显存耗尽、
 * 页面变卡甚至标签页崩溃，而代码里没有任何报错。因此回收必须是**显式、递归、幂等**的。
 *
 * ## 口径
 *
 * - 递归遍历整棵子树（含 `SkinnedMesh` 的骨骼矩阵贴图）；
 * - 每个 `geometry`/`material`/贴图**只 dispose 一次**（用 `WeakSet` 去重：多个 mesh 常共享
 *   同一 material，重复 `dispose()` 在 three.js 里不报错但会打警告）；
 * - **不** dispose `WebGLRenderer`（长生命周期，每次切场景重建上下文极贵且易泄漏；
 *   渲染器在页面卸载时由 `TwinSceneManager#dispose` 统一释放）。
 */

/** 释放统计（供开发期内存自检与单测断言）。 */
export interface DisposeStats {
  /** 已释放的几何体数量。 */
  geometries: number;
  /** 已释放的材质数量。 */
  materials: number;
  /** 已释放的贴图数量。 */
  textures: number;
  /** 遍历到的对象数量。 */
  objects: number;
}

/**
 * 递归释放场景子树占用的 GPU 资源。
 *
 * @param root 场景根或任意子树根
 * @returns 释放统计
 */
export function disposeSubtree(root: THREEType.Object3D): DisposeStats {
  const stats: DisposeStats = {
    geometries: 0,
    materials: 0,
    objects: 0,
    textures: 0,
  };
  const disposedGeometries = new WeakSet<object>();
  const disposedMaterials = new WeakSet<object>();
  const disposedTextures = new WeakSet<object>();

  root.traverse((object) => {
    stats.objects += 1;

    // 1) 几何体
    const withGeometry = object as THREEType.Object3D & {
      geometry?: THREEType.BufferGeometry;
    };
    if (
      withGeometry.geometry &&
      !disposedGeometries.has(withGeometry.geometry)
    ) {
      disposedGeometries.add(withGeometry.geometry);
      withGeometry.geometry.dispose();
      stats.geometries += 1;
    }

    // 2) 材质（可能是单个或数组）
    const withMaterial = object as THREEType.Object3D & {
      material?: THREEType.Material | THREEType.Material[];
    };
    const materials = withMaterial.material;
    if (materials) {
      const list = Array.isArray(materials) ? materials : [materials];
      for (const material of list) {
        if (disposedMaterials.has(material)) {
          continue;
        }
        disposedMaterials.add(material);
        stats.textures += disposeMaterialTextures(material, disposedTextures);
        material.dispose();
        stats.materials += 1;
      }
    }

    // 3) 骨骼矩阵贴图（SkinnedMesh 的骨骼纹理也是显存大户）
    const withSkeleton = object as THREEType.Object3D & {
      skeleton?: THREEType.Skeleton;
    };
    if (withSkeleton.skeleton) {
      const boneTexture = (
        withSkeleton.skeleton as unknown as { boneTexture?: THREEType.Texture }
      ).boneTexture;
      if (boneTexture && !disposedTextures.has(boneTexture)) {
        disposedTextures.add(boneTexture);
        boneTexture.dispose();
        stats.textures += 1;
      }
    }
  });

  return stats;
}

/**
 * 释放材质上挂的全部贴图。
 *
 * 用「遍历自有属性、判断是不是 Texture」而不是硬编码属性名：three.js 的材质族有几十种
 * （`MeshStandardMaterial`/`MeshPhysicalMaterial`/`PointsMaterial`…），硬编码清单必然漏。
 * 识别用鸭子类型（`isTexture === true`）而不是 `instanceof`：单测里 three 可能被 mock，
 * `instanceof` 会失效。
 *
 * @param material 材质
 * @param disposed 已释放贴图去重集合（跨材质共享的贴图只释放一次）
 * @returns 本次释放的贴图数量
 */
function disposeMaterialTextures(
  material: THREEType.Material,
  disposed: WeakSet<object>,
): number {
  let count = 0;
  for (const value of Object.values(
    material as unknown as Record<string, unknown>,
  )) {
    if (!isTextureLike(value)) {
      continue;
    }
    const texture = value as THREEType.Texture;
    if (disposed.has(texture)) {
      continue;
    }
    disposed.add(texture);
    texture.dispose();
    count += 1;
  }
  return count;
}

/**
 * 判断一个值是否像 `THREE.Texture`（鸭子类型，避免 `instanceof` 在 mock 环境失效）。
 *
 * @param value 任意值
 * @returns 是否可视为贴图
 */
function isTextureLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isTexture?: boolean }).isTexture === true
  );
}
