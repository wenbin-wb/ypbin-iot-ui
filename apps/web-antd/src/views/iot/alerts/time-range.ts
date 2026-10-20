import { z } from '#/adapter/form';
import { $t } from '#/locales';

/**
 * 告警列表「首次越界时间」范围筛选的**纯逻辑**（格式口径 / 合法性 / 查询映射）。
 *
 * 为什么单独成模块：
 * 1. RangePicker 的值是 `[from, to]` 数组，而实例查询契约是两个独立参数 `from/to`；
 *    「什么时候传、传什么格式」必须只有一处实现（列表查询与 CSV 导出同源，否则导出范围会比屏幕多/少）。
 * 2. 合法性（起点 > 终点 / 半截范围 / 非约定格式）既要在表单层拦（zod rule），
 *    也要在请求层兜底（刷新按钮不经过表单提交），两处共用同一判据。
 *
 * 格式与后端 `AlertInstanceQuery.from/to` 的 `@DateTimeFormat(pattern = "yyyy-MM-dd HH:mm:ss")`
 * **逐字同口径**；固定宽度零填充格式下字符串字典序 == 时间序，因此顺序校验可直接比较字符串。
 */

/** RangePicker 的取值格式（= 后端 `@DateTimeFormat` pattern，勿改）。 */
export const ALERT_TIME_RANGE_FORMAT = 'YYYY-MM-DD HH:mm:ss';

/** 与 {@link ALERT_TIME_RANGE_FORMAT} 对应的严格格式断言（防区间被外部改成 ISO/时间戳）。 */
export const ALERT_TIME_RANGE_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** RangePicker 表单值：`[from, to]`；清空时 antd 可能给 `[]`/`null`/`undefined`。 */
export type AlertTimeRangeValue = (null | string | undefined)[] | null | undefined;

/** 实例查询的时间条件（空对象 = 不按时间过滤）。 */
export interface AlertTimeQuery {
  from?: string;
  to?: string;
}

/** 取数组某一端并归一成字符串（非字符串/空白一律视为未选）。 */
function rangeEnd(value: AlertTimeRangeValue, index: number): string {
  const raw = Array.isArray(value) ? value[index] : undefined;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** 是否「没有选时间」（用于「空值不传参」判断）。 */
export function isAlertTimeRangeEmpty(value: AlertTimeRangeValue): boolean {
  return rangeEnd(value, 0) === '' && rangeEnd(value, 1) === '';
}

/**
 * 范围是否合法：
 * - 未选 ⇒ 合法（不限定时间）；
 * - 两端都选 ⇒ 必须都匹配约定格式，且 from ≤ to；
 * - 只选一端（RangePicker 正常不会产生，但外部赋值/持久化脏数据可能）⇒ 非法，
 *   不得把半截条件发给后端（那等于悄悄按单边过滤）。
 */
export function isAlertTimeRangeValid(value: AlertTimeRangeValue): boolean {
  if (isAlertTimeRangeEmpty(value)) {
    return true;
  }
  const from = rangeEnd(value, 0);
  const to = rangeEnd(value, 1);
  if (from === '' || to === '') {
    return false;
  }
  if (!ALERT_TIME_RANGE_PATTERN.test(from) || !ALERT_TIME_RANGE_PATTERN.test(to)) {
    return false;
  }
  return from <= to;
}

/**
 * 表单值 → 实例查询参数。
 *
 * 空值/非法值一律返回空对象（**不传 from/to**）：空值不传参是接口契约，
 * 非法值由表单校验拦在前面，这里只是请求层兜底，绝不把非法时间静默发出去。
 */
export function resolveAlertTimeQuery(
  value: AlertTimeRangeValue,
): AlertTimeQuery {
  if (isAlertTimeRangeEmpty(value) || !isAlertTimeRangeValid(value)) {
    return {};
  }
  return { from: rangeEnd(value, 0), to: rangeEnd(value, 1) };
}

/**
 * 表单里的 RangePicker 校验规则（起点 > 终点时阻止提交并就地提示）。
 *
 * 用 zod 是因为 vben 表单的 `validateAndSubmit()`（`submitOnChange` 走的就是它）
 * 校验失败会**直接 return**、不触发 `handleSubmit` ⇒ 天然满足「阻止查询」；
 * 而错误文案由表单项就地渲染，不需要另造一个页面级提示。
 */
export function alertTimeRangeRule() {
  return z
    .unknown()
    .refine((value) => isAlertTimeRangeValid(value as AlertTimeRangeValue), {
      message: $t('page.iot.alert.timeRangeInvalid'),
    });
}

/**
 * RangePicker 两个输入框的 placeholder。
 *
 * i18n 只提供了**一组**组合文案（如「开始时间 ~ 结束时间」），而 RangePicker 需要
 * `[start, end]` 两段：按约定分隔符 `~` 拆分；若翻译改成不含 `~` 的整句，
 * 则退化为「整句 + 空」（不产生硬编码文案、也不至于显示原始 key）。
 */
export function alertTimeRangePlaceholders(): [string, string] {
  const combined = $t('page.iot.alert.timeRangePlaceholder');
  const parts = combined
    .split('~')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return [parts[0] ?? combined, parts[1] ?? ''];
}
