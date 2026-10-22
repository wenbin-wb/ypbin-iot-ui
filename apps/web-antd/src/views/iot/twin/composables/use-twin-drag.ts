import type { IotTwinApi } from '#/api/iot';

import { computed, ref } from 'vue';

/**
 * 「设备放置 / 改位置」草稿状态机（**纯状态，不碰 DOM 与 three**）。
 *
 * ## 三种产生草稿的路径（用户只感知到「拖」）
 *
 * 1. **资料库拖入新设备**：从左侧资料库把设备拖到画布 ⇒ 生成「新点位草稿」
 *    （设备已知、坐标来自落点）；
 * 2. **拖动已有点位**：选中后拖 ⇒ 修改该点位的坐标草稿；
 * 3. **点击模型表面放置**（原有路径）：保留，作为拖拽的键盘/精确替代。
 *
 * ## 为什么只改草稿、点「保存」才落库
 *
 * 坐标是精密配置：一次误拖、一次失焦都可能把点位挪走几米。自动保存会把误操作直接写库，
 * 而用户往往几天后才发现「设备位置偏了」且无从追溯是哪次改动导致的。
 * 这与 `useTwinEditor` 的既有口径**完全一致**（存量代码已有此约定，不要改）。
 *
 * ## 为什么要独立于 `useTwinEditor`
 *
 * `useTwinEditor` 管的是「放置模式的 UI 开合（表单是否弹出）」；
 * 本模块管的是「**坐标草稿本身**」：哪台设备、拖到了哪、是否脏、能否保存。
 * 两者职责不同——把坐标草稿塞进 UI 状态机会让「切场景丢草稿」的判定变得含糊。
 */

/** 坐标（场景局部）。 */
export interface LocalPoint {
  x: number;
  y: number;
  z: number;
}

/** 拖入/拖动产生的草稿。 */
export interface PlacedDraft {
  /**
   * 草稿类型：
   * - `new`：新设备拖入（尚未落库，保存 = 新建点位）
   * - `move`：已有点位改位置（保存 = 更新该点位）
   */
  kind: 'move' | 'new';
  /** 设备 ID（新设备拖入时来自资料库；拖动已有点位时来自点位）。 */
  deviceId: string;
  /** 设备名（仅用于提示文案，不参与落库）。 */
  deviceName: string;
  /** 已有点位 ID（`kind === 'move'` 时必有）。 */
  pointId?: string;
  /** 落点（场景局部坐标）。 */
  local: LocalPoint;
}

/** 拖拽状态机。 */
export function useTwinDrag() {
  /** 当前拖拽来源（资料库拖起时的设备 ID；用于画布高亮可落区域）。 */
  const draggingDeviceId = ref<string>();
  /** 拖拽中的落点预览（画布坐标，随鼠标移动更新）。 */
  const dropPreview = ref<LocalPoint>();
  /** 当前草稿（未落库）。 */
  const draft = ref<PlacedDraft>();

  /** 是否有未保存的拖拽草稿（切场景/离开前要给提示）。 */
  const dirty = computed(() => draft.value !== undefined);

  /**
   * 开始拖拽（资料库 `dragstart` 调用）。
   *
   * @param deviceId 设备 ID
   */
  function startDrag(deviceId: string): void {
    draggingDeviceId.value = deviceId;
    dropPreview.value = undefined;
  }

  /**
   * 拖拽中的落点预览。
   *
   * @param local 落点局部坐标（落在空处时为 undefined）
   */
  function previewDrop(local?: LocalPoint): void {
    dropPreview.value = local;
  }

  /**
   * 结束拖拽（`dragend` / 离开画布）。
   *
   * 注意：**不清空草稿**——草稿是落库前的配置，与「这一次拖拽」不是同一生命周期。
   */
  function endDrag(): void {
    draggingDeviceId.value = undefined;
    dropPreview.value = undefined;
  }

  /**
   * 放置新设备（资料库拖入落点后调用）。
   *
   * @param device 设备信息
   * @param local 落点
   */
  function placeNewDevice(
    device: { id: string; name: string },
    local: LocalPoint,
  ): void {
    draft.value = {
      deviceId: device.id,
      deviceName: device.name,
      kind: 'new',
      local,
    };
    endDrag();
  }

  /**
   * 移动已有点位（拖动结束时调用）。
   *
   * @param point 点位
   * @param local 新落点
   */
  function movePoint(point: IotTwinApi.PointResp, local: LocalPoint): void {
    draft.value = {
      deviceId: point.deviceId,
      deviceName: point.deviceIdName ?? point.deviceId,
      kind: 'move',
      local,
      pointId: point.id,
    };
    endDrag();
  }

  /** 丢弃草稿（取消拖拽结果 / 切场景）。 */
  function discard(): void {
    draft.value = undefined;
    endDrag();
  }

  return {
    discard,
    dirty,
    draft,
    draggingDeviceId,
    dropPreview,
    endDrag,
    movePoint,
    placeNewDevice,
    previewDrop,
    startDrag,
  };
}
