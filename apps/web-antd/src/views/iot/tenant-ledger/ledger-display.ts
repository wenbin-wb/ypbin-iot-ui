/**
 * 租户台账的**纯展示/过滤逻辑**（零 vue、零网络依赖，可直接单测）。
 *
 * 背景：后端 `TenantLedgerResp` 只给 `tenantId`，不返回租户名称；
 * 页面用 `#/api/system/tenant` 的 `getTenantList()` **批量**解析名称后在这里建映射。
 * 约定：映射缺失时**不伪造名称**——由调用方回落展示 `tenantId` 或「名称待接入」。
 *
 * `tenantId` 是后端 Long 序列化后的字符串 ⇒ 全程按字符串处理（不用 Number()）。
 */
import type { SystemTenantApi } from '#/api/system/tenant';

/** tenantId → 租户名称。 */
export type TenantNameMap = Record<string, string>;

/** `getTenantList()` 结果 → tenantId → 名称映射；缺 id 或 name 的条目跳过。 */
export function buildTenantNameMap(
  tenants?: null | SystemTenantApi.TenantResp[],
): TenantNameMap {
  const map: TenantNameMap = {};
  for (const tenant of tenants ?? []) {
    const id = tenant?.id ? String(tenant.id) : '';
    const name = (tenant?.name ?? '').trim();
    if (id !== '' && name !== '') {
      map[id] = name;
    }
  }
  return map;
}

/**
 * 前端关键字过滤：命中租户名或 `tenantId`（均不区分大小写）。
 *
 * 空关键字（含纯空白）直接返回原数组 ⇒ 不复制、不改变顺序。
 */
export function filterLedgerRows<T extends { tenantId?: null | string }>(
  rows: T[],
  keyword: null | string | undefined,
  tenantNames: TenantNameMap,
): T[] {
  const needle = (keyword ?? '').trim().toLowerCase();
  if (needle === '') {
    return rows;
  }
  return rows.filter((row) => {
    const id = String(row.tenantId ?? '');
    const name = tenantNames[id] ?? '';
    return (
      id.toLowerCase().includes(needle) || name.toLowerCase().includes(needle)
    );
  });
}

/** `assignable` 三态 → i18n 键（true 可接入 / false 不可接入 / 缺失一律「未知」，不猜）。 */
export function assignableLabelKey(value?: boolean | null): string {
  if (value === true) {
    return 'page.iot.ledger.assignableOn';
  }
  if (value === false) {
    return 'page.iot.ledger.assignableOff';
  }
  return 'page.iot.display.unknown';
}

/** `assignable` 三态 → Tag 颜色（未知用 warning，避免看起来像「已关闭」）。 */
export function assignableColor(value?: boolean | null): string {
  if (value === true) {
    return 'success';
  }
  if (value === false) {
    return 'default';
  }
  return 'warning';
}
