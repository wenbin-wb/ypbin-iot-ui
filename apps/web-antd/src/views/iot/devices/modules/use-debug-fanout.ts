import type { IotCommandApi } from '#/api/iot';

import { $t } from '#/locales';

/**
 * 「一次下发拆成 N 条」的纯逻辑（从 `detail-debug.vue` 拆出，2026-10-20 架构审查 §2.2）。
 *
 * 为什么单独成模块：后端 `CommandPayloads` 对 `property_get` 只放**一个**标识 ⇒ 多点位/多行
 * 必须由前端拆成 N 条独立指令（各自 `requestId`、各自可重发）。这段「表单值 → 目标数组」
 * 是**纯函数**（无 ref、无请求），也是本页最容易出边界错的逻辑（空选 = 全部可读、
 * 服务调用 params 必须是 JSON 对象、fanout 上限）⇒ 抽出来才可单测。
 *
 * 口径（原样保留）：
 * 1. 每条只带一个 `identifier`；
 * 2. `property_get` 空选 = 全部可读属性（后端既定语义：`properties` 空数组 = 全部）；
 * 3. `writeDesired` 仅 `property_set` 且**勾选才发**（不写用户没要求的期望值）；
 * 4. 超上限**前端先拒**（不让用户点出一个必然被后端逐条拒绝的批次）。
 */

/** 一次下发最多拆出多少条指令（后端单条只接一个标识 ⇒ 多点位必须拆）。 */
export const MAX_FANOUT = 20;

/** 后端 `CommandSendReq.MAX_TIMEOUT_MS`（1 小时）。 */
export const MAX_TIMEOUT_MS = 60 * 60 * 1000;

export interface SetRow {
  identifier?: string;
  key: number;
  value: string;
}

export interface SendTarget {
  identifier: string;
  req: IotCommandApi.CommandSendReq;
}

/** 组装目标所需的下发表单状态（由 `use-debug-command` 持有）。 */
export interface FanoutFormState {
  getSelection: string[];
  kind: IotCommandApi.CommandKindCode;
  paramsText: string;
  serviceIdentifier?: string;
  setRows: SetRow[];
  timeoutMs?: number;
  writeDesired: boolean;
}

/** 目标上下文：无设备/无产品时无法组装（必须显式拒绝，而不是发一个空目标）。 */
export interface FanoutContext {
  deviceId?: string;
  productId?: string;
}

export type FanoutResult =
  | { args?: string[]; errorKey: string; ok: false }
  | { ok: true; targets: SendTarget[] };

/**
 * 输入框文本 → 下发的 JSON 值。
 *
 * 口径写在字段说明里（`valueHint`）：优先按 JSON 解析（`25.5`→数字、`true`→布尔、
 * `"text"`→字符串、`{"a":1}`→对象），解析失败则按**字符串**下发（不静默丢弃用户输入）。
 */
export function parseValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') {
    return '';
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

/** 解析 `params`：**必须是 JSON 对象**（与后端 B10 口径一致，前端先拦一道避免无谓往返）。 */
export function parseParamsObject(
  text: string,
): { ok: false } | { ok: true; value: Record<string, unknown> } {
  const raw = text.trim() === '' ? '{}' : text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * 组装本批要下发的指令（每条只带一个标识）。
 *
 * 返回**判别联合**而不是直接写 `formError`：纯函数可单测，页面只负责把 `errorKey` 翻成文案。
 */
export function buildFanoutTargets(
  state: FanoutFormState,
  context: FanoutContext,
): FanoutResult {
  if (!context.deviceId) {
    return { errorKey: 'page.iot.debug.noDevice', ok: false };
  }
  if (!context.productId) {
    return { errorKey: 'page.iot.debug.noProduct', ok: false };
  }
  const timeout =
    typeof state.timeoutMs === 'number' && state.timeoutMs > 0
      ? state.timeoutMs
      : undefined;

  if (state.kind === 'property_set') {
    const rows = state.setRows.filter(
      (row): row is SetRow & { identifier: string } =>
        (row.identifier ?? '') !== '',
    );
    if (rows.length === 0) {
      return { errorKey: 'page.iot.debug.noTarget', ok: false };
    }
    const targets = rows.map((row) => {
      const req: IotCommandApi.CommandSendReq = {
        identifier: row.identifier,
        kind: state.kind,
        params: { value: parseValue(row.value) },
        timeoutMs: timeout,
      };
      // 勾选才发：后端在命令投递成功（sent）后把该值合并进影子 desired
      if (state.writeDesired) {
        req.writeDesired = true;
      }
      return { identifier: row.identifier, req };
    });
    return enforceFanoutLimit(targets);
  }

  if (state.kind === 'property_get') {
    // 空选 = 全部可读属性（后端既定语义：properties 空数组 = 全部可读）
    if (state.getSelection.length === 0) {
      return enforceFanoutLimit([
        {
          identifier: $t('page.iot.debug.allReadable'),
          req: { kind: state.kind, timeoutMs: timeout },
        },
      ]);
    }
    return enforceFanoutLimit(
      state.getSelection.map((identifier) => ({
        identifier,
        req: { identifier, kind: state.kind, timeoutMs: timeout },
      })),
    );
  }

  if (!state.serviceIdentifier) {
    return { errorKey: 'page.iot.debug.noCommand', ok: false };
  }
  const parsed = parseParamsObject(state.paramsText);
  if (!parsed.ok) {
    return { errorKey: 'page.iot.debug.paramsInvalid', ok: false };
  }
  return enforceFanoutLimit([
    {
      identifier: state.serviceIdentifier,
      req: {
        identifier: state.serviceIdentifier,
        kind: state.kind,
        params: parsed.value,
        timeoutMs: timeout,
      },
    },
  ]);
}

/** 超上限前端先拒（顺序发出，避免一次轰出几十条并发）。 */
function enforceFanoutLimit(targets: SendTarget[]): FanoutResult {
  if (targets.length > MAX_FANOUT) {
    return {
      args: [String(MAX_FANOUT), String(targets.length)],
      errorKey: 'page.iot.debug.fanoutTooMany',
      ok: false,
    };
  }
  return { ok: true, targets };
}
