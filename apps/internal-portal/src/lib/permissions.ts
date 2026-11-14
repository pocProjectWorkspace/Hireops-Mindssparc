import { cache } from "react";
import { readMemberPermissionRow, sql as poolSql } from "@hireops/db";
import {
  resolveEffectivePermissions,
  type CapabilityBundle,
  type EffectivePermissions,
} from "@hireops/api-types";

/**
 * C2-F1 — the signed-in member's effective capabilities for the portal (nav +
 * page gates), resolved ONCE per request (React cache) through the SAME read
 * and resolver the API enforces with (@hireops/db readMemberPermissionRow +
 * @hireops/api-types resolveEffectivePermissions):
 *   membership.role_key set  → that custom role's bundle only;
 *   otherwise                → the platform default bundles of the JWT roles.
 *
 * DISPLAY ONLY: every procedure re-checks on the API. A failed read falls back
 * to the platform default bundles of the JWT roles (the pre-C2-F1 view) rather
 * than blanking the UI; the API still refuses anything the member lacks.
 */
const loadByKey = cache(
  async (
    tenantId: string,
    userId: string,
    rolesKey: string,
  ): Promise<Pick<EffectivePermissions, "caps" | "roleKey">> => {
    const roles = rolesKey ? rolesKey.split(",") : [];
    try {
      const row = await readMemberPermissionRow(poolSql, tenantId, userId);
      const eff = resolveEffectivePermissions({ roles, customRole: row?.customRole ?? null });
      return { caps: eff.caps, roleKey: eff.roleKey };
    } catch (err) {
      if (typeof (err as { digest?: unknown } | null)?.digest === "string") throw err;
      console.warn("[permissions] falling back to the default bundles of the JWT roles", err);
      const eff = resolveEffectivePermissions({ roles, customRole: null });
      return { caps: eff.caps, roleKey: null };
    }
  },
);

export function loadSessionPermissions(session: {
  tenantId: string;
  userId: string;
  roles: readonly string[];
}): Promise<{ caps: CapabilityBundle; roleKey: string | null }> {
  return loadByKey(session.tenantId, session.userId, [...session.roles].sort().join(","));
}
