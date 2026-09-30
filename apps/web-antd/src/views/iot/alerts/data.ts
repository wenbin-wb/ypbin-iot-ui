import type { VxeTableGridColumns } from '#/adapter/vxe-table';
import type { IotAlertApi } from '#/api/iot';

import { getDeviceOptions } from '#/api/iot';
import { $t } from '#/locales';

/** 状态码 → 展示文案的键（后端只回码，文案在前端）。 */
export function stateLabelKey(state?: string): string {
  switch (state) {
    case 'ACKED': {
      return 'page.iot.alert.state.acked';
    }
    case 'FIRING': {
      return 'page.iot.alert.state.firing';
    }
    case 'PENDING': {
      return 'page.iot.alert.state.pending';
    }
    case 'RESOLVED': {
      return 'page.iot.alert.state.resolved';
    }
    default: {
      return 'page.iot.alert.state.unknown';
    }
  }
}

/** 状态码 → Tag 颜色（与 `CellTag` 的 `color` 取值一致）。 */
export function stateColor(state?: string): string {
  switch (state) {
    case 'ACKED': {
      return 'processing';
    }
    case 'FIRING': {
      return 'error';
    }
    case 'PENDING': {
      return 'warning';
    }
    case 'RESOLVED': {
      return 'success';
    }
    default: {
      return 'default';
    }
  }
}

/** 级别码 → 展示文案的键。 */
export function severityLabelKey(severity?: string): string {
  switch (severity) {
    case 'CRITICAL': {
      return 'page.iot.alert.severity.critical';
    }
    case 'INFO': {
      return 'page.iot.alert.severity.info';
    }
    case 'WARNING': {
      return 'page.iot.alert.severity.warning';
    }
    default: {
      return 'page.iot.alert.severity.unknown';
    }
  }
}

/** 级别码 → Tag 颜色。 */
export function severityColor(severity?: string): string {
  switch (severity) {
    case 'CRITICAL': {
      return 'error';
    }
    case 'INFO': {
      return 'processing';
    }
    case 'WARNING': {
      return 'warning';
    }
    default: {
      return 'default';
    }
  }
}

/** 通知事件码 → 文案键。 */
export function eventLabelKey(event?: string): string {
  switch (event) {
    case 'ACKED': {
      return 'page.iot.alert.event.acked';
    }
    case 'FIRING': {
      return 'page.iot.alert.event.firing';
    }
    case 'REPEAT': {
      return 'page.iot.alert.event.repeat';
    }
    case 'RESOLVED': {
      return 'page.iot.alert.event.resolved';
    }
    default: {
      return 'page.iot.alert.event.unknown';
    }
  }
}

/** 投递状态码 → 文案键。 */
export function notifyStatusLabelKey(status?: string): string {
  switch (status) {
    case 'FAILED': {
      return 'page.iot.alert.notify.failed';
    }
    case 'GIVEN_UP': {
      return 'page.iot.alert.notify.givenUp';
    }
    case 'PENDING': {
      return 'page.iot.alert.notify.pending';
    }
    case 'SENT': {
      return 'page.iot.alert.notify.sent';
    }
    default: {
      return 'page.iot.alert.notify.unknown';
    }
  }
}

/** 结束原因码 → 文案键。 */
export function reasonLabelKey(reason?: string): string {
  switch (reason) {
    case 'OUTAGE_RECOVERED': {
      return 'page.iot.alert.reason.outageRecovered';
    }
    case 'RECOVERED': {
      return 'page.iot.alert.reason.recovered';
    }
    case 'RULE_DISABLED': {
      return 'page.iot.alert.reason.ruleDisabled';
    }
    default: {
      return 'page.iot.alert.reason.unknown';
    }
  }
}

