import type { IotAlertApi } from '#/api/iot';

/**
 * 告警规则「点位条件行」的纯逻辑（零 vue / 零请求，可单测）。
 *
 * ## 为什么需要它
 *
 * 后端保存契约是 `List<AlertRulePointReq> points`（**多行**），但旧表单只编辑 `points[0]`：
 * 用前端打开一条多条件规则再保存，其余条件行**会被静默删除**。本模块把「多行条件」的
 * 解析 / 校验 / 序列化抽成纯函数，让「不丢任何一行」这件事能被用例逐条钉死。
 *
 * ## 与后端的**同一口径**（前端先拦，失败提示不改写后端 message）
 *
 * 校验逐条对齐 `AlertRuleServiceImpl.buildPoint()/validate()`（一手核对源码，
 * `ypbin-iot/ypbin-service/ypbin-iot/.../service/impl/AlertRuleServiceImpl.java`）：
 * - 比较符白名单 GT/GTE/LT/LTE/EQ/NE（`AlertOperator`）；
 * - 比较域 NUMERIC/BOOLEAN，缺省按 NUMERIC（`buildPoint` 的 null/blank 兜底）；
 * - 布尔点位只能是 EQ/NE（`buildPoint` 第 341-348 行）；
 * - 阈值必须是可解析的十进制数（`new BigDecimal(raw.trim())`）；布尔阈值只能是 0/1；
 * - 回差非负、可空（空 ⇒ 不提交该字段）；
 * - 单规则条件行数上限（见 {@link MAX_POINTS_PER_RULE} 的来源注释）；
 * - 点位级规则至少 1 行（`validate()` 第 269-272 行）。
 *
 * ## 引擎真实语义（**不是 AND**，禁止在本模块/UI 里宣称「且」）
 *
 * 后端候选是「规则 × **单个**点位条件 × 设备」（`AlertCandidateResolver.java:114-117` 逐条件建
 * `Candidate`，`AlertTenantEvaluator.java:196-206` 逐候选独立判定），去重键
 * `AlertRules.dedupKey(ruleId, deviceId, propertyId)` **不含条件行身份** ⇒ **每条条件独立判定、
 * 各自产生告警实例**；且**同一 propertyId 的重复行会被库级唯一键 `uk_alert_active` 静默合并**
 * （只留最先插入的一条）。因此本模块额外把「重复点位」当作**阻断性校验**：宁可不让保存，
 * 也不能让用户以为两条同点位条件都会生效。
 */

/**
 * 单条规则允许的最大点位条件行数。
 *
 * 来源（读取不到后端运行时配置，故取与后端**同源的默认值**并在此注明）：
 * `AlertProperties.java:98` `private int maxPointsPerRule = 50`；
 * `deploy/nacos/ypbin-iot.yaml:111` `max-points-per-rule: 50`。
 * 后端在 `AlertRuleServiceImpl.validate()` 用同一配置拒绝超限，前端先拦只是为了不白跑一次请求。
 */
export const MAX_POINTS_PER_RULE = 50;

/** 点位标识长度上限（后端 `AlertRulePointReq.propertyId` 的 `@Size(max = 64)`）。 */
export const CONDITION_PROPERTY_ID_MAX_LENGTH = 64;

/** 阈值/回差长度上限（后端 `AlertRulePointReq` 的 `@Size(max = 40)`）。 */
export const CONDITION_NUMBER_MAX_LENGTH = 40;

/** 比较符白名单（后端 `AlertOperator`）。 */
export const CONDITION_OPERATORS = [
  'GT',
  'GTE',
  'LT',
  'LTE',
  'EQ',
  'NE',
] as const;

/** 比较域白名单（后端 `AlertValueType`）。 */
export const CONDITION_VALUE_TYPES = ['NUMERIC', 'BOOLEAN'] as const;

/** 布尔点位只允许的比较符（后端 `buildPoint`）。 */
export const BOOLEAN_OPERATORS = ['EQ', 'NE'] as const;

/**
 * 严格十进制解析：与后端 `new BigDecimal(raw.trim())` 对齐，拒绝 NaN/Infinity/0x/空串/文本。
 *
 * 刻意与 `rule-preview.ts` 的 `parseNumericStrict` 用**同一个正则**：
 * 「预览说会触发、后端却拒收」这类口径漂移就是这么来的。
 */
