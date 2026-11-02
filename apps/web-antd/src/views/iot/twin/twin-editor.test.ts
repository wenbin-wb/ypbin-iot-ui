import { describe, expect, it } from 'vitest';

import { useTwinEditor } from './composables/use-twin-editor';

/**
 * 配置态交互状态机（放置锚点 → 草稿 → 保存）。
 *
 * ## 为什么必须测这条链路
 *
 * 独立复核发现过真实缺口：`startPlacing`/`cancelPlacing` **零调用点**，
 * `mode` 永远停在 `'browse'` ⇒ 画布里 `editorMode !== 'place'` 恒真 ⇒ `@place` 永不触发，
 * `draft` 只写不读 —— 整条「在 3D 里点位置放设备」的交互是死代码。
 *
 * 这类缺陷的共性是「状态机能跑、但没人接它」，所以本文件刻意断言**状态迁移本身**，
 * 由 `index.vue` 的接线保证有调用方；两者缺一都不算完成。
 */
describe('useTwinEditor 放置锚点状态机', () => {
  it('初始为浏览态、无草稿、无选中', () => {
    const editor = useTwinEditor();
    expect(editor.mode.value).toBe('browse');
    expect(editor.draft.value).toBeNull();
    expect(editor.editingPointId.value).toBeNull();
    expect(editor.placeFormOpen.value).toBe(false);
    expect(editor.hasDraft.value).toBe(false);
  });

  it('★ startPlacing 进入放置态（此方法此前零调用点，是死代码）', () => {
    const editor = useTwinEditor();
    editor.startPlacing();
    expect(editor.mode.value).toBe('place');
    expect(editor.draft.value).toBeNull();
    // 刚进入放置态还没点位置 ⇒ 表单不该弹
    expect(editor.placeFormOpen.value).toBe(false);
  });

  it('★ setDraft 记录拾取位置并打开表单（拾取结果必须能回填）', () => {
    const editor = useTwinEditor();
    editor.startPlacing();
    editor.setDraft({
      local: { x: 1, y: 2, z: 3 },
      normal: { x: 0, y: 1, z: 0 },
    });

    expect(editor.draft.value).toEqual({
      local: { x: 1, y: 2, z: 3 },
      normal: { x: 0, y: 1, z: 0 },
    });
    expect(editor.placeFormOpen.value).toBe(true);
    expect(editor.hasDraft.value).toBe(true);
  });

  it('★ dismissPlaceForm 只收起表单、保留放置态（用户点偏了可以直接改点）', () => {
    const editor = useTwinEditor();
    editor.startPlacing();
    editor.setDraft({
      local: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
    });

    editor.dismissPlaceForm();

    expect(editor.placeFormOpen.value).toBe(false);
    // 仍在放置态：用户可以直接再点画布
    expect(editor.mode.value).toBe('place');
  });

  it('★ cancelPlacing 退出放置态并丢弃草稿', () => {
    const editor = useTwinEditor();
    editor.startPlacing();
    editor.setDraft({
      local: { x: 5, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
    });

    editor.cancelPlacing();

    expect(editor.mode.value).toBe('browse');
    expect(editor.draft.value).toBeNull();
    expect(editor.placeFormOpen.value).toBe(false);
  });

  it('★ 再次 startPlacing 会清掉上一次的草稿（不残留旧坐标）', () => {
    const editor = useTwinEditor();
    editor.startPlacing();
    editor.setDraft({
      local: { x: 9, y: 9, z: 9 },
      normal: { x: 0, y: 1, z: 0 },
    });

    editor.startPlacing();

    expect(editor.draft.value).toBeNull();
    expect(editor.placeFormOpen.value).toBe(false);
  });

  it('selectPoint 切到浏览态并收起放置表单（避免两个态叠加）', () => {
    const editor = useTwinEditor();
    editor.startPlacing();
    editor.setDraft({
      local: { x: 1, y: 1, z: 1 },
      normal: { x: 0, y: 1, z: 0 },
    });

    editor.selectPoint('point-1');

    expect(editor.mode.value).toBe('browse');
    expect(editor.placeFormOpen.value).toBe(false);
    expect(editor.editingPointId.value).toBe('point-1');
  });

  it('★ reset 清空全部（切场景 / 保存成功后调用，防跨场景串坐标）', () => {
    const editor = useTwinEditor();
    editor.startPlacing();
    editor.setDraft({
      local: { x: 1, y: 2, z: 3 },
      normal: { x: 0, y: 1, z: 0 },
    });
    editor.selectPoint('point-1');

    editor.reset();

    expect(editor.mode.value).toBe('browse');
    expect(editor.draft.value).toBeNull();
    expect(editor.placeFormOpen.value).toBe(false);
    expect(editor.editingPointId.value).toBeNull();
    expect(editor.hasDraft.value).toBe(false);
  });
});
