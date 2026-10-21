import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { extractNodeNames } from './model-node-names';

/**
 * 上传前节点名解析（工单 #130）。
 *
 * 重点钉住「**失败不阻断上传**」这条不变量：节点名只是辅助索引，
 * 让它阻塞上传的代价远大于收益。
 */
describe('extractNodeNames', () => {
  /**
   * 造一个最小合法 GLB（**手工拼二进制**，不依赖 GLTFExporter）。
   *
   * 为什么不用 `GLTFExporter`：它在 happy-dom 下依赖 `FileReader`（未实现），
   * 导出阶段就抛错，测不到我们的解析逻辑。这里直接按 glTF 2.0 规范拼
   * `header + JSON chunk + BIN chunk`，与真实上传的 GLB 结构一致。
   */
  function buildGlb(nodeNames: string[]): File {
    const nodes = nodeNames.map((name) => ({ name }));
    const gltf = {
      asset: { version: '2.0' },
      scenes: [{ nodes: nodes.map((_, index) => index) }],
      scene: 0,
      nodes,
    };
    let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
    const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);

    const jsonLen = Buffer.alloc(4);
    jsonLen.writeUInt32LE(jsonBuf.length);
    // 用 ASCII 字符串写入而不是十六进制字面量：本仓 oxfmt 会把 hex 降为小写、
    // 而 oxlint 的 unicorn/number-literal-case 要求大写，两者互相改写（见 #124 的同类问题）。
    const jsonType = Buffer.from('JSON', 'ascii');

    const total = 12 + 8 + jsonBuf.length;
    const header = Buffer.alloc(12);
    Buffer.from('glTF', 'ascii').copy(header, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(total, 8);

    const glb = Buffer.concat([header, jsonLen, jsonType, jsonBuf]);
    return new File([glb], 'test.glb', { type: 'model/gltf-binary' });
  }

  it('★ 解析出全部具名节点（无名节点被忽略）', async () => {
    const file = buildGlb(['Floor', 'Cabinet_A', 'Cabinet_B']);
    const names = await extractNodeNames(file);
    expect(names.toSorted()).toEqual(['Cabinet_A', 'Cabinet_B', 'Floor']);
  });

  it('节点名去重', async () => {
    const file = buildGlb(['Dup', 'Dup', 'Other']);
    const names = await extractNodeNames(file);
    expect(names.filter((name) => name === 'Dup')).toHaveLength(1);
  });

  it('★ 非法文件 ⇒ 返回空数组而不是抛异常（不阻断上传）', async () => {
    const bad = new File([new Uint8Array([1, 2, 3, 4])], 'bad.glb', {
      type: 'model/gltf-binary',
    });
    await expect(extractNodeNames(bad)).resolves.toEqual([]);
  });

  it('★ 空文件 ⇒ 返回空数组（不阻断上传）', async () => {
    const empty = new File([], 'empty.glb', { type: 'model/gltf-binary' });
    await expect(extractNodeNames(empty)).resolves.toEqual([]);
  });
});
