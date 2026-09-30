import type { IotCredentialApi } from '#/api/iot';

import { describe, expect, it } from 'vitest';

import {
  brokerLabel,
  canReissue,
  hasBroker,
  resolveCredentialState,
  versionLabel,
} from './credential-state';

/** 设备凭据纯逻辑用例（看板 #13）。 */

/** 构造最小连接对象（double-assert，避免 as never）。 */
function conn(
  partial: Partial<IotCredentialApi.ConnectionResp>,
): IotCredentialApi.ConnectionResp {
  return partial as unknown as IotCredentialApi.ConnectionResp;
}

function issued() {
  return {
    deviceId: '9',
    username: 'dev_9',
    credentialVersion: 2,
    issued: true,
    valid: true,
  };
}

describe('resolveCredentialState（错误优先 / 未签发 / 吊销）', () => {
  it('加载中优先', () => {
    expect(resolveCredentialState(true, '', null)).toBe('loading');
  });

  it('失败必须 error，不能画成从未签发', () => {
    expect(resolveCredentialState(false, '网络错误', null)).toBe('error');
  });

  it('无数据 或 issued=false → none', () => {
    expect(resolveCredentialState(false, '', null)).toBe('none');
    expect(
      resolveCredentialState(false, '', { ...issued(), issued: false }),
    ).toBe('none');
  });

  it('已签发且有效 → issued', () => {
    expect(resolveCredentialState(false, '', issued())).toBe('issued');
  });

  it('已吊销（valid=false）→ revoked', () => {
    expect(
      resolveCredentialState(false, '', { ...issued(), valid: false }),
    ).toBe('revoked');
  });
});

describe('broker 展示', () => {
  it('未配置 → 短横线', () => {
    expect(brokerLabel(null)).toBe('-');
    expect(brokerLabel(conn({ brokerHost: '', brokerPort: 0 }))).toBe('-');
  });

  it('配置后显示 host:port（TLS 标记）', () => {
    const c = conn({
      brokerHost: 'broker.example.com',
      brokerPort: 8883,
      brokerTlsEnabled: true,
    });
    expect(brokerLabel(c)).toBe('broker.example.com:8883 (TLS)');
    expect(brokerLabel(conn({ ...c, brokerTlsEnabled: false }))).toBe(
      'broker.example.com:8883',
    );
  });

  it('hasBroker 判据', () => {
    expect(hasBroker(null)).toBe(false);
    expect(hasBroker(conn({ brokerHost: 'h', brokerPort: 1883 }))).toBe(true);
  });
});

describe('版本展示 / 重置能力', () => {
  it('versionLabel 空值给短横线', () => {
    expect(versionLabel(3)).toBe('3');
    expect(versionLabel(undefined)).toBe('-');
    expect(versionLabel(null)).toBe('-');
  });

  it('canReissue：已签发/已吊销可重置；从未签发与错误态不可', () => {
    expect(canReissue('issued')).toBe(true);
    expect(canReissue('revoked')).toBe(true);
    expect(canReissue('none')).toBe(false);
    expect(canReissue('loading')).toBe(false);
    expect(canReissue('error')).toBe(false);
  });
});
