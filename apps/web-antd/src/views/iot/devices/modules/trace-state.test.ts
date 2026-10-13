import { describe, expect, it } from 'vitest';

import {
  directionLabelKey,
  DISCARD_REASON,
  formatDiscardDetail,
  formatPersistedAt,
  formatTraceTime,
  hasAdvice,
  hasBatchInfo,
  needsAttention,
  needsRetryHint,
  outcomeColor,
  outcomeLabelKey,
  RECEIPT_STATUS,
  receiptStatusColor,
  receiptStatusLabelKey,
  resolveDiscardAdvice,
  resolveTraceListState,
  showsTruncationHint,
  stageLabelKey,
  TRACE_RULE,
} from './trace-state';

/**
 * 消息跟踪页纯逻辑用例。
 *
 * 重点锁死三件事：
 * 1. **失败态优先于空态**——请求失败绝不能画成「这台设备最近没有消息」（本仓踩过的假空态）；
 * 2. **能力边界要能表达**——上行链路一期有看不见的断点，页面必须显式说明；
 * 3. **未知不等于失败**——上行受理在业务上就是 unknown，标红会让用户以为每次上报都出错。
 */

const baseItem = {
  occurredAt: '2026-09-30T10:00:00',
  outcome: 'ok',
  stage: 'down-ack',
  direction: 'down',
  title: '下发：temperature',
} as const;

describe('resolveTraceListState（失败态优先于空态）', () => {
  it('加载中优先于一切', () => {
    expect(resolveTraceListState(true, 'boom', 5)).toBe('loading');
  });

  it('🔴 请求失败时必须判为 error，不得画成空态', () => {
    expect(resolveTraceListState(false, '网络错误', 0)).toBe('error');
    // 已有旧数据时刷新失败，仍然是 error
    expect(resolveTraceListState(false, '网络错误', 7)).toBe('error');
  });

  it('确实没有数据时才是空态', () => {
    expect(resolveTraceListState(false, '', 0)).toBe('empty');
  });

  it('有数据且无错误时为 ready', () => {
    expect(resolveTraceListState(false, '', 3)).toBe('ready');
  });
});

describe('outcomeColor（未知不等于失败）', () => {
  it('成功/失败/超时各自有语义颜色', () => {
    expect(outcomeColor('ok')).toBe('success');
    expect(outcomeColor('failed')).toBe('error');
    expect(outcomeColor('timeout')).toBe('warning');
  });

  it('🔴 unknown 用中性色而不是红色（一期"上行已受理"就是 unknown）', () => {
    expect(outcomeColor('unknown')).toBe('default');
    expect(outcomeColor(undefined)).toBe('default');
    expect(outcomeColor('future-code')).toBe('default');
  });
});

