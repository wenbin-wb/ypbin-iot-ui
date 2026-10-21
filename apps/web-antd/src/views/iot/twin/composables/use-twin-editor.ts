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
  /** 选中编辑的点位 id。 */
  const editingPointId = ref<null | string>(null);
  /** 是否有任何未保存改动。 */
  const hasDraft = computed(
    () => draft.value !== null || editingPointId.value !== null,
  );

  /** 进入「放置锚点」模式。 */
  function startPlacing(): void {
    mode.value = 'place';
    draft.value = null;
  }

  /** 取消放置。 */
  function cancelPlacing(): void {
    mode.value = 'browse';
    draft.value = null;
  }

  /** 记录拾取到的位置（世界 → 局部换算由调用方完成）。 */
  function setDraft(anchor: DraftAnchor): void {
    draft.value = anchor;
  }

  /** 选中存量点位进行编辑。 */
  function selectPoint(pointId: null | string): void {
    editingPointId.value = pointId;
    mode.value = 'browse';
  }

  /** 清空选择与草稿（保存成功 / 取消后调用）。 */
  function reset(): void {
    mode.value = 'browse';
    draft.value = null;
    editingPointId.value = null;
  }

  return {
    cancelPlacing,
    draft,
    editingPointId,
    hasDraft,
    mode,
    reset,
    selectPoint,
    setDraft,
    startPlacing,
  };
}
