/**
 * 告警列表页的两个**纯判据**（无任何 import ⇒ 用例可以在本机直接跑，不被 api/request 依赖链拖累）。
 *
 * 它们承载两条本仓已收口过的纪律：
 * 1. **失败绝不画成空态**（`listSlotState`）——「加载失败」与「确实没有数据」在 vxe 的 `#empty` 槽里
 *    长得一样，把失败画成空态会让用户永久留下「没有数据」这个错误结论；
 * 2. **设备过滤的合并顺序**（`resolveDeviceFilter`）——表单里显式选的设备优先于 URL 带来的设备，
 *    否则「清空筛选」会被 URL 参数悄悄抵消。
 *
 * 抽成纯函数是为了让这两条纪律**有可运行的用例守门**：判据写在模板里时，回归无法被咬住
 * （独立复核 2026-10-03 实测：删掉模板里的 `v-if="!listError"` 后，可运行用例无一转红）。
 */

/** 列表槽位状态：失败优先于空。 */
export type ListSlotState = 'content' | 'empty' | 'error';

/**
 * 决定列表 `#empty` 槽渲染什么。
 *
 * @param error    非空表示本次加载失败（原样展示后端 message）
 * @param rowCount 当前已取回的行数
 * @returns `error` 优先于 `empty`；有行则为 `content`
 */
export function listSlotState(error: string, rowCount: number): ListSlotState {
  if (error !== '') {
    return 'error';
  }
  return rowCount > 0 ? 'content' : 'empty';
}

/**
 * 设备过滤的合并规则。
 *
 * @param formDeviceId   筛选表单里选的设备
 * @param presetDeviceId 从设备台账带过来的 `?deviceId=`
 * @returns 生效的设备过滤；两者都为空则 `undefined`（= 不过滤）
 */
export function resolveDeviceFilter(
  formDeviceId?: string,
  presetDeviceId?: string,
): string | undefined {
  const form = (formDeviceId ?? '').trim();
  if (form !== '') {
    return form;
  }
  const preset = (presetDeviceId ?? '').trim();
  return preset === '' ? undefined : preset;
}