describe('outcomeLabelKey / directionLabelKey / stageLabelKey', () => {
  it('四种结果各自映射到自己的键', () => {
    expect(outcomeLabelKey('ok')).toBe('page.iot.device.trace.outcomeOk');
    expect(outcomeLabelKey('failed')).toBe(
      'page.iot.device.trace.outcomeFailed',
    );
    expect(outcomeLabelKey('timeout')).toBe(
      'page.iot.device.trace.outcomeTimeout',
    );
    expect(outcomeLabelKey('unknown')).toBe(
      'page.iot.device.trace.outcomeUnknown',
    );
  });

  it('未知结果回落到 unknown 键，绝不返回空串（空标签比"未知"更糟）', () => {
    expect(outcomeLabelKey(undefined)).toBe(
      'page.iot.device.trace.outcomeUnknown',
    );
    expect(outcomeLabelKey('zzz')).toBe('page.iot.device.trace.outcomeUnknown');
  });

  it('方向码映射（含 internal 回落）', () => {
    expect(directionLabelKey('up')).toBe('page.iot.device.trace.directionUp');
    expect(directionLabelKey('down')).toBe(
      'page.iot.device.trace.directionDown',
    );
    expect(directionLabelKey('internal')).toBe(
      'page.iot.device.trace.directionInternal',
    );
    expect(directionLabelKey('weird')).toBe(
      'page.iot.device.trace.directionInternal',
    );
  });

  it('八个阶段各自映射（含二批 persisted/discarded）', () => {
    expect(stageLabelKey('down-enqueued')).toBe(
      'page.iot.device.trace.stageDownEnqueued',
    );
    expect(stageLabelKey('down-published')).toBe(
      'page.iot.device.trace.stageDownPublished',
    );
    expect(stageLabelKey('down-ack')).toBe(
      'page.iot.device.trace.stageDownAck',
    );
    expect(stageLabelKey('up-received')).toBe(
      'page.iot.device.trace.stageUpReceived',
    );
    expect(stageLabelKey('event-reported')).toBe(
      'page.iot.device.trace.stageEventReported',
    );
    expect(stageLabelKey('device-offline')).toBe(
      'page.iot.device.trace.stageDeviceOffline',
    );
    expect(stageLabelKey('up-persisted')).toBe(
      'page.iot.device.trace.stageUpPersisted',
    );
    expect(stageLabelKey('up-discarded')).toBe(
      'page.iot.device.trace.stageUpDiscarded',
    );
  });

  it('二批新增阶段未知码仍回落 unknown', () => {
    expect(stageLabelKey('up-future')).toBe(
      'page.iot.device.trace.stageUnknown',
    );
  });
});

describe('needsRetryHint（重发会覆写时间戳，必须提示）', () => {
  it('服务端标记优先', () => {
    expect(needsRetryHint({ ...baseItem, historyOverwritten: true })).toBe(
      true,
    );
  });

  it('字段缺失时回落到 retryCount（宁可多提示）', () => {
    expect(needsRetryHint({ ...baseItem, retryCount: 2 })).toBe(true);
    expect(needsRetryHint({ ...baseItem, retryCount: 0 })).toBe(false);
  });

  it('两个字段都缺失时不提示', () => {
    expect(needsRetryHint({ ...baseItem })).toBe(false);
  });

  it('脏数据不炸', () => {
    expect(needsRetryHint({ ...baseItem, retryCount: 'abc' as never })).toBe(
      false,
    );
  });
});

describe('hasAdvice（没有动作的建议等于没有建议）', () => {
  it('有 summary 且有动作才算可展示', () => {
    expect(
      hasAdvice({
        ...baseItem,
        advice: { ruleId: 'R', summary: '结论', actions: ['做 A'] },
      }),
    ).toBe(true);
  });

  it('只有 summary、没有动作 ⇒ 不展示', () => {
    expect(
      hasAdvice({
        ...baseItem,
        advice: { ruleId: 'R', summary: '结论', actions: [] },
      }),
    ).toBe(false);
  });

  it('没有 advice ⇒ 不展示', () => {
    expect(hasAdvice({ ...baseItem })).toBe(false);
  });
});

describe('showsTruncationHint（不静默截断）', () => {
  it('truncated 为 true 时提示', () => {
    expect(
      showsTruncationHint({
        deviceId: 1,
        items: [],
        matched: 900,
        truncated: true,
        upstreamTraceUnavailable: true,
      }),
    ).toBe(true);
  });

  it('未截断或无响应时不提示', () => {
    expect(
      showsTruncationHint({
        deviceId: 1,
        items: [],
        matched: 1,
        truncated: false,
        upstreamTraceUnavailable: true,
      }),
    ).toBe(false);
    expect(showsTruncationHint(null)).toBe(false);
    expect(showsTruncationHint(undefined)).toBe(false);
  });
});

describe('needsAttention', () => {
  it('失败与超时需要关注', () => {
    expect(needsAttention({ ...baseItem, outcome: 'failed' })).toBe(true);
    expect(needsAttention({ ...baseItem, outcome: 'timeout' })).toBe(true);
  });

  it('🔴 unknown 的上行条目不需要关注（否则每次上报都像出错）', () => {
    expect(needsAttention({ ...baseItem, outcome: 'unknown' })).toBe(false);
    expect(needsAttention({ ...baseItem, outcome: 'ok' })).toBe(false);
  });
});

