/**
 * C2-F1 — the ONE read of a member's custom role + its capability grants,
 * shared by the API (enforcement) and the portal (nav + page gates) so the two
 * can never disagree about who holds what.
 *
 * Service-role read (the caller passes the pool) with an explicit
 * tenant + user predicate. Returns null when the user has no ACTIVE membership
 * in the tenant.
 *
 * MIGRATION TOLERANCE: on a database without migration 0137 (no `role_key`
 * column / `tenant_roles` table → SQLSTATE 42703 / 42P01) no custom role can
 * exist, so the row comes back with `roleKey: null` and the caller falls back
 * to the platform default bundles — the pre-C2-F1 behaviour, never a widening.
 */

import type { sql as poolSql } from "./client";

type SqlHandle = typeof poolSql;

export interface MemberPermissionRow {
  membershipId: string;
  businessUnitId: string | null;
  /** The custom role in force, or null (system roles). */
  roleKey: string | null;
  /** The custom role's base role / active flag / grants (null when no custom role). */
  customRole: {
    key: string;
    baseRole: string;
    active: boolean;
    grants: { capability: string; scope: string }[];
  } | null;
}

/**
 * Pre-0137 memo: once a database has answered "no role_key column", skip the
 * custom-role query for a minute instead of paying a failing round trip on
 * every resolution. Re-probed after the window so applying 0137 needs no
 * restart.
 */
const SCHEMA_PROBE_TTL_MS = 60_000;
let schemaMissingUntil = 0;

function isMissingSchema(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42703" || code === "42P01";
}

export async function readMemberPermissionRow(
  sql: SqlHandle,
  tenantId: string,
  userId: string,
): Promise<MemberPermissionRow | null> {
  if (Date.now() < schemaMissingUntil) return readWithoutCustomRoles(sql, tenantId, userId);
  try {
    const rows = await sql<
      {
        membership_id: string;
        business_unit_id: string | null;
        role_key: string | null;
        base_role: string | null;
        role_active: boolean | null;
        grants: { capability: string; scope: string }[] | null;
      }[]
    >`
      SELECT m.id::text AS membership_id,
             m.business_unit_id::text AS business_unit_id,
             m.role_key,
             r.base_role::text AS base_role,
             r.active AS role_active,
             (SELECT json_agg(json_build_object('capability', rc.capability, 'scope', rc.scope))
                FROM public.role_capabilities rc
               WHERE rc.tenant_id = m.tenant_id AND rc.role_key = m.role_key) AS grants
        FROM public.tenant_user_memberships m
        LEFT JOIN public.tenant_roles r ON r.tenant_id = m.tenant_id AND r.key = m.role_key
       WHERE m.tenant_id = ${tenantId} AND m.user_id = ${userId} AND m.status = 'active'
       LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      membershipId: r.membership_id,
      businessUnitId: r.business_unit_id,
      roleKey: r.role_key,
      customRole: r.role_key
        ? {
            key: r.role_key,
            // A dangling key (the FK prevents it) resolves to nothing.
            baseRole: r.base_role ?? "",
            active: r.role_active === true,
            grants: Array.isArray(r.grants) ? r.grants : [],
          }
        : null,
    };
  } catch (err) {
    if (!isMissingSchema(err)) throw err;
    schemaMissingUntil = Date.now() + SCHEMA_PROBE_TTL_MS;
    return readWithoutCustomRoles(sql, tenantId, userId);
  }
}

/** The membership without custom-role columns (pre-0137 database). */
async function readWithoutCustomRoles(
  sql: SqlHandle,
  tenantId: string,
  userId: string,
): Promise<MemberPermissionRow | null> {
  const rows = await sql<{ membership_id: string; business_unit_id: string | null }[]>`
    SELECT m.id::text AS membership_id, m.business_unit_id::text AS business_unit_id
      FROM public.tenant_user_memberships m
     WHERE m.tenant_id = ${tenantId} AND m.user_id = ${userId} AND m.status = 'active'
     LIMIT 1
  `;
  const r = rows[0];
  return r
    ? {
        membershipId: r.membership_id,
        businessUnitId: r.business_unit_id,
        roleKey: null,
        customRole: null,
      }
    : null;
}
