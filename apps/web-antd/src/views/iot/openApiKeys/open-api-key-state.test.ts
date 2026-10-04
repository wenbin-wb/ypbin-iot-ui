import { describe, expect, it } from 'vitest';

import {
  checkOpenApiKeyForm,
  isOpenApiKeyEnabled,
  normalizeOpenApiKeyForm,
  OPEN_API_ALLOWED_SCOPES,
  openApiKeyScopesLabel,
  openApiKeyStatusColor,
  openApiKeyStatusLabelKey,
  openApiKeyTimeLabel,
  openApiKeyUsageKind,
  openApiKeyUsageLabel,
  openApiKeyUsagePercent,
  resolveOpenApiKeyListState,
} from './open-api-key-state';

describe('checkOpenApiKeyForm', () => {
  it('应用名为空时拒绝（含全空白）', () => {
    expect(checkOpenApiKeyForm('', ['iot:series:get']).ok).toBe(false);
    expect(checkOpenApiKeyForm('   ', ['iot:series:get']).ok).toBe(false);
  });

  it('未选作用域时拒绝', () => {
    expect(checkOpenApiKeyForm('app-a', []).ok).toBe(false);
  });

  it('白名单外的作用域被拒绝', () => {
    const result = checkOpenApiKeyForm('app-a', ['iot:*']);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('iot:*');
  });

  it('高危作用域允许显式勾选（不默认，但不拦）', () => {
    expect(
      checkOpenApiKeyForm('app-a', ['iot:series:get', 'iot:debug:send']).ok,
    ).toBe(true);
  });

  it('qps 非正数 / 配额负数被拒绝', () => {
    expect(checkOpenApiKeyForm('app-a', ['iot:series:get'], 0).ok).toBe(false);
    expect(checkOpenApiKeyForm('app-a', ['iot:series:get'], -1).ok).toBe(false);
    expect(
      checkOpenApiKeyForm('app-a', ['iot:series:get'], undefined, -1).ok,
    ).toBe(false);
  });

  it('合法表单通过', () => {
    expect(
      checkOpenApiKeyForm('app-a', ['iot:series:get'], 10, 100_000).ok,
    ).toBe(true);
  });
});

describe('normalizeOpenApiKeyForm', () => {
  it('trim 应用名、scopes 去重去空', () => {
    const result = normalizeOpenApiKeyForm('  app-a ', [
      'iot:series:get',
      ' ',
      'iot:series:get',
      'iot:alert:list',
    ]);
    expect(result).toEqual({
      appName: 'app-a',
      scopes: 'iot:series:get,iot:alert:list',
    });
  });

  it('不改入参', () => {
    const scopes = ['iot:series:get'];
    normalizeOpenApiKeyForm('app-a', scopes);
    expect(scopes).toEqual(['iot:series:get']);
  });
});

describe('resolveOpenApiKeyListState', () => {
  it('失败态优先于空态', () => {
    expect(resolveOpenApiKeyListState(false, 'boom', 0)).toBe('error');
    expect(resolveOpenApiKeyListState(true, 'boom', 0)).toBe('loading');
    expect(resolveOpenApiKeyListState(false, '', 0)).toBe('empty');
    expect(resolveOpenApiKeyListState(false, '', 2)).toBe('ready');
  });
});

describe('status helpers', () => {
  it('1=启用，其余一律停用（含未知值回落）', () => {
    expect(isOpenApiKeyEnabled(1)).toBe(true);
    expect(isOpenApiKeyEnabled(0)).toBe(false);
    expect(isOpenApiKeyEnabled(2)).toBe(false);
    expect(isOpenApiKeyEnabled(undefined)).toBe(false);
    expect(isOpenApiKeyEnabled(null)).toBe(false);
  });

  it('状态颜色与文案键一一对齐', () => {
    expect(openApiKeyStatusColor(1)).toBe('success');
    expect(openApiKeyStatusColor(0)).toBe('default');
    expect(openApiKeyStatusLabelKey(1)).toBe('page.iot.openApiKey.enabled');
    expect(openApiKeyStatusLabelKey(0)).toBe('page.iot.openApiKey.disabled');
  });

  it('白名单与后端 7 项对齐', () => {
    expect(OPEN_API_ALLOWED_SCOPES).toHaveLength(7);
    expect(OPEN_API_ALLOWED_SCOPES).toContain('iot:debug:send');
  });
});

describe('label helpers', () => {
  it('时间缺席显示 -', () => {
    expect(openApiKeyTimeLabel(undefined)).toBe('-');
    expect(openApiKeyTimeLabel('2026-10-01')).toBe('2026-10-01');
  });

  it('空作用域显示 -', () => {
    expect(openApiKeyScopesLabel([])).toBe('-');
    expect(openApiKeyScopesLabel(['iot:series:get'])).toBe('iot:series:get');
  });
});

describe('usage helpers', () => {
  it('正常配额按比例（12/100 → 12）', () => {
    expect(openApiKeyUsagePercent(12, 100)).toBe(12);
    expect(openApiKeyUsagePercent(0, 100)).toBe(0);
    expect(openApiKeyUsageKind(12, 100)).toBe('limited');
    expect(openApiKeyUsageLabel(12)).toBe('12');
  });

  it('超配额钳制到 100（不溢出进度条）', () => {
    expect(openApiKeyUsagePercent(150, 100)).toBe(100);
    expect(openApiKeyUsageKind(150, 100)).toBe('limited');
  });

  it('配额不限（0/负/缺席）⇒ unlimited，不画进度', () => {
    for (const quota of [0, -1, undefined, null]) {
      expect(openApiKeyUsageKind(12, quota)).toBe('unlimited');
      expect(openApiKeyUsagePercent(12, quota)).toBe(0);
    }
  });

  it('用量未知（null/缺席）⇒ unknown，文本显示 -', () => {
    expect(openApiKeyUsageKind(null, 100)).toBe('unknown');
    expect(openApiKeyUsageKind(undefined, 100)).toBe('unknown');
    expect(openApiKeyUsageLabel(null)).toBe('-');
    expect(openApiKeyUsageLabel(undefined)).toBe('-');
  });

  it('配额缺席时用量未知也判 unlimited（不限优先于未知）', () => {
    expect(openApiKeyUsageKind(null, 0)).toBe('unlimited');
    expect(openApiKeyUsageKind(undefined, undefined)).toBe('unlimited');
  });
});