describe('formatTraceTime', () => {
  it('正常时间格式化', () => {
    expect(formatTraceTime('2026-09-30T10:20:30')).toBe('2026-09-30 10:20:30');
  });

  it('空/非法值回落为占位符（不渲染 Invalid Date）', () => {
    expect(formatTraceTime()).toBe('-');
    expect(formatTraceTime(null)).toBe('-');
    expect(formatTraceTime('')).toBe('-');
    expect(formatTraceTime('not-a-date')).toBe('-');
  });
});

// ---------------------------------------------------------------------------
// 二批（上行结构化补齐）：批次字段 / 3 条原因码规则 / 诚实性红线
// ---------------------------------------------------------------------------

describe('receiptStatusLabelKey / receiptStatusColor（批次性质）', () => {
  it('已受理/已拒绝各自映射', () => {
    expect(receiptStatusLabelKey(RECEIPT_STATUS.ACCEPTED)).toBe(
      'page.iot.device.trace.receiptAccepted',
    );
    expect(receiptStatusLabelKey(RECEIPT_STATUS.REJECTED)).toBe(
      'page.iot.device.trace.receiptRejected',
    );
    expect(receiptStatusColor(RECEIPT_STATUS.ACCEPTED)).toBe('success');
    expect(receiptStatusColor(RECEIPT_STATUS.REJECTED)).toBe('error');
  });

  it('缺失/未知性质回落到「批次信息未知」，绝不返回空串', () => {
    expect(receiptStatusLabelKey(null)).toBe(
      'page.iot.device.trace.receiptUnknown',
    );
    expect(receiptStatusLabelKey(undefined)).toBe(
      'page.iot.device.trace.receiptUnknown',
    );
    expect(receiptStatusLabelKey('zzz')).toBe(
      'page.iot.device.trace.receiptUnknown',
    );
    expect(receiptStatusColor('zzz')).toBe('default');
  });
});

describe('hasBatchInfo（没有批次字段的下行/事件条目要显示占位）', () => {
  it('任一二批字段存在即显示', () => {
    expect(hasBatchInfo({ ...baseItem })).toBe(false);
    expect(
      hasBatchInfo({ ...baseItem, receiptStatus: RECEIPT_STATUS.ACCEPTED }),
    ).toBe(true);
    expect(hasBatchInfo({ ...baseItem, receivedCount: 0 })).toBe(true);
    expect(hasBatchInfo({ ...baseItem, persistedRows: 0 })).toBe(true);
    expect(
      hasBatchInfo({
        ...baseItem,
        discardReason: DISCARD_REASON.DEVICE_NOT_FOUND,
      }),
    ).toBe(true);
    expect(hasBatchInfo({ ...baseItem, discardDetail: 'a,b' })).toBe(true);
  });
});

describe('formatPersistedAt（🔴 persistedAt 为空绝不显示假时间）', () => {
  it('有值才格式化', () => {
    expect(
      formatPersistedAt({ ...baseItem, persistedAt: '2026-09-30T10:20:30' }),
    ).toBe('2026-09-30 10:20:30');
  });

  it('persistedAt 缺失时返回占位符，不得回退到 occurredAt/其它时间列', () => {
    expect(
      formatPersistedAt({
        ...baseItem,
        occurredAt: '2026-09-30T10:00:00',
        persistedAt: null,
      }),
    ).toBe('-');
    expect(
      formatPersistedAt({ ...baseItem, occurredAt: '2026-09-30T10:00:00' }),
    ).toBe('-');
    expect(formatPersistedAt({ ...baseItem, persistedAt: 'not-a-date' })).toBe(
      '-',
    );
  });
});