/** 作用域码 → 文案键。 */
export function scopeLabelKey(scope?: string): string {
  switch (scope) {
    case 'DEVICE': {
      return 'page.iot.alert.scope.device';
    }
    case 'POINT': {
      return 'page.iot.alert.scope.point';
    }
    case 'PRODUCT': {
      return 'page.iot.alert.scope.product';
    }
    case 'TENANT': {
      return 'page.iot.alert.scope.tenant';
    }
    default: {
      return 'page.iot.alert.scope.unknown';
    }
  }
}

/** 秒 → 「1h2m3s」式人话（与设备详情里的 `human()` 同一形态，避免两处口径不一致）。 */
export function humanSeconds(seconds?: null | number | string): string {
  const total = Number(seconds ?? 0);
  if (!Number.isFinite(total) || total <= 0) {
    return '0s';
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (secs > 0 && hours === 0) {
    parts.push(`${secs}s`);
  }
  return parts.length > 0 ? parts.join('') : '0s';
}

/** 告警列表列（含展开行：触发值/阈值/时间线/投递记录/曲线缩略在展开内容里）。 */
export function useInstanceColumns(): VxeTableGridColumns {
  return [
    // 勾选列必须**显式声明**：vxe 不会因为 `checkboxConfig` 自动生成勾选列
    // （独立复核 2026-10-03 用 vxe-table + happy-dom 真实挂载 A/B 探针证实：
    //  只有 checkboxConfig 时 checkbox 单元格数 = 0，加本列后 = 行数）
    { type: 'checkbox', width: 46 },
    { type: 'expand', width: 46, slots: { content: 'expand' } },
    {
      field: 'severity',
      title: $t('page.iot.alert.severityField'),
      width: 90,
    },
    { field: 'state', title: $t('page.iot.alert.stateField'), width: 100 },
    { field: 'deviceName', title: $t('page.iot.device.name'), minWidth: 140 },
    { field: 'propertyId', title: $t('page.iot.alert.property'), width: 140 },
    {
      field: 'triggerValue',
      title: $t('page.iot.alert.triggerValue'),
      width: 110,
    },
    {
      field: 'thresholdSnapshot',
      title: $t('page.iot.alert.threshold'),
      width: 110,
    },
    { field: 'startTs', title: $t('page.iot.alert.startTs'), width: 170 },
    {
      field: 'durationSeconds',
      title: $t('page.iot.alert.duration'),
      width: 100,
      slots: { default: 'duration' },
    },
    {
      field: 'ruleName',
      title: $t('page.iot.alert.ruleName'),
      minWidth: 140,
      slots: { default: 'rule' },
    },
    {
      align: 'center',
      field: 'action',
      fixed: 'right',
      slots: { default: 'action' },
      title: $t('common.action'),
      width: 220,
    },
  ];
}

/** 告警列表筛选（状态/级别/设备/时间范围）。 */
export type InstanceFilterInitial = {
  deviceId?: string;
  severity?: string;
  state?: string;
};

/** 告警实例搜索表单 schema（看板 #12「筛选持久化」）：接受持久化初始值（defaultValue 注入），首次进入即回填上次筛选；值已过 sanitizeFilter「不信任存储」校验（见 shared/list-filter.ts）。 */
export function useInstanceFormSchema(initial?: InstanceFilterInitial) {
  const init = initial ?? {};
  return [
    {
      component: 'Select',
      componentProps: {
        allowClear: true,
        options: [
          { label: $t('page.iot.alert.state.firing'), value: 'FIRING' },
          { label: $t('page.iot.alert.state.acked'), value: 'ACKED' },
          { label: $t('page.iot.alert.state.pending'), value: 'PENDING' },
          { label: $t('page.iot.alert.state.resolved'), value: 'RESOLVED' },
        ],
        placeholder: $t('page.iot.alert.allStates'),
      },
      fieldName: 'state',
      defaultValue: init.state,
      label: $t('page.iot.alert.stateField'),
    },
    {
      component: 'Select',
      componentProps: {
        allowClear: true,
        options: [
          { label: $t('page.iot.alert.severity.critical'), value: 'CRITICAL' },
          { label: $t('page.iot.alert.severity.warning'), value: 'WARNING' },
          { label: $t('page.iot.alert.severity.info'), value: 'INFO' },
        ],
        placeholder: $t('page.iot.alert.allSeverities'),
      },
      fieldName: 'severity',
      defaultValue: init.severity,
      label: $t('page.iot.alert.severityField'),
    },
    {
      component: 'ApiSelect',
      componentProps: {
        allowClear: true,
        api: getDeviceOptions,
        labelField: 'deviceName',
        placeholder: $t('page.iot.alert.allDevices'),
        showSearch: true,
        valueField: 'id',
      },
      fieldName: 'deviceId',
      defaultValue: init.deviceId,
      label: $t('page.iot.device.name'),
    },
  ];
}

/** 规则列表列。 */
export function useRuleColumns(): VxeTableGridColumns {
  return [
    // 同上：批量启用/停用依赖这一列，缺了它按钮会永久禁用（先例见 useInstanceColumns）
    { type: 'checkbox', width: 46 },
    { field: 'ruleName', title: $t('page.iot.alert.ruleName'), minWidth: 160 },
    {
      field: 'scopeType',
      title: $t('page.iot.alert.scopeTitle'),
      width: 100,
      slots: { default: 'scope' },
    },
    {
      field: 'deviceName',
      title: $t('page.iot.alert.scopeTarget'),
      minWidth: 150,
      slots: { default: 'scopeTarget' },
    },
    {
      field: 'severity',
      title: $t('page.iot.alert.severityField'),
      width: 90,
      slots: { default: 'severity' },
    },
    {
      field: 'points',
      title: $t('page.iot.alert.condition'),
      minWidth: 220,
      slots: { default: 'condition' },
    },
    {
      field: 'notifyTargets',
      title: $t('page.iot.alert.notify.title'),
      width: 140,
      slots: { default: 'notifyRisk' },
    },
    {
      field: 'enabled',
      title: $t('page.iot.alert.enabled'),
      width: 90,
      slots: { default: 'enabled' },
    },
    {
      field: 'activeCount',
      title: $t('page.iot.alert.activeCount'),
      width: 110,
    },
    { field: 'updateTime', title: $t('page.iot.alert.updateTime'), width: 170 },
    {
      align: 'center',
      field: 'action',
      fixed: 'right',
      slots: { default: 'action' },
      title: $t('common.action'),
      width: 200,
    },
  ];
}

/** 规则一行的人话条件（表格单元格用：断档类显示「设备离线/数据中断」）。 */
export function conditionText(rule: IotAlertApi.RuleResp): string {
  if (!rule.points || rule.points.length === 0) {
    return $t('page.iot.alert.kind.offline');
  }
  return rule.points
    .map((point) => {
      const symbol =
        {
          EQ: '=',
          GT: '>',
          GTE: '>=',
          LT: '<',
          LTE: '<=',
          NE: '!=',
        }[point.operator] ?? point.operator;
      const extra = Number(point.deadband ?? 0) ? ` (±${point.deadband})` : '';
      return `${point.propertyId} ${symbol} ${point.threshold}${extra}`;
    })
    .join(' / ');
}

/** 规则作用域对象（表格单元格用）。 */
export function scopeTargetText(rule: IotAlertApi.RuleResp): string {
  switch (rule.scopeType) {
    case 'DEVICE':
    case 'POINT': {
      return (
        rule.deviceName ?? rule.deviceCode ?? String(rule.scopeDeviceId ?? '-')
      );
    }
    case 'PRODUCT': {
      return rule.productName ?? String(rule.scopeProductId ?? '-');
    }
    case 'TENANT': {
      return $t('page.iot.alert.scope.tenant');
    }
    default: {
      return '-';
    }
  }
}

export type InstanceRow = IotAlertApi.InstanceResp;
export type RuleRow = IotAlertApi.RuleResp;
