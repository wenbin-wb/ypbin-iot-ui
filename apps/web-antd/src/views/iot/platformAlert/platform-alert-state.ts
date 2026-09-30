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

/** 列表展示态（错误优先于空）。 */
export type PlatformAlertListState = 'empty' | 'error' | 'loading' | 'ready';

export function resolvePlatformAlertListState(
  loading: boolean,
  errorMessage: string,
  itemCount: number,
): PlatformAlertListState {
  if (loading) {
    return 'loading';
  }
  if (errorMessage) {
    return 'error';
  }
  return itemCount > 0 ? 'ready' : 'empty';
}

/** 时间展示（空给 -，避免 undefined）。 */
export function tsLabel(ts?: string): string {
  return ts || '-';
}

/** 指标快照：非空且是 JSON 对象时格式化（展示用）；空给 -。 */
export function snapshotLabel(snapshot?: string): string {
  if (!snapshot) {
    return '-';
  }
  try {
    const parsed = JSON.parse(snapshot) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
    return snapshot;
  } catch {
    return snapshot;
  }
}
