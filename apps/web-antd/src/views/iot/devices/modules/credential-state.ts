/**
 * 设备凭据区块的**纯逻辑**（状态判定/格式化/一次性明文的复制文案），零 vue 依赖可单测。
 *
 * 安全约束（"一次做到位"的边界）：
 *   ① 明文 password 只在签发响应返回一次 —— 组件不得持久化、不得二次回读；
 *   ② 查看端点只给元信息，UI 不得假装能显示密码（后端哈希存储，回读不了）；
 *   ③ 吊销/重置都是破坏性动作，UI 必须 Popconfirm；
 *   ④ 连接参数是**设备侧配置依据**，要和凭据状态联动展示。
 */
import type { IotCredentialApi } from '#/api/iot';

/** 凭据展示态。 */
export type CredentialState =
  | 'error'
  | 'issued'
  | 'loading'
  | 'none'
  | 'revoked';

/**
 * 凭据状态判定（错误优先；issued=false → none；valid=false → revoked）。
 */
export function resolveCredentialState(
  loading: boolean,
  errorMessage: string,
  credential?: IotCredentialApi.CredentialResp | null,
): CredentialState {
  if (loading) {
    return 'loading';
  }
  if (errorMessage) {
    return 'error';
  }
  if (!credential) {
    return 'none';
  }
  if (!credential.issued) {
    return 'none';
  }
  return credential.valid ? 'issued' : 'revoked';
}

/** 连接信息是否可用（broker 已配置）。 */
export function hasBroker(
  connection?: IotCredentialApi.ConnectionResp | null,
): boolean {
  return Boolean(
    connection && connection.brokerHost && connection.brokerPort > 0,
  );
}

/**
 * broker 展示串（host:port，TLS 时附 🔒；未配置给 '-'）。
 */
export function brokerLabel(
  connection?: IotCredentialApi.ConnectionResp | null,
): string {
  if (!connection || !connection.brokerHost || !connection.brokerPort) {
    return '-';
  }
  const suffix = connection.brokerTlsEnabled ? ' (TLS)' : '';
  return `${connection.brokerHost}:${connection.brokerPort}${suffix}`;
}

/**
 * 复制内容是否敏感（password / username 等；复制后 UI 提示"已复制到剪贴板"，
 * 但对 password 额外提示"仅此一次"）。
 */
export function isSecret(text: string): boolean {
  return Boolean(text && text.length > 0);
}

/**
 * 凭据版本展示（缺席显示 '-'）。
 */
export function versionLabel(version?: null | number): string {
  return version === undefined || version === null ? '-' : String(version);
}

/**
 * 当前凭据是否可重置（已签发或已吊销都可再次签发；从未签发是"首次签发"）。
 */
export function canReissue(state: CredentialState): boolean {
  return state === 'issued' || state === 'revoked';
}