export function isDecimalText(
  value: null | number | string | undefined,
): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  const text = String(value).trim();
  if (text === '') {
    return false;
  }
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text);
}

/** 表单里的一行条件（字段与后端 `AlertRulePointReq` 同名；`key` 仅 UI 用，不进请求）。 */
export interface ConditionRowDraft {
  /** 行内唯一键（仅前端 `v-for` 用；**绝不提交**）。 */
  key: string;
  /** 回差（字符串；空串 ⇒ 不提交该字段）。 */
  deadband: string;
  operator: string;
  propertyId: string;
  /** 阈值（**字符串**形态：前后端都不做隐式浮点转换，避免 1.10 变 1.1 之类的静默改写）。 */
  threshold: string;
  valueType: string;
}

/** 行键自增序号（同一页面生命周期内保证唯一，不依赖 random，便于用例复现）。 */
let rowKeySeq = 0;

/** 造一行空条件（`operator` 留空 ⇒ 校验会明确提示「请选择比较符」，不猜默认值）。 */
export function createConditionRow(
  init: Partial<Omit<ConditionRowDraft, 'key'>> = {},
): ConditionRowDraft {
  rowKeySeq += 1;
  return {
    deadband: '',
    operator: '',
    propertyId: '',
    threshold: '',
    valueType: 'NUMERIC',
    ...init,
    key: `condition-${rowKeySeq}`,
  };
}

/** 把规则的点位条件行**全部**回填成表单行（**不得只取第一行**——那正是本次要修的静默丢条件）。 */
export function parseConditionRows(
  points?: IotAlertApi.RulePointResp[],
): ConditionRowDraft[] {
  return (points ?? []).map((point) =>
    createConditionRow({
      deadband: point.deadband ?? '',
      // 未知比较符**原样保留**：校验会给出行级报错，而不是悄悄换成别的比较符
      operator: point.operator ?? '',
      propertyId: point.propertyId ?? '',
      threshold: point.threshold ?? '',
      // 后端比较域缺省即 NUMERIC（buildPoint 的 null/blank 兜底），这里同口径
      valueType: point.valueType ?? 'NUMERIC',
    }),
  );
}

/** 把表单行按**界面顺序**序列化成保存请求（空回差不提交该字段；行数=界面行数，绝不丢行）。 */
export function toConditionRequests(
  rows: ConditionRowDraft[],
): IotAlertApi.RulePointSaveReq[] {
  return rows.map((row) => {
    const deadband = row.deadband.trim();
    return {
      deadband: deadband === '' ? undefined : deadband,
      operator: row.operator.trim(),
      propertyId: row.propertyId.trim(),
      threshold: row.threshold.trim(),
      valueType: row.valueType,
    };
  });
}

/** 行级校验问题：`key` 是 i18n 键，`args` 是模板参数（行号从 1 开始）。 */
export interface ConditionRowIssue {
  args?: (number | string)[];
  /** 1 起的行号；作用域级问题（如「点位级规则至少 1 行」）为 0。 */
  index: number;
  key: string;
}

/** 校验选项。 */
export interface ConditionValidationOptions {
  maxPoints?: number;
  scopeType: string;
}

/**
 * 逐行校验（与后端 `buildPoint` 同口径），每行**只报第一条**问题（避免一次糊一屏）。
 *
 * 另加两条后端**不做但前端必须拦**的检查（理由见模块头注释）：
 * 1. 同一 `propertyId` 重复 ⇒ 后端唯一键会静默合并，必须阻断；
 * 2. 行数超上限 ⇒ 与后端同值，先拦避免白跑一次请求。
 */
