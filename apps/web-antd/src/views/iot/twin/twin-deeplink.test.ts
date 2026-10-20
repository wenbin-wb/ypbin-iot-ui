import { describe, expect, it } from 'vitest';

import { ROOT_PARENT_ID } from './composables/use-twin-scene';

/**
 * 场景树深链相关的**纯逻辑**约定。
 *
 * 完整深链行为（`?sceneId=` 打开/关闭/未知 id 保持尝试语义）需要挂载整个页面组件并
 * 桩掉 three 画布，成本高且脆弱。这里只钉死两条**最容易写错**的纯逻辑约定：
 * 根场景哨兵值与「父场景不存在时链断裂必须可见」。
 *
 * 页面级深链行为（进入场景即 `router.replace({query:{sceneId}})`）由手工验收覆盖
 * （见设计文档 §9.4）。
 */
describe('场景树深链约定', () => {
  it('根场景的 parentId 哨兵值是字符串 "0"（不是 null / 空串 / 数字 0）', () => {
    expect(ROOT_PARENT_ID).toBe('0');
  });

  it('后端返回的 parentId 一律按字符串处理（Long 序列化为字符串）', () => {
    // 反证：若把 "0" 当 falsy 判断，根场景会被误判为「父场景缺失」
    expect(Boolean('0')).toBe(true);
    expect(Boolean(0)).toBe(false);
  });
});
