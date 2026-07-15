/**
 * tRPC initialisation, error formatter, and the two procedure builders
 * downstream routers compose with.
 *
 * Context shape (HonoTRPCContext):
 *   - tenantId / userId / claims / roles — null when caller is
 *     unauthenticated (public procedures).
 *   - db — TenantBoundDb when inside a protected procedure (the protected
 *     middleware opens withTenantContext per-call); undefined otherwise.
 *   - sql — service-role poolSql, always available for public procedures
 *     that need to touch the DB (e.g. submitApplication).
 *   - log / requestId — always set (optionalAuth middleware).
 *
 * Error shape:
 *   - Zod validation failures produce TRPC BAD_REQUEST with a flattened
 *     zodError payload on data.zodError. Frontend reads
 *     err.data.zodError.fieldErrors to render per-field messages.
 *   - Other errors flow through tRPC's default formatter unchanged.
 *
 * protectedProcedure middleware: rejects unauthenticated callers up
 * front, then opens a fresh withTenantContext({...claims}) so any DB
 * work inside the procedure runs as the `authenticated` role with the
 * right session vars (request_id, actor_user_id) for the DB-AUDIT
 * trigger. Returns next({ctx: { ...ctx, db: txDb }}).
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { ZodError } from "zod";
import { withTenantContext, sql as poolSql, type JwtClaims, type TenantBoundDb } from "@hireops/db";
import type { Logger } from "@hireops/observability";

export interface HonoTRPCContext {
  tenantId: string | null;
  userId: string | null;
  roles: string[];
  claims: JwtClaims | null;
  db: TenantBoundDb | undefined;
  sql: typeof poolSql;
  log: Logger;
  requestId: string;
  userAgent: string | null;
  ipAddress: string | null;
}

const t = initTRPC.context<HonoTRPCContext>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.code === "BAD_REQUEST" && error.cause instanceof ZodError
            ? error.cause.flatten()
            : null,
      },
    };
  },
});

export const router = t.router;

/**
 * publicProcedure — no auth check. Use for endpoints that must work
 * pre-login (apply form, public requisition view). Reaches the DB via
 * ctx.sql (service role, RLS-bypassing) and is responsible for setting
 * tenant_id correctly on every insert.
 */
export const publicProcedure = t.procedure;

/**
 * protectedProcedure — requires JWT-resolved tenantId + userId, opens a
 * withTenantContext transaction so the handler can use ctx.db with RLS
 * scoping live. tx commits when the handler resolves, rolls back on throw.
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.tenantId || !ctx.userId || !ctx.claims) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  const result = await withTenantContext(
    ctx.claims,
    async ({ db }) => {
      // Re-bind ctx with the tx-scoped db. The original ctx.sql remains
      // available for the rare procedure that needs service-role access.
      return next({ ctx: { ...ctx, db } });
    },
    {
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      userAgent: ctx.userAgent,
      ipAddress: ctx.ipAddress,
      source: "app",
    },
  );
  return result;
});

/**
 * Resolved partner context, attached to ctx by partnerProcedure. Mirrors
 * how protectedProcedure guarantees ctx.db, but here we ALSO carry the
 * partner org + role + identity because a partner-only JWT can't.
 */
export interface PartnerContext {
  partnerUserId: string;
  partnerOrgId: string;
  tenantId: string;
  role: string;
  displayName: string;
  email: string;
  orgName: string;
}

/**
 * partnerProcedure — the partner-portal auth tier (PARTNER-01).
 *
 * WHY THIS IS DIFFERENT FROM protectedProcedure. The Custom Access Token
 * hook (migration 0002) only reads tenant_user_memberships, so a human who
 * exists ONLY in partner_users signs in via Supabase and gets a JWT with a
 * verified `sub` but NO `tid`/`roles` claim. protectedProcedure would 401
 * them. Amending the shared auth hook would touch every tenant's login, so
 * instead we resolve the partner's tenant HERE, from partner_users, using
 * ctx.sql (the service-role pool — the same RLS-bypassing client public
 * procedures use). We then open a withTenantContext tx with SYNTHETIC claims
 * ({sub, tid, tenant_slug, roles:[partner_role]}) so current_tenant_id() and
 * every partner-table RLS policy fire correctly under the `authenticated`
 * role — identical discipline to protectedProcedure, just a different source
 * of truth for the tenant.
 *
 * Rejections:
 *   - no JWT (ctx.userId null)              → UNAUTHORIZED
 *   - JWT but no active partner_users row   → FORBIDDEN ('not_a_partner_account')
 *     (this is exactly how an internal recruiter is rejected — they have a
 *      membership but no partner_users row)
 *
 * Org-scoping note: the partner tables carry only a single tenant_isolation
 * RLS policy, so RLS alone would let org A read org B within the same tenant.
 * Every partner procedure MUST additionally filter by ctx.partner.partnerOrgId
 * — that explicit predicate is load-bearing for org isolation.
 */
export const partnerProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  // Service-role lookup (RLS-bypassing): find the active partner identity by
  // auth user id. Joins tenants (must be active) + partner_orgs (org name +
  // compound-tenant sanity). LIMIT 1 — (tenant_id, user_id) is unique and a
  // human is partner in at most one tenant per identity in the POC.
  const rows = await ctx.sql<
    {
      partner_user_id: string;
      partner_org_id: string;
      tenant_id: string;
      tenant_slug: string;
      role: string;
      full_name: string;
      email: string;
      org_name: string;
    }[]
  >`
    SELECT pu.id AS partner_user_id, pu.partner_org_id, pu.tenant_id,
           t.slug AS tenant_slug, pu.role::text AS role, pu.full_name, pu.email,
           po.name AS org_name
    FROM public.partner_users pu
    JOIN public.tenants t ON t.id = pu.tenant_id
    JOIN public.partner_orgs po ON po.id = pu.partner_org_id AND po.tenant_id = pu.tenant_id
    WHERE pu.user_id = ${ctx.userId} AND pu.active = true AND t.status = 'active'
    LIMIT 1
  `;
  const p = rows[0];
  if (!p) {
    throw new TRPCError({ code: "FORBIDDEN", message: "not_a_partner_account" });
  }

  const partnerClaims: JwtClaims = {
    sub: ctx.userId,
    tid: p.tenant_id,
    tenant_slug: p.tenant_slug,
    roles: [p.role],
  };
  const partner: PartnerContext = {
    partnerUserId: p.partner_user_id,
    partnerOrgId: p.partner_org_id,
    tenantId: p.tenant_id,
    role: p.role,
    displayName: p.full_name,
    email: p.email,
    orgName: p.org_name,
  };

  return withTenantContext(
    partnerClaims,
    async ({ db }) => {
      return next({
        ctx: { ...ctx, db, tenantId: p.tenant_id, claims: partnerClaims, partner },
      });
    },
    {
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      userAgent: ctx.userAgent,
      ipAddress: ctx.ipAddress,
      source: "app",
    },
  );
});
