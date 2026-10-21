import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOVER_GRACE_MS, useTwinPropertyCard } from './use-twin-property-card';

/**
 * 悬浮/点击卡片状态机（**纯状态**测试）。
 *
 * ## 为什么要单测一个「状态机」
 *
 * 卡片有 hover / pinned 两种展示态，而**只有 pinned 会改写 URL 与改变选中态**。
 * 历史上这类交互最典型的缺陷是两个：
 * 1. **鼠标扫过一排锚点就不断改写 URL**（hover 被误当成选中）⇒ 浏览器历史被刷爆，
 *    用户点「后退」回不到上一页；
 * 2. **卡片点不进去**（指针一离开锚点就关闭）⇒ 卡片里的「设备详情」按钮永远点不到。
 *
 * 本文件把这两条钉成可执行断言；用假定时器验证 grace 窗口。
 */

describe('useTwinPropertyCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('★ hover 不写 URL（不触发 onPinChange）', () => {
    const onPinChange = vi.fn();
    const card = useTwinPropertyCard({ onPinChange });
    card.enter('p1');
    expect(card.activePointId.value).toBe('p1');
    expect(card.isPinned.value).toBe(false);
    expect(onPinChange).not.toHaveBeenCalled();
  });

  it('★ 点击锚点 ⇒ 钉住并回调一次；重复点击同一锚点不再回调', () => {
    const onPinChange = vi.fn();
    const card = useTwinPropertyCard({ onPinChange });
    card.pin('p1');
    expect(card.activePointId.value).toBe('p1');
    expect(card.isPinned.value).toBe(true);
    expect(onPinChange).toHaveBeenCalledTimes(1);
    expect(onPinChange).toHaveBeenLastCalledWith('p1');

    card.pin('p1');
    expect(onPinChange).toHaveBeenCalledTimes(1);
  });

  it('★ 指针离开锚点后有 grace 窗口（为的是让用户把鼠标移进卡片）', () => {
    const card = useTwinPropertyCard();
    card.enter('p1');
    card.leave();
    // grace 期间仍展示
    vi.advanceTimersByTime(HOVER_GRACE_MS - 1);
    expect(card.activePointId.value).toBe('p1');
    // grace 结束才关闭
    vi.advanceTimersByTime(1);
    expect(card.activePointId.value).toBeUndefined();
  });

  it('★ grace 期间移进卡片（enter 再调用一次）⇒ 取消关闭', () => {
    const card = useTwinPropertyCard();
    card.enter('p1');
    card.leave();
    vi.advanceTimersByTime(HOVER_GRACE_MS - 20);
    card.enter('p1');
    vi.advanceTimersByTime(HOVER_GRACE_MS * 2);
    expect(card.activePointId.value).toBe('p1');
  });

  it('★ 钉住态下指针离开不关闭（钉住是持久态）', () => {
    const card = useTwinPropertyCard();
    card.pin('p1');
    card.leave();
    vi.advanceTimersByTime(HOVER_GRACE_MS * 3);
    expect(card.activePointId.value).toBe('p1');
    expect(card.isPinned.value).toBe(true);
  });

  it('★ 点击画布空白：有钉住则取消钉住并回调 undefined', () => {
    const onPinChange = vi.fn();
    const card = useTwinPropertyCard({ onPinChange });
    card.pin('p1');
    card.clickBlank();
    expect(card.activePointId.value).toBeUndefined();
    expect(card.isPinned.value).toBe(false);
    expect(onPinChange).toHaveBeenLastCalledWith(undefined);
  });

  it('★ 点击画布空白：没有钉住时只清悬停（不产生多余回调）', () => {
    const onPinChange = vi.fn();
    const card = useTwinPropertyCard({ onPinChange });
    card.enter('p1');
    card.clickBlank();
    expect(card.activePointId.value).toBeUndefined();
    expect(onPinChange).not.toHaveBeenCalled();
  });

  it('★ 钉住时悬停另一个锚点：卡片跟着悬停走，但钉住态与回调都不变', () => {
    const onPinChange = vi.fn();
    const card = useTwinPropertyCard({ onPinChange });
    card.pin('p1');
    card.enter('p2');
    // 钉住优先：activePointId 仍是 p1（钉住的卡片不因鼠标扫过而跳走）
    expect(card.activePointId.value).toBe('p1');
    // 取消钉住后回到悬停目标
    card.unpin();
    expect(card.activePointId.value).toBeUndefined();
  });

  it('★ URL 驱动同步不回写（syncFromUrl 不触发 onPinChange，避免形成环）', () => {
    const onPinChange = vi.fn();
    const card = useTwinPropertyCard({ onPinChange });
    card.syncFromUrl('p9');
    expect(card.activePointId.value).toBe('p9');
    expect(card.isPinned.value).toBe(true);
    expect(onPinChange).not.toHaveBeenCalled();

    card.syncFromUrl(undefined);
    expect(card.activePointId.value).toBeUndefined();
    expect(onPinChange).not.toHaveBeenCalled();
  });

  it('dispose 后残留的 grace 定时器不再改状态', () => {
    const card = useTwinPropertyCard();
    card.enter('p1');
    card.leave();
    card.dispose();
    vi.advanceTimersByTime(HOVER_GRACE_MS * 2);
    // dispose 只清定时器：状态保持（组件已卸载，无副作用），关键是不再有悬挂定时器
    expect(vi.getTimerCount()).toBe(0);
  });
});
