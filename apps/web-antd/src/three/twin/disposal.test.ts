import type * as THREEType from 'three';

import { describe, expect, it, vi } from 'vitest';

import { disposeSubtree } from './disposal';

/**
 * GPU 资源回收：递归、去重、幂等。
 *
 * 纯单测：用最小假对象模拟 `Object3D` 的 `traverse`/`geometry`/`material`，
 * 不引入真实 three（避免 happy-dom 下的 WebGL 依赖）。
 */

interface FakeTexture {
  dispose: ReturnType<typeof vi.fn>;
  isTexture: true;
}

interface FakeMaterial {
  dispose: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

/** 构造一个可 traverse 的假对象树。 */
function fakeTree(nodes: Array<Record<string, unknown>>) {
  return {
    traverse: (callback: (node: Record<string, unknown>) => void) => {
      for (const node of nodes) {
        callback(node);
      }
    },
  } as unknown as THREEType.Object3D;
}

function fakeTexture(): FakeTexture {
  return { dispose: vi.fn(), isTexture: true };
}

function fakeMaterial(extra: Record<string, unknown> = {}): FakeMaterial {
  return { dispose: vi.fn(), ...extra };
}

describe('disposeSubtree', () => {
  it('递归释放几何体、材质与其贴图', () => {
    const geometry = { dispose: vi.fn() };
    const texture = fakeTexture();
    const material = fakeMaterial({ map: texture });
    const root = fakeTree([
      { geometry, material },
      { geometry: { dispose: vi.fn() }, material: [fakeMaterial()] },
    ]);

    const stats = disposeSubtree(root);

    expect(geometry.dispose).toHaveBeenCalledTimes(1);
    expect(material.dispose).toHaveBeenCalledTimes(1);
    expect(texture.dispose).toHaveBeenCalledTimes(1);
    expect(stats.geometries).toBe(2);
    expect(stats.materials).toBe(2);
    expect(stats.textures).toBe(1);
    expect(stats.objects).toBe(2);
  });

  it('★ 多个 mesh 共享同一材质/几何体时只释放一次', () => {
    const sharedGeometry = { dispose: vi.fn() };
    const sharedTexture = fakeTexture();
    const sharedMaterial = fakeMaterial({ map: sharedTexture });
    const root = fakeTree([
      { geometry: sharedGeometry, material: sharedMaterial },
      { geometry: sharedGeometry, material: sharedMaterial },
      { geometry: sharedGeometry, material: sharedMaterial },
    ]);

    const stats = disposeSubtree(root);

    expect(sharedGeometry.dispose).toHaveBeenCalledTimes(1);
    expect(sharedMaterial.dispose).toHaveBeenCalledTimes(1);
    expect(sharedTexture.dispose).toHaveBeenCalledTimes(1);
    expect(stats.geometries).toBe(1);
    expect(stats.materials).toBe(1);
  });

  it('★ 材质上的全部贴图都被释放（不依赖硬编码属性名）', () => {
    const map = fakeTexture();
    const normalMap = fakeTexture();
    const roughnessMap = fakeTexture();
    const envMap = fakeTexture();
    const material = fakeMaterial({ envMap, map, normalMap, roughnessMap });
    const root = fakeTree([{ material }]);

    const stats = disposeSubtree(root);

    for (const texture of [map, normalMap, roughnessMap, envMap]) {
      expect(texture.dispose).toHaveBeenCalledTimes(1);
    }
    expect(stats.textures).toBe(4);
  });

  it('骨架贴图（boneTexture）也被释放', () => {
    const boneTexture = fakeTexture();
    const root = fakeTree([{ skeleton: { boneTexture } }]);

    const stats = disposeSubtree(root);

    expect(boneTexture.dispose).toHaveBeenCalledTimes(1);
    expect(stats.textures).toBe(1);
  });

  it('空树不报错，统计全 0', () => {
    const stats = disposeSubtree(fakeTree([]));
    expect(stats).toEqual({
      geometries: 0,
      materials: 0,
      objects: 0,
      textures: 0,
    });
  });

  it('不是贴图的对象（number/string/null）不被当成贴图', () => {
    const material = fakeMaterial({
      color: 0xff_00_00,
      name: 'mat',
      opacity: 1,
      userData: null,
    });
    const root = fakeTree([{ material }]);

    const stats = disposeSubtree(root);

    expect(stats.textures).toBe(0);
    expect(material.dispose).toHaveBeenCalledTimes(1);
  });
});