describe('formatDiscardDetail（🔴 后端截断后缀原样显示）', () => {
  it('逗号明细与 ,...(+N) 后缀逐字透传', () => {
    const detail = 'p1,p2,p3,p4,p5,p6,p7,p8,...(+12)';
    expect(formatDiscardDetail(detail)).toBe(detail);
    expect(formatDiscardDetail(detail)).toContain(',...(+12)');
  });

  it('空值返回空串，不编造内容', () => {
    expect(formatDiscardDetail(null)).toBe('');
    expect(formatDiscardDetail(undefined)).toBe('');
  });
});

describe('resolveDiscardAdvice（3 条原因码定位规则）', () => {
  it('规则 1：rejected + DEVICE_NOT_FOUND ⇒ UP_DEVICE_NOT_FOUND', () => {
    const advice = resolveDiscardAdvice({
      ...baseItem,
      receiptStatus: RECEIPT_STATUS.REJECTED,
      discardReason: DISCARD_REASON.DEVICE_NOT_FOUND,
    });
    expect(advice?.ruleId).toBe(TRACE_RULE.UP_DEVICE_NOT_FOUND);
    expect(advice?.summaryKey).toBe(
      'page.iot.device.trace.adviceUpDeviceNotFoundSummary',
    );
    expect(advice?.actionKeys.length).toBeGreaterThan(0);
  });

  it('规则 2：rejected + NO_ACCEPTED_ITEM ⇒ UP_REJECTED_MAP（点位未映射）', () => {
    const advice = resolveDiscardAdvice({
      ...baseItem,
      receiptStatus: RECEIPT_STATUS.REJECTED,
      discardReason: DISCARD_REASON.NO_ACCEPTED_ITEM,
    });
    expect(advice?.ruleId).toBe(TRACE_RULE.UP_REJECTED_MAP);
    expect(advice?.summaryKey).toBe(
      'page.iot.device.trace.adviceUpRejectedMapSummary',
    );
    expect(advice?.actionKeys.length).toBeGreaterThan(0);
  });

  it('规则 3：accepted 且 receivedCount > persistedRows ⇒ UP_PARTIAL（部分丢弃）', () => {
    const advice = resolveDiscardAdvice({
      ...baseItem,
      receiptStatus: RECEIPT_STATUS.ACCEPTED,
      receivedCount: 10,
      persistedRows: 7,
    });
    expect(advice?.ruleId).toBe(TRACE_RULE.UP_PARTIAL);
    expect(advice?.summaryKey).toBe(
      'page.iot.device.trace.adviceUpPartialSummary',
    );
    expect(advice?.actionKeys.length).toBeGreaterThan(0);
  });

  it('全部落库 / 无丢弃 ⇒ 不产出规则', () => {
    expect(
      resolveDiscardAdvice({
        ...baseItem,
        receiptStatus: RECEIPT_STATUS.ACCEPTED,
        receivedCount: 10,
        persistedRows: 10,
      }),
    ).toBeNull();
    expect(
      resolveDiscardAdvice({
        ...baseItem,
        receiptStatus: RECEIPT_STATUS.ACCEPTED,
        receivedCount: 0,
        persistedRows: 0,
      }),
    ).toBeNull();
  });

  it('🔴 未知原因码不硬凑建议（返回 null，由页面显式「暂无定位建议」）', () => {
    expect(
      resolveDiscardAdvice({
        ...baseItem,
        receiptStatus: RECEIPT_STATUS.REJECTED,
        discardReason: 'QUALITY_INVALID',
      }),
    ).toBeNull();
  });

  it('🔴 条数缺失/脏数据不得被误判为部分丢弃', () => {
    expect(
      resolveDiscardAdvice({
        ...baseItem,
        receiptStatus: RECEIPT_STATUS.ACCEPTED,
        receivedCount: null,
        persistedRows: null,
      }),
    ).toBeNull();
    expect(
      resolveDiscardAdvice({
        ...baseItem,
        receiptStatus: RECEIPT_STATUS.ACCEPTED,
        receivedCount: 'abc' as never,
        persistedRows: 1,
      }),
    ).toBeNull();
  });

  it('无任何批次字段（下行/事件）⇒ null', () => {
    expect(resolveDiscardAdvice({ ...baseItem })).toBeNull();
  });
});
