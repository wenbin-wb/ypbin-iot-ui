import type { ListState } from '../shared/list-state';

import { resolveListState } from '../shared/list-state';

/**
 * 平台告警列表的**纯逻辑**（状态/级别的 label 与颜色、列表态判定）。
 */

/** 状态 ⇒ 展示键（与后端 PlatformAlertState 对齐）。 */
export function platformAlertStateLabelKey(state?: string): string {
  switch (state) {
    case 'FIRING': {
      return 'page.iot.platformAlert.state.firing';
    }
    case 'PENDING': {
      return 'page.iot.platformAlert.state.pending';
    }
    case 'RESOLVED': {
      return 'page.iot.platformAlert.state.resolved';
    }
    default: {
      return 'page.iot.platformAlert.state.unknown';
    }
  }
}

/** 状态 ⇒ 标签颜色（沿用设备告警口径）。 */
export function platformAlertStateColor(state?: string): string {
  switch (state) {
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

/** 级别 ⇒ 展示键（与后端 PlatformSeverity 对齐）。 */
export function platformAlertSeverityLabelKey(severity?: string): string {
  switch (severity) {
    case 'CRITICAL': {
      return 'page.iot.platformAlert.severity.critical';
    }
    case 'WARNING': {
      return 'page.iot.platformAlert.severity.warning';
    }
    default: {
      return 'page.iot.platformAlert.severity.unknown';
    }
  }
}

/** 级别 ⇒ 标签颜色。 */
export function platformAlertSeverityColor(severity?: string): string {
  return severity === 'CRITICAL' ? 'error' : 'default';
}

/** 列表展示态（错误优先于空；判据收口到 shared/list-state）。 */
export type PlatformAlertListState = ListState;

export function resolvePlatformAlertListState(
  loading: boolean,
  errorMessage: string,
  itemCount: number,
): PlatformAlertListState {
  return resolveListState({ errorMessage, itemCount, loading });
}
