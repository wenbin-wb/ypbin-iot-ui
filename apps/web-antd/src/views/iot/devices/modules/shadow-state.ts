/**
 * 设备影子「期望值」编辑的**纯逻辑**（JSON 解析/校验/格式化/合并），零依赖可单测。
 *
 * 为什么抽出：details 页把 desired 当「目标配置」，编辑入口让用户改 **JSON 文本**。
 * 但 JSON 文本与对象之间来回转换的边界（非法 JSON、非对象、空对象、深层值）
 * 是"做错了看不出"的部分 —— 抽成纯函数在 jsdom 外穷举。
 */

/** JSON 解析结论。 */
export interface DesiredParseResult {
  ok: boolean;
  /** 解析出的对象（ok=true 时非空引用）。 */
  value?: Record<string, unknown>;
  /** 面向用户的原因（ok=false 时非空）。 */
  message: string;
}

/**
 * 解析期望值 JSON 文本。
 *
 * 🔴 必须是**对象**（后端 IotShadowReq.desired 是 Map）：数组/标量/null 都是非法输入，
 * 否则保存时后端会 4xx，且页面把错误延迟到提交后。
 *
 * @param text 用户输入的 JSON 文本
 * @returns 解析结论
 */
export function parseDesiredJson(text: string): DesiredParseResult {
  const raw = (text ?? '').trim();
  if (raw === '') {
    // 空文本按"清空 desired"处理：给 {} 而不是报错（清空是合法意图）
    return { ok: true, value: {}, message: '' };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, message: '不是合法的 JSON', value: undefined };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      message: '期望值必须是 JSON 对象（键值对），不能是数组/数字/null',
      value: undefined,
    };
  }
  return { ok: true, value: value as Record<string, unknown>, message: '' };
}

/**
 * 把 desired 对象格式化为可编辑的 JSON 文本（编辑前回显；空 desired 给 \'{}\'）。
 *
 * @param desired 当前期望值
 * @returns 格式化文本
 */
export function desiredToEditableText(
  desired?: null | Record<string, unknown>,
): string {
  if (!desired || Object.keys(desired).length === 0) {
    return '{}';
  }
  return JSON.stringify(desired, null, 2);
}

/**
 * 轻量展示：对象转「键=值」行（与详情页既有 shadowRows 同风格）。
 *
 * 值若为对象/数组则 JSON 化再显示（避免 [object Object]）。
 *
 * @param record 任意对象
 * @returns 行数组（键名升序，稳定展示）
 */
export function recordToRows(record?: null | Record<string, unknown>): Array<{
  key: string;
  value: string;
}> {
  if (!record) {
    return [];
  }
  return Object.keys(record)
    .toSorted()
    .map((key) => ({
      key,
      value: formatCell(record[key]),
    }));
}

/** 单元格值格式化（标量字面化；对象/数组 JSON 化）。 */
function formatCell(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
