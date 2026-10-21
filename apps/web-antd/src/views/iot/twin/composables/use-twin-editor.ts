import { computed, ref } from 'vue';

/** 编辑器里的待保存锚点草稿（未落库）。 */
export interface DraftAnchor {
  /** 场景局部坐标。 */
  local: { x: number; y: number; z: number };
  /** 场景局部法线。 */
  normal: { x: number; y: number; z: number };
}

/**
 * 配置态交互状态机（拾取 → 保存）。
 *
 * ## 为什么不做自动保存
 *
 * 坐标是精密配置：一次误拖、一次失焦都可能把点位挪走几米。自动保存会把这种误操作直接写进库，
 * 而用户往往在几天后发现「设备位置偏了」且无从追溯是哪次改动导致的。
 * 因此全部改动先落在本地草稿，**只有点「保存」才提交**。
 *
 * 代价：用户可能忘记保存就切场景 ⇒ `hasDraft` 为 true 时切场景前必须弹确认。
 */
export function useTwinEditor() {
  /** 当前编辑模式：浏览 / 放置新锚点。 */
  const mode = ref<'browse' | 'place'>('browse');
  /** 待保存的新锚点草稿（`mode === 'place'` 且有拾取结果时有值）。 */
  const draft = ref<DraftAnchor | null>(null);
  /**
   * 草稿表单是否打开。
   *
   * 为什么不复用 `draft !== null`：用户点「取消」要回到「继续选点」，
   * 此时草稿应保留在画布提示里但不弹表单；用独立标志才能表达这个中间态。
   */
  const placeFormOpen = ref(false);
  /** 选中编辑的点位 id。 */
  const editingPointId = ref<null | string>(null);
  /** 是否有任何未保存改动。 */
  const hasDraft = computed(
    () => draft.value !== null || editingPointId.value !== null,
  );

  /** 进入「放置锚点」模式（画布开始接受模型表面点击）。 */
  function startPlacing(): void {
    mode.value = 'place';
    draft.value = null;
    placeFormOpen.value = false;
  }

  /** 取消放置（退出放置模式并丢弃草稿）。 */
  function cancelPlacing(): void {
    mode.value = 'browse';
    draft.value = null;
    placeFormOpen.value = false;
  }

  /**
   * 记录拾取到的位置并打开点位表单。
   *
   * 坐标已由调用方换算成本场景局部系（世界 → 局部），直接作为落库口径。
   *
   * @param anchor 拾取结果
   */
  function setDraft(anchor: DraftAnchor): void {
    draft.value = anchor;
    placeFormOpen.value = true;
  }

  /** 关闭草稿表单但保留放置模式（用户可以改点另一个位置）。 */
  function dismissPlaceForm(): void {
    placeFormOpen.value = false;
  }

  /** 选中存量点位进行编辑。 */
  function selectPoint(pointId: null | string): void {
    editingPointId.value = pointId;
    mode.value = 'browse';
    placeFormOpen.value = false;
  }

  /** 清空选择与草稿（保存成功 / 取消后调用）。 */
  function reset(): void {
    mode.value = 'browse';
    draft.value = null;
    placeFormOpen.value = false;
    editingPointId.value = null;
  }

  return {
    cancelPlacing,
    dismissPlaceForm,
    draft,
    editingPointId,
    hasDraft,
    mode,
    placeFormOpen,
    reset,
    selectPoint,
    setDraft,
    startPlacing,
  };
}
