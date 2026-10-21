import { describe, expect, it } from 'vitest';

/**
 * 竞态守卫的**行为契约**测试（工单 #132）。
 *
 * ## 为什么会出问题（修复前的实测链路）
 *
 * ```js
 * watch(currentSceneId, async (sceneId) => {
 *   await loadPoints(sceneId);
 *   points.value = await getTwinPointList(sceneId);   // ← 不校验是否还是当前场景
 * });
 * ```
 * 场景 A（大、慢）→ 立刻点场景 B（小、快）：B 的点位先到并渲染，随后 A 的响应到达
 * 把它覆盖掉 ⇒ **3D 锚点用旧场景的局部坐标画在新场景的模型上**，位置完全错乱，
 * 而用户看不出原因（界面不报错，只是点位飘着）。
 *
 * ## 测试策略
 *
 * 守卫本身是「世代号 + await 后比对」，逻辑极简但**极易在重构时丢失**（删掉一个
 * `if (generation !== ...)` 就退回旧行为，而视觉上只有在慢网+快切时才暴露）。
 * 因此这里用**可控 deferred** 精确复现「后发先至」，断言旧响应被丢弃。
 *
 * 被测对象是 composable 的内部逻辑，无法直接注入；故这里复刻同一契约做**契约级**断言，
 * 并由 `use-twin-scene` / `use-twin-runtime` / `index.vue` 里的同名守卫实现保证一致
 * （三处都有 `xxxGeneration` 计数，`grep` 可核对）。
 */

/** 可手动控制 resolve 时机的 Promise（复现「后发先至」）。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * 模拟「世代守卫下的加载」：与生产实现同构的最小模型。
 *
 * @param fetcher 取数函数
 * @returns load 函数与当前值读取器
 */
function createGuardedLoader<T>(fetcher: (key: string) => Promise<T>) {
  let generation = 0;
  let current: T | undefined;
  const load = async (key: string) => {
    const mine = ++generation;
    const data = await fetcher(key);
    // 与生产代码同一条守卫：过期即丢弃
    if (mine !== generation) {
      return;
    }
    current = data;
  };
  return {
    get: () => current,
    load,
  };
}

describe('竞态守卫（#132）', () => {
  it('★ 后发先至：慢的旧请求不得覆盖快的新请求', async () => {
    const slow = deferred<string[]>();
    const fast = deferred<string[]>();
    const loader = createGuardedLoader<string[]>((key) =>
      key === 'A' ? slow.promise : fast.promise,
    );

    const loadA = loader.load('A'); // 旧场景，慢
    const loadB = loader.load('B'); // 新场景，快

    // B 先返回
    fast.resolve(['B1', 'B2']);
    await loadB;
    expect(loader.get()).toEqual(['B1', 'B2']);

    // A 后返回 —— 必须被丢弃
    slow.resolve(['A1', 'A2', 'A3']);
    await loadA;
    expect(loader.get()).toEqual(['B1', 'B2']);
  });

  it('★ 无守卫时会失败（证明该测试有咬合力）', async () => {
    // 故意不实现守卫：验证上面的场景在缺失守卫时确实会错
    const slow = deferred<string[]>();
    const fast = deferred<string[]>();
    let current: string[] | undefined;
    const naiveLoad = async (p: Promise<string[]>) => {
      current = await p;
    };

    const loadA = naiveLoad(slow.promise);
    const loadB = naiveLoad(fast.promise);
    fast.resolve(['B1', 'B2']);
    await loadB;
    slow.resolve(['A1', 'A2', 'A3']);
    await loadA;

    // 没有守卫 ⇒ 旧场景的点位覆盖了新场景（这就是修复前的行为）
    expect(current).toEqual(['A1', 'A2', 'A3']);
  });

  it('世代号只增不减：连续切 5 次，只有最后一次生效', async () => {
    const all = ['S1', 'S2', 'S3', 'S4', 'S5'].map(() => deferred<string[]>());
    let callIndex = 0;
    const loader = createGuardedLoader<string[]>(
      () => all[callIndex++]?.promise ?? Promise.resolve([]),
    );

    const pending = ['S1', 'S2', 'S3', 'S4', 'S5'].map((key) => loader.load(key));

    // 乱序返回（倒序）——只有最后发起的 S5 应该生效
    for (let index = all.length - 1; index >= 0; index--) {
      all[index]?.resolve([`scene-${index}`]);
    }
    await Promise.all(pending);

    expect(loader.get()).toEqual(['scene-4']);
  });

  it('正常串行加载不受影响（守卫不误杀）', async () => {
    const loader = createGuardedLoader<string[]>(async (key) => [`${key}-point`]);
    await loader.load('A');
    expect(loader.get()).toEqual(['A-point']);
    await loader.load('B');
    expect(loader.get()).toEqual(['B-point']);
  });
});

/**
 * 说明：以上为契约级测试。三处生产实现（`use-twin-scene#load`、
 * `use-twin-runtime#loadSnapshot`、`index.vue#loadPoints`）均有同名
 * `xxxGeneration` 守卫，可用以下命令核对它们没被删掉：
 *
 * ```bash
 * grep -rn "Generation" apps/web-antd/src/views/iot/twin/
 * ```
 */
describe('竞态守卫的源码存在性（防重构时丢失）', () => {
  it('三处加载链路都保留了世代守卫', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const base = dirname(fileURLToPath(import.meta.url));

    const targets = [
      ['composables/use-twin-scene.ts', 'sceneLoadGeneration'],
      ['composables/use-twin-runtime.ts', 'snapshotGeneration'],
      ['index.vue', 'pointsGeneration'],
    ] as const;

    for (const [file, marker] of targets) {
      const code = readFileSync(resolve(base, file), 'utf8');
      expect(code, `${file} 缺少 ${marker} 竞态守卫（#132 会复发）`).toContain(
        marker,
      );
      // 守卫必须真的参与比较，而不只是声明（写法是 `generation !== xxxGeneration`）
      expect(code).toMatch(new RegExp(`!==\\s*${marker}`));
    }
  });
});
