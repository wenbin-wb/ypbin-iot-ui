import type { Ref } from 'vue';

import { computed, ref } from 'vue';

/**
 * 悬浮/点击卡片的状态机（**纯状态，不碰 DOM 与 three**）。
 *
 * ## 三种状态与它们之间的迁移
 *
 * ```
 *                 pointermove 命中锚点
 *      idle ─────────────────────────────► hover
 *       ▲  │                              │  │
 *       │  │ 点击锚点                       │  │ 指针移出（留出 grace 时间）
 *       │  ▼                              │  ▼
 *       │ pinned ◄──── 点击另一个锚点 ◄────┘
 *       │   │
 *       │   └── 点击画布空白 / 关闭按钮 / Esc
 *       └── idle
 * ```
 *
 * ## 为什么 hover 需要 grace（离开延迟）
 *
 * 卡片是一个**可交互**的浮层（用户要能把鼠标移进去复制数值、点「设备详情」）。
 * 若指针一离开锚点就立刻关闭，用户永远点不到卡片里的按钮 —— 这是浮层交互最经典的缺陷。
 * 因此离开锚点后延迟 {@link HOVER_GRACE_MS} 关闭；在这段时间内进入卡片则取消关闭。
 *
 * ## 为什么 hover 与 pinned 是互斥的两个状态而不是一个布尔
 *
 * 「钉住」意味着**页面状态变了**（URL 写 `?pointId=`、相机已聚焦、右侧列表高亮）；
 * 「悬停」是**纯临时**的（不能写 URL、不能改变选中态）。混成一个布尔后，
 * 鼠标扫过一排锚点就会不断改写 URL 与选中态，浏览器历史与组件状态都会乱。
 */

/** 悬停离开锚点后的关闭延迟（毫秒）：足够把指针从锚点移到卡片上。 */
export const HOVER_GRACE_MS = 180;

/** 卡片状态机的宿主状态。 */
export interface CardState {
  /** 当前悬停的点位（临时态）。 */
  hoveredPointId?: string;
  /** 当前钉住的点位（持久态；点击产生）。 */
  pinnedPointId?: string;
}

/**
 * 卡片状态机。
 *
 * @param onPinChange 钉住状态变化的回调（页面据此写 URL / 聚焦相机；`undefined` = 取消钉住）
 * @returns 状态与操作方法
 */
export function useTwinPropertyCard(options: {
  /** 钉住目标变化（含取消钉住）。 */
  onPinChange?: (pointId: string | undefined) => void;
} = {}) {
  const state = ref<CardState>({});
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;

  /** 当前应展示卡片的点位：钉住优先于悬停。 */
  const activePointId = computed<string | undefined>(() => {
    return state.value.pinnedPointId ?? state.value.hoveredPointId;
  });

  /** 是否处于钉住态（页面据此显示「已固定」标记与关闭按钮）。 */
  const isPinned = computed(() => state.value.pinnedPointId !== undefined);

  /** 清掉离开定时器。 */
  function clearHoverTimer(): void {
    if (hoverTimer !== undefined) {
      clearTimeout(hoverTimer);
      hoverTimer = undefined;
    }
  }

  /**
   * 指针进入锚点（或卡片本身）。
   *
   * @param pointId 点位 ID
   */
  function enter(pointId: string): void {
    clearHoverTimer();
    if (state.value.hoveredPointId === pointId) {
      return;
    }
    state.value = { ...state.value, hoveredPointId: pointId };
  }

  /**
   * 指针离开锚点（或卡片）。
   *
   * 钉住态下离开不影响卡片（它已固定）；悬停态下延迟关闭，给用户把指针移进卡片的时间。
   */
  function leave(): void {
    if (state.value.hoveredPointId === undefined) {
      return;
    }
    clearHoverTimer();
    hoverTimer = setTimeout(() => {
      hoverTimer = undefined;
      state.value = { ...state.value, hoveredPointId: undefined };
    }, HOVER_GRACE_MS);
  }

  /** 立即清掉悬停（不延迟：用于「点击空白」这类确定性的取消）。 */
  function clearHover(): void {
    clearHoverTimer();
    if (state.value.hoveredPointId !== undefined) {
      state.value = { ...state.value, hoveredPointId: undefined };
    }
  }

  /**
   * 点击锚点 ⇒ 钉住。
   *
   * 点同一个已钉住的锚点不再重复触发回调（避免每次点击都重新飞行相机）。
   *
   * @param pointId 点位 ID
   */
  function pin(pointId: string): void {
    clearHoverTimer();
    if (state.value.pinnedPointId === pointId) {
      return;
    }
    state.value = { hoveredPointId: pointId, pinnedPointId: pointId };
    options.onPinChange?.(pointId);
  }

  /** 取消钉住（卡片回到悬停态或关闭）。 */
  function unpin(): void {
    const previous = state.value.pinnedPointId;
    state.value = { hoveredPointId: undefined, pinnedPointId: undefined };
    if (previous !== undefined) {
      options.onPinChange?.(undefined);
    }
  }

  /**
   * 点击画布空白。
   *
   * 语义：**有钉住就取消钉住**（再点空白不再做别的事）；没有钉住则清掉悬停。
   */
  function clickBlank(): void {
    if (state.value.pinnedPointId !== undefined) {
      unpin();
      return;
    }
    clearHover();
  }

  /** 释放定时器（组件卸载时必须调用）。 */
  function dispose(): void {
    clearHoverTimer();
  }

  /**
   * URL 驱动：外部把 `?pointId=` 的变化同步进来（刷新/前进后退时恢复钉住态）。
   *
   * 与用户点击的区别：这是**被动同步**，不能再回调 `onPinChange`（会与 URL 写入形成环）。
   *
   * @param pointId 外部指定的点位（undefined = 无）
   */
  function syncFromUrl(pointId: string | undefined): void {
    if (state.value.pinnedPointId === pointId) {
      return;
    }
    clearHoverTimer();
    state.value = pointId
      ? { hoveredPointId: pointId, pinnedPointId: pointId }
      : { hoveredPointId: undefined, pinnedPointId: undefined };
  }

  return {
    activePointId,
    clickBlank,
    clearHover,
    dispose,
    enter,
    isPinned,
    leave,
    pin,
    state: state as Ref<CardState>,
    syncFromUrl,
    unpin,
  };
}
