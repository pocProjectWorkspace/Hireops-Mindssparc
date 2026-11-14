/**
 * C2-F1 — tenant roles & capability bundles (admin surface /admin/roles) and
 * role assignment (/admin/users).
 *
 *   listRoles          admin.roles OR admin.users — system roles (platform
 *                      default bundles, read-only) + the tenant's custom roles.
 *   upsertCustomRole   admin.roles — create / edit a custom role. Audited.
 *   setCustomRoleActive admin.roles — deactivate / reactivate (refused while
 *                      members hold it, so nobody is silently locked out).
 *   assignMemberRole   admin.users — put a member on a custom role (their
 *                      membership `roles` becomes [base_role], which is what
 *                      their next JWT carries for RLS) or back on system roles.
 *   getMyPermissions   any member — the caller's own effective capabilities.
 *
 * NO PRIVILEGE ESCALATION: a caller can only create a role, or assign one,
 * whose every grant they themselves hold at the same or a wider scope. An admin
 * cannot assign themselves a role that drops `admin.users` (lock-out guard,
 * mirrors updateMembershipRoles' self-demotion guard).
 *
 * Writes to tenant_roles / role_capabilities go through ctx.db (tenant-bound,
 * RLS tenant_isolation + the audit trigger attribute the actor). Membership
 * writes use the service-role pool with an explicit tenant predicate — the
 * memberships table has no authenticated write policy (CONF-03 precedent).
 * Every write invalidates this process's permission cache for the tenant.
 */

import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { db as poolDb, roleCapabilities, tenantRoles, tenantUserMemberships } from "@hireops/db";
import {
  CUSTOM_ROLE_BASE_ROLES,
  DEFAULT_SYSTEM_ROLE_LABELS,
  SYSTEM_ROLE_BUNDLES,
  assignMemberRoleInputSchema,
  assignMemberRoleOutputSchema,
  capabilityCatalogEntries,
  getMyPermissionsInputSchema,
  getMyPermissionsOutputSchema,
  isCapability,
  listRolesInputSchema,
  listRolesOutputSchema,
  resolveEffectivePermissions,
  scopeCovers,
  setCustomRoleActiveInputSchema,
  setCustomRoleActiveOutputSchema,
  upsertCustomRoleInputSchema,
  upsertCustomRoleOutputSchema,
  validateGrants,
  type Capability,
  type CapabilityGrant,
  type CapabilityScope,
  type RoleRow,
} from "@hireops/api-types";
import { protectedProcedure, type HonoTRPCContext } from "./trpc-core";
import { withAudit } from "./with-audit";
import { permsOf, requireAnyCapability, requireCapability } from "./permissions";
import { invalidatePermissionsCache } from "../lib/permissions/resolve";

type TxDb = NonNullable<HonoTRPCContext["db"]>;

function tenantOf(ctx: HonoTRPCContext): string {
  if (!ctx.tenantId) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
  }
  return ctx.tenantId;
}

function dbOf(ctx: HonoTRPCContext): TxDb {
  if (!ctx.db) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenant-bound db" });
  }
  return ctx.db;
}

function isMissingSchema(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42703" || code === "42P01";
}

/** Grants the caller holds at ≥ the requested scope; returns the first it doesn't. */
function firstGrantNotHeld(
  ctx: HonoTRPCContext,
  grants: readonly { capability: Capability; scope: CapabilityScope }[],
): Capability | null {
  const caps = permsOf(ctx).caps;
  for (const g of grants) {
    const held = caps[g.capability];
    if (!held || !scopeCovers(held, g.scope)) return g.capability;
  }
  return null;
}

function bundleGrants(bundle: Partial<Record<Capability, CapabilityScope>>): CapabilityGrant[] {
  return (Object.entries(bundle) as [Capability, CapabilityScope][])
    .map(([capability, scope]) => ({ capability, scope }))
    .sort((a, b) => a.capability.localeCompare(b.capability));
}

interface CustomRoleLoaded {
  key: string;
  label: string;
  baseRole: string;
  description: string | null;
  active: boolean;
  grants: CapabilityGrant[];
}

async function loadCustomRoles(db: TxDb, tenantId: string): Promise<CustomRoleLoaded[]> {
  const roles = await db
    .select()
    .from(tenantRoles)
    .where(eq(tenantRoles.tenantId, tenantId))
    .orderBy(tenantRoles.label);
  const grants = await db
    .select()
    .from(roleCapabilities)
    .where(eq(roleCapabilities.tenantId, tenantId));
  const byRole = new Map<string, CapabilityGrant[]>();
  for (const g of grants) {
    // Rows are format-checked by the DB; anything outside today's catalog is
    // shown nowhere and enforced nowhere (the resolver drops it too).
    if (!isCapability(g.capability)) continue;
    const list = byRole.get(g.roleKey) ?? [];
    list.push({ capability: g.capability, scope: g.scope as CapabilityScope });
    byRole.set(g.roleKey, list);
  }
  return roles.map((r) => ({
    key: r.key,
    label: r.label,
    baseRole: r.baseRole,
    description: r.description ?? null,
    active: r.active,
    grants: (byRole.get(r.key) ?? []).sort((a, b) => a.capability.localeCompare(b.capability)),
  }));
}