export function validateConditionRows(
  rows: ConditionRowDraft[],
  options: ConditionValidationOptions,
): ConditionRowIssue[] {
  const issues: ConditionRowIssue[] = [];
  const maxPoints = options.maxPoints ?? MAX_POINTS_PER_RULE;
  if (rows.length > maxPoints) {
    issues.push({
      args: [maxPoints],
      index: 0,
      key: 'page.iot.alert.rule.condition.tooMany',
    });
  }
  // 点位级规则至少一个条件（后端 validate() 第 269-272 行）
  if (options.scopeType === 'POINT' && rows.length === 0) {
    issues.push({
      index: 0,
      key: 'page.iot.alert.rule.condition.needOne',
    });
  }

  rows.forEach((row, position) => {
    const index = position + 1;
    const propertyId = row.propertyId.trim();
    if (propertyId === '') {
      issues.push({
        args: [index],
        index,
        key: 'page.iot.alert.rule.condition.needProperty',
      });
      return;
    }
    if (propertyId.length > CONDITION_PROPERTY_ID_MAX_LENGTH) {
      issues.push({
        args: [index, CONDITION_PROPERTY_ID_MAX_LENGTH],
        index,
        key: 'page.iot.alert.rule.condition.propertyTooLong',
      });
      return;
    }
    const operator = row.operator.trim().toUpperCase();
    if (!(CONDITION_OPERATORS as readonly string[]).includes(operator)) {
      issues.push({
        args: [index],
        index,
        key: 'page.iot.alert.rule.condition.needOperator',
      });
      return;
    }
    const valueType =
      row.valueType.trim().toUpperCase() === 'BOOLEAN' ? 'BOOLEAN' : 'NUMERIC';
    if (
      valueType === 'BOOLEAN' &&
      !(BOOLEAN_OPERATORS as readonly string[]).includes(operator)
    ) {
      issues.push({
        args: [index],
        index,
        key: 'page.iot.alert.rule.condition.booleanOperator',
      });
      return;
    }
    const threshold = row.threshold.trim();
    if (threshold === '') {
      issues.push({
        args: [index],
        index,
        key: 'page.iot.alert.rule.condition.needThreshold',
      });
      return;
    }
    if (threshold.length > CONDITION_NUMBER_MAX_LENGTH) {
      issues.push({
        args: [index, CONDITION_NUMBER_MAX_LENGTH],
        index,
        key: 'page.iot.alert.rule.condition.thresholdTooLong',
      });
      return;
    }
    if (!isDecimalText(threshold)) {
      issues.push({
        args: [index],
        index,
        key: 'page.iot.alert.rule.condition.thresholdNotNumber',
      });
      return;
    }
    if (valueType === 'BOOLEAN') {
      const parsed = Number(threshold);
      if (parsed !== 0 && parsed !== 1) {
        issues.push({
          args: [index],
          index,
          key: 'page.iot.alert.rule.condition.booleanThreshold',
        });
        return;
      }
    }
    const deadband = row.deadband.trim();
    if (deadband !== '') {
      if (deadband.length > CONDITION_NUMBER_MAX_LENGTH) {
        issues.push({
          args: [index, CONDITION_NUMBER_MAX_LENGTH],
          index,
          key: 'page.iot.alert.rule.condition.deadbandTooLong',
        });
        return;
      }
      if (!isDecimalText(deadband)) {
        issues.push({
          args: [index],
          index,
          key: 'page.iot.alert.rule.condition.deadbandNotNumber',
        });
        return;
      }
      if (Number(deadband) < 0) {
        issues.push({
          args: [index],
          index,
          key: 'page.iot.alert.rule.condition.deadbandNegative',
        });
      }
    }
  });

  // 重复点位：后端唯一键只含 propertyId ⇒ 同点位的多行只会留下一条（静默合并）
  const seen = new Set<string>();
  rows.forEach((row, position) => {
    const index = position + 1;
    const propertyId = row.propertyId.trim();
    if (propertyId === '') {
      return;
    }
    if (seen.has(propertyId)) {
      issues.push({
        args: [index, propertyId],
        index,
        key: 'page.iot.alert.rule.condition.duplicatePoint',
      });
      return;
    }
    seen.add(propertyId);
  });

  return issues;
}

/** 重复点位的行号（1 起；用于行内高亮）。 */
export function duplicatedRowIndexes(rows: ConditionRowDraft[]): number[] {
  const seen = new Set<string>();
  const duplicated: number[] = [];
  rows.forEach((row, position) => {
    const propertyId = row.propertyId.trim();
    if (propertyId === '') {
      return;
    }
    if (seen.has(propertyId)) {
      duplicated.push(position);
      return;
    }
    seen.add(propertyId);
  });
  return duplicated;
}
