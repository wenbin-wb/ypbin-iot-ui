import { describe, expect, it } from 'vitest';

import {
  checkOpenApiKeyForm,
  isOpenApiKeyEnabled,
  isValidIpWhitelistEntry,
  normalizeOpenApiKeyForm,
  OPEN_API_ALLOWED_SCOPES,
  openApiKeyIpWhitelistKind,
  openApiKeyStatusColor,
  openApiKeyStatusLabelKey,
  openApiKeyUsageKind,
  openApiKeyUsageLabel,
  openApiKeyUsagePercent,
  parseIpWhitelist,
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

  it('后端 Long 序列化成字符串也能正确处理（tenantId 同口径）', () => {
    expect(openApiKeyUsagePercent('12', 100)).toBe(12);
    expect(openApiKeyUsageKind('12', 100)).toBe('limited');
    expect(openApiKeyUsageLabel('12')).toBe('12');
  });

  it('非数字字符串按未知处理（不让 NaN 进进度条）', () => {
    expect(openApiKeyUsageKind('abc', 100)).toBe('unknown');
    expect(openApiKeyUsagePercent('abc', 100)).toBe(0);
    expect(openApiKeyUsageLabel('abc')).toBe('-');
  });
});

describe('parseIpWhitelist（与后端 IpWhitelist 同口径）', () => {
  it('空输入 ⇒ 不限来源（normalized 缺席，不传该字段）', () => {
    expect(parseIpWhitelist('')).toEqual({});
    expect(parseIpWhitelist('   ')).toEqual({});
    expect(parseIpWhitelist(undefined)).toEqual({});
    expect(parseIpWhitelist(null)).toEqual({});
    // 只有分隔符/空白也视为未配置
    expect(parseIpWhitelist(' , \n , ')).toEqual({});
  });

  it('ipv4 / ipv4 CIDR / ipv6 / ipv6 CIDR 都接受并归一化（trim + 去重）', () => {
    expect(parseIpWhitelist(' 192.168.1.10 , 10.0.0.0/8 ')).toEqual({
      normalized: '192.168.1.10,10.0.0.0/8',
    });
    expect(parseIpWhitelist('2001:db8::1,2001:db8::/32')).toEqual({
      normalized: '2001:db8::1,2001:db8::/32',
    });
    // 重复条目只保留首次出现（后端 normalizeIpWhitelist 同样去重）
    expect(parseIpWhitelist('10.0.0.1,10.0.0.1')).toEqual({
      normalized: '10.0.0.1',
    });
  });

  it('逗号与换行都算分隔符（任务口径：逗号/换行分隔）', () => {
    expect(parseIpWhitelist('10.0.0.1\r\n10.0.0.2\n192.168.0.0/16')).toEqual({
      normalized: '10.0.0.1,10.0.0.2,192.168.0.0/16',
    });
  });

  it('非法条目 ⇒ 返回该条目本身（前端先拦住，别等到建 Key 才 400）', () => {
    expect(parseIpWhitelist('10.0.0.1,not-an-ip')).toEqual({
      invalidEntry: 'not-an-ip',
    });
    // 域名不做 DNS 解析，直接判非法（与后端「仅接受字面量地址」一致）
    expect(parseIpWhitelist('example.com')).toEqual({
      invalidEntry: 'example.com',
    });
    // 掩码越界：IPv4 不能超过 /32，IPv6 不能超过 /128
    expect(parseIpWhitelist('10.0.0.0/33')).toEqual({
      invalidEntry: '10.0.0.0/33',
    });
    expect(parseIpWhitelist('2001:db8::/129')).toEqual({
      invalidEntry: '2001:db8::/129',
    });
    expect(parseIpWhitelist('10.0.0.0/abc')).toEqual({
      invalidEntry: '10.0.0.0/abc',
    });
  });

  it('ipv4 段越界 / ipv6 分组非法 / :: 压缩过量都拒绝', () => {
    expect(isValidIpWhitelistEntry('256.1.1.1')).toBe(false);
    expect(isValidIpWhitelistEntry('1.2.3')).toBe(false);
    expect(isValidIpWhitelistEntry('gggg::1')).toBe(false);
    expect(isValidIpWhitelistEntry('1:2:3:4:5:6:7:8:9')).toBe(false);
    expect(isValidIpWhitelistEntry('1:2:3:4:5:6:7::')).toBe(true);
    expect(isValidIpWhitelistEntry('::1')).toBe(true);
    expect(isValidIpWhitelistEntry('::ffff:192.168.1.10')).toBe(true);
  });

  it('停掉 IP 白名单展示态：未返回字段 ≠ 不限来源（不假播报）', () => {
    // 后端 ListItemResp 当前不返回 ipWhitelist ⇒ unknown（显示 -）
    expect(openApiKeyIpWhitelistKind(undefined)).toBe('unknown');
    expect(openApiKeyIpWhitelistKind(null)).toBe('unknown');
    expect(openApiKeyIpWhitelistKind('')).toBe('unlimited');
    expect(openApiKeyIpWhitelistKind('10.0.0.0/8')).toBe('configured');
  });
});
