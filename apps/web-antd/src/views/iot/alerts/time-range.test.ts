import { createApp } from 'vue';

import { beforeAll, describe, expect, it } from 'vitest';

import { $t } from '#/locales';

import { useInstanceFormSchema } from './data';
import {
  ALERT_TIME_RANGE_FORMAT,
  ALERT_TIME_RANGE_PATTERN,
  alertTimeRangePlaceholders,
  alertTimeRangeRule,
  isAlertTimeRangeEmpty,
  isAlertTimeRangeValid,
  resolveAlertTimeQuery,
} from './time-range';

/**
 * 「首次越界时间」范围筛选的纯逻辑用例。
 *
 * 守门的不变量：
 * 1. 传给后端的 from/to 必须是 `yyyy-MM-dd HH:mm:ss`（后端 `@DateTimeFormat` 同口径）；
 *    带 `T`/`Z` 的 ISO 串或时间戳属于**已知事故形态**（设备消息跟踪 400），必须判非法；
 * 2. 起点晚于终点 ⇒ 非法（表单层阻止提交，请求层兜底拦截）；
 * 3. 空值/只选一端 ⇒ 不并入查询（空值不传参；半截条件不得静默变成单边过滤）；
 * 4. 表单 schema 的 RangePicker 配置（valueFormat/showTime/rules/help）与口径一致。
 */

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

const VALID_RANGE = ['2026-10-01 00:00:00', '2026-10-02 12:30:00'];

describe('时间范围：合法性（格式 + 起止顺序）', () => {
  it('未选/空数组 ⇒ 合法（= 不限时间）', () => {
    expect(isAlertTimeRangeEmpty(undefined)).toBe(true);
    expect(isAlertTimeRangeEmpty(null)).toBe(true);
    expect(isAlertTimeRangeEmpty([])).toBe(true);
    expect(isAlertTimeRangeValid(undefined)).toBe(true);
    expect(isAlertTimeRangeValid([])).toBe(true);
  });

  it('★ 两端都是约定格式且 from ≤ to ⇒ 合法；相等也合法（同一时刻）', () => {
    expect(isAlertTimeRangeValid(VALID_RANGE)).toBe(true);
    expect(
      isAlertTimeRangeValid(['2026-10-02 12:30:00', '2026-10-02 12:30:00']),
    ).toBe(true);
  });

  it('★ 起点晚于终点 ⇒ 非法', () => {
    expect(
      isAlertTimeRangeValid(['2026-10-03 00:00:00', '2026-10-02 00:00:00']),
    ).toBe(false);
    // 同一天但时分秒更晚也非法（不是只比日期）
    expect(
      isAlertTimeRangeValid(['2026-10-02 10:00:00', '2026-10-02 09:59:59']),
    ).toBe(false);
  });

  it('★ 非约定格式（ISO 带 T/Z、时间戳、缺秒）一律非法', () => {
    for (const bad of [
      ['2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z'],
      ['1790000000000', '1790000000001'],
      ['2026-10-01 00:00', '2026-10-02 00:00'],
      ['2026/10/01 00:00:00', '2026/10/02 00:00:00'],
    ]) {
      expect(isAlertTimeRangeValid(bad), `应判非法：${bad.join(' ~ ')}`).toBe(
        false,
      );
    }
    // 契约正则的独立断言：4 位年-2 位月-2 位日 空格 2:2:2
    expect(ALERT_TIME_RANGE_PATTERN.test(VALID_RANGE[0] ?? '')).toBe(true);
    expect(ALERT_TIME_RANGE_PATTERN.test('2026-10-01T00:00:00.000Z')).toBe(
      false,
    );
  });

  it('★ 只选一端 ⇒ 非法（不得把半截范围变成单边过滤）', () => {
    expect(isAlertTimeRangeValid(['2026-10-01 00:00:00', undefined])).toBe(
      false,
    );
    expect(isAlertTimeRangeValid([undefined, '2026-10-02 00:00:00'])).toBe(
      false,
    );
    expect(isAlertTimeRangeValid(['2026-10-01 00:00:00', ''])).toBe(false);
  });
});

describe('时间范围：查询参数映射（空值不传 from/to）', () => {
  it('★ 合法范围 ⇒ {from,to} 原样且格式正确', () => {
    const query = resolveAlertTimeQuery(VALID_RANGE);
    expect(query).toEqual({
      from: '2026-10-01 00:00:00',
      to: '2026-10-02 12:30:00',
    });
    expect(query.from).toMatch(ALERT_TIME_RANGE_PATTERN);
    expect(query.to).toMatch(ALERT_TIME_RANGE_PATTERN);
  });

  it('★ 未选/清空 ⇒ 空对象（不传 from/to）', () => {
    expect(resolveAlertTimeQuery(undefined)).toEqual({});
    expect(resolveAlertTimeQuery([])).toEqual({});
  });

  it('★ 非法区间 ⇒ 空对象（请求层兜底：宁可不过滤，也不把非法时间发给后端）', () => {
    expect(
      resolveAlertTimeQuery(['2026-10-03 00:00:00', '2026-10-02 00:00:00']),
    ).toEqual({});
  });
});

describe('时间范围：表单校验规则与 schema 口径', () => {
  it('★ zod 规则：空值与合法区间通过，非法区间带 i18n 文案失败', () => {
    const rule = alertTimeRangeRule();
    expect(rule.safeParse(undefined).success).toBe(true);
    expect(rule.safeParse(VALID_RANGE).success).toBe(true);

    const failed = rule.safeParse([
      '2026-10-03 00:00:00',
      '2026-10-02 00:00:00',
    ]);
    expect(failed.success).toBe(false);
    expect(failed.error?.issues[0]?.message).toBe(
      $t('page.iot.alert.timeRangeInvalid'),
    );
  });

  it('placeholder 组合文案按 ~ 拆成两段（无硬编码文案）', () => {
    const [start, end] = alertTimeRangePlaceholders();
    expect(start.length).toBeGreaterThan(0);
    expect(end.length).toBeGreaterThan(0);
    expect(start).not.toContain('~');
    expect(end).not.toContain('~');
  });

  it('★ schema：RangePicker + showTime + valueFormat 与后端在 DateTimeFormat 同口径 + 校验规则', () => {
    const field = useInstanceFormSchema().find(
      (item) => item.fieldName === 'firstTsRange',
    );
    expect(field, '筛选表单缺少「首次越界时间」字段').toBeTruthy();
    expect(field?.component).toBe('RangePicker');
    expect(field?.componentProps?.valueFormat).toBe(ALERT_TIME_RANGE_FORMAT);
    expect(ALERT_TIME_RANGE_FORMAT).toBe('YYYY-MM-DD HH:mm:ss');
    expect(field?.componentProps?.showTime).toBeTruthy();
    expect(field?.componentProps?.allowClear).toBe(true);
    expect(field?.label).toBe($t('page.iot.alert.timeRange'));
    expect(field?.help).toBe($t('page.iot.alert.timeRangeHint'));
    expect(field?.rules).toBeTruthy();
  });
});