async function loadCustomRole(
  db: TxDb,
  tenantId: string,
  key: string,
): Promise<CustomRoleLoaded | null> {
  return (await loadCustomRoles(db, tenantId)).find((r) => r.key === key) ?? null;
}

/** Member counts: by role_key (custom) and by base role for role_key-less members. */
async function memberCounts(
  ctx: HonoTRPCContext,
  tenantId: string,
): Promise<{ custom: Map<string, number>; system: Map<string, number> }> {
  const custom = new Map<string, number>();
  const system = new Map<string, number>();
  let rows: { role_key: string | null; roles: string[] }[];
  try {
    rows = await ctx.sql<{ role_key: string | null; roles: string[] }[]>`
      SELECT role_key, roles::text[] AS roles FROM public.tenant_user_memberships
       WHERE tenant_id = ${tenantId} AND status = 'active'
    `;
  } catch (err) {
    if (!isMissingSchema(err)) throw err;
    rows = (
      await ctx.sql<{ roles: string[] }[]>`
        SELECT roles::text[] AS roles FROM public.tenant_user_memberships
         WHERE tenant_id = ${tenantId} AND status = 'active'
      `
    ).map((r) => ({ role_key: null, roles: r.roles }));
  }
  for (const r of rows) {
    if (r.role_key) custom.set(r.role_key, (custom.get(r.role_key) ?? 0) + 1);
    else for (const role of r.roles ?? []) system.set(role, (system.get(role) ?? 0) + 1);
  }
  return { custom, system };
}

async function customRolesAvailable(ctx: HonoTRPCContext): Promise<boolean> {
  const [row] = await ctx.sql<{ t: string | null }[]>`
    SELECT to_regclass('public.tenant_roles')::text AS t
  `;
  return Boolean(row?.t);
}

async function listRoleRows(ctx: HonoTRPCContext, tenantId: string): Promise<RoleRow[]> {
  const counts = await memberCounts(ctx, tenantId);
  const systemRows: RoleRow[] = CUSTOM_ROLE_BASE_ROLES.map((role) => ({
    key: role,
    label: DEFAULT_SYSTEM_ROLE_LABELS[role],
    baseRole: role,
    description: "Platform default role. Its permissions follow the platform and cannot be edited.",
    isSystem: true,
    active: true,
    grants: bundleGrants(SYSTEM_ROLE_BUNDLES[role]),
    memberCount: counts.system.get(role) ?? 0,
  }));
  // Pre-0137 database: custom roles cannot exist yet (checked up front so a
  // failing read never aborts the request transaction).
  const custom = (await customRolesAvailable(ctx))
    ? await loadCustomRoles(dbOf(ctx), tenantId)
    : [];
  return [
    ...systemRows,
    ...custom.map((r) => ({
      key: r.key,
      label: r.label,
      baseRole: r.baseRole,
      description: r.description,
      isSystem: false,
      active: r.active,
      grants: r.grants,
      memberCount: counts.custom.get(r.key) ?? 0,
    })),
  ];
}

