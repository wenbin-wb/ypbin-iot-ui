import { $t } from '#/locales';

/**
 * 批量按钮「为什么点不动」的禁用原因（空串 = 不禁用）。
 *
 * 从 `index.vue` 拆出的原因（拆分批次 5-D）：三处按钮（批量确认/批量静默/批量启停规则）
 * 用的是**同一条优先级规则**（请求在途 > 未勾选），此前在页面里抄了三份；规则收在一个
 * 纯函数里，改口径只改一处。
 *
 * 为什么要给原因：`:disabled` 本身不告诉用户「为什么点不动」，键盘/读屏用户更无从得知。
 * 模板用 Tooltip 给鼠标/触屏提示，并把包裹层设为可聚焦（tabindex=0）+ 一段 `sr-only`
 * 文案，让 Tab 到包裹层时键盘/读屏也能拿到同一原因。
 *
 * @param pending       本批请求是否在途
 * @param selectedCount 当前已勾选条数
 * @returns 本地化提示文案；空串表示按钮可用（Tooltip 不显示）
 */
export function resolveBatchDisabledReason(
  pending: boolean,
  selectedCount: number,
): string {
  if (pending) {
    return $t('page.iot.common.disabledPending');
  }
  return selectedCount === 0 ? $t('page.iot.common.disabledSelectFirst') : '';
}