export const rolesProcedures = {
  listRoles: protectedProcedure
    .input(listRolesInputSchema)
    .output(listRolesOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyCapability(
        ctx,
        ["admin.roles", "admin.users"],
        "Roles are visible to role and user administrators",
      );
      const tenantId = tenantOf(ctx);
      return { roles: await listRoleRows(ctx, tenantId), catalog: capabilityCatalogEntries() };
    }),

  upsertCustomRole: protectedProcedure
    .input(upsertCustomRoleInputSchema)
    .output(upsertCustomRoleOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("upsert_custom_role", ctx, input, async () => {
        requireCapability(ctx, "admin.roles", "Defining roles requires the roles capability");
        const tenantId = tenantOf(ctx);
        const db = dbOf(ctx);
        const problem = validateGrants(input.grants);
        if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
        const notHeld = firstGrantNotHeld(ctx, input.grants);
        if (notHeld) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `You can only grant permissions you hold yourself (${notHeld}).`,
          });
        }

        const existing = await loadCustomRole(db, tenantId, input.key);
        const description = input.description?.trim() ? input.description.trim() : null;
        if (existing) {
          await db
            .update(tenantRoles)
            .set({
              label: input.label,
              baseRole: input.baseRole,
              description,
              updatedAt: new Date(),
            })
            .where(and(eq(tenantRoles.tenantId, tenantId), eq(tenantRoles.key, input.key)));
          await db
            .delete(roleCapabilities)
            .where(
              and(eq(roleCapabilities.tenantId, tenantId), eq(roleCapabilities.roleKey, input.key)),
            );
          // Members already on this role carry its base role in `roles` (the
          // JWT claim). Keep that in step when the base role changes.
          if (existing.baseRole !== input.baseRole) {
            await poolDb
              .update(tenantUserMemberships)
              .set({ roles: [input.baseRole], updatedAt: new Date() })
              .where(
                and(
                  eq(tenantUserMemberships.tenantId, tenantId),
                  eq(tenantUserMemberships.roleKey, input.key),
                ),
              );
          }
        } else {
          await db.insert(tenantRoles).values({
            tenantId,
            key: input.key,
            label: input.label,
            baseRole: input.baseRole,
            description,
          });
        }
        if (input.grants.length > 0) {
          await db.insert(roleCapabilities).values(
            input.grants.map((g) => ({
              tenantId,
              roleKey: input.key,
              capability: g.capability,
              scope: g.scope,
            })),
          );
        }
        invalidatePermissionsCache(tenantId);
        const rows = await listRoleRows(ctx, tenantId);
        const role = rows.find((r) => r.key === input.key && !r.isSystem);
        if (!role) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "role write lost" });
        }
        return { role, created: !existing };
      });
    }),

  setCustomRoleActive: protectedProcedure
    .input(setCustomRoleActiveInputSchema)
    .output(setCustomRoleActiveOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("set_custom_role_active", ctx, input, async () => {
        requireCapability(ctx, "admin.roles", "Defining roles requires the roles capability");
        const tenantId = tenantOf(ctx);
        const db = dbOf(ctx);
        const role = await loadCustomRole(db, tenantId, input.key);
        if (!role) throw new TRPCError({ code: "NOT_FOUND", message: "Role not found" });
        if (!input.active) {
          const counts = await memberCounts(ctx, tenantId);
          const n = counts.custom.get(input.key) ?? 0;
          if (n > 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `${n} member(s) hold this role. Move them to another role before deactivating it.`,
            });
          }
        }
        await db
          .update(tenantRoles)
          .set({ active: input.active, updatedAt: new Date() })
          .where(and(eq(tenantRoles.tenantId, tenantId), eq(tenantRoles.key, input.key)));
        invalidatePermissionsCache(tenantId);
        return { ok: true as const };
      });
    }),

  assignMemberRole: protectedProcedure
    .input(assignMemberRoleInputSchema)
    .output(assignMemberRoleOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("assign_member_role", ctx, input, async () => {
        requireCapability(ctx, "admin.users", "Assigning roles is for user administrators");
        const tenantId = tenantOf(ctx);
        const db = dbOf(ctx);

        const [membership] = await poolDb
          .select({
            id: tenantUserMemberships.id,
            userId: tenantUserMemberships.userId,
            roles: tenantUserMemberships.roles,
          })
          .from(tenantUserMemberships)
          .where(
            and(
              eq(tenantUserMemberships.id, input.membershipId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (!membership)
          throw new TRPCError({ code: "NOT_FOUND", message: "membership not found" });
        const isSelf = membership.userId === ctx.userId;

        if (input.roleKey === null) {
          // Back to system roles: the membership keeps its current base roles.
          if (isSelf) {
            const after = resolveEffectivePermissions({
              roles: membership.roles,
              customRole: null,
            });
            if (!after.caps["admin.users"]) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "You cannot remove your own user administration. Ask another admin.",
              });
            }
          }
          await poolDb
            .update(tenantUserMemberships)
            .set({ roleKey: null, updatedAt: new Date() })
            .where(
              and(
                eq(tenantUserMemberships.id, input.membershipId),
                eq(tenantUserMemberships.tenantId, tenantId),
              ),
            );
          invalidatePermissionsCache(tenantId);
          return {
            ok: true as const,
            membershipId: input.membershipId,
            roleKey: null,
            roles: [...membership.roles],
          };
        }

        const role = await loadCustomRole(db, tenantId, input.roleKey);
        if (!role) throw new TRPCError({ code: "NOT_FOUND", message: "Role not found" });
        if (!role.active) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That role is deactivated" });
        }
        const notHeld = firstGrantNotHeld(ctx, role.grants);
        if (notHeld) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `You can only assign roles whose permissions you hold yourself (${notHeld}).`,
          });
        }
        if (isSelf && !role.grants.some((g) => g.capability === "admin.users")) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "You cannot remove your own user administration. Ask another admin.",
          });
        }
        await poolDb
          .update(tenantUserMemberships)
          .set({
            roleKey: role.key,
            roles: [role.baseRole as (typeof membership.roles)[number]],
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tenantUserMemberships.id, input.membershipId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          );
        invalidatePermissionsCache(tenantId);
        return {
          ok: true as const,
          membershipId: input.membershipId,
          roleKey: role.key,
          roles: [role.baseRole],
        };
      });
    }),

  getMyPermissions: protectedProcedure
    .input(getMyPermissionsInputSchema)
    .output(getMyPermissionsOutputSchema)
    .query(({ ctx }) => {
      const perms = permsOf(ctx);
      return { roleKey: perms.roleKey, caps: { ...perms.caps } as Record<string, CapabilityScope> };
    }),
};
