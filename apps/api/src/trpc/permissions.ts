/**
 * C2-F1 — capability enforcement for tRPC procedures.
 *
 * `requireCapability(ctx, cap, message)` replaces `requireAnyRole(ctx, SET,
 * message)` at every gate. The caller's effective permissions are resolved once
 * per request by the protectedProcedure middleware (ctx.perms). There is no
 * admin bypass: an admin holds every capability through its system bundle, and
 * an admin-based custom role holds exactly what its bundle grants.
 *
 * FAIL CLOSED: a procedure that reaches a gate without ctx.perms (i.e. not
 * through protectedProcedure) is an INTERNAL error, never a pass.
 */

import { TRPCError } from "@trpc/server";
import {
  capabilityScope,
  hasAnyCapability,
  hasCapability,
  type Capability,
  type CapabilityScope,
  type Population,
} from "@hireops/api-types";
import type { HonoTRPCContext } from "./trpc-core";
import { populationForScope, type CallerPermissions } from "../lib/permissions/resolve";

export function permsOf(ctx: Pick<HonoTRPCContext, "perms">): CallerPermissions {
  if (!ctx.perms) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "capability check outside a protected procedure",
    });
  }
  return ctx.perms;
}

/** Does the caller hold `cap` (any scope)? */
export function can(ctx: Pick<HonoTRPCContext, "perms">, cap: Capability): boolean {
  return hasCapability(permsOf(ctx), cap);
}

/** The caller's scope for `cap`, or null. */
export function scopeOf(
  ctx: Pick<HonoTRPCContext, "perms">,
  cap: Capability,
): CapabilityScope | null {
  return capabilityScope(permsOf(ctx), cap);
}

/** FORBIDDEN unless the caller holds `cap`. Returns the granted scope. */
export function requireCapability(
  ctx: Pick<HonoTRPCContext, "perms">,
  cap: Capability,
  message: string,
): CapabilityScope {
  const scope = scopeOf(ctx, cap);
  if (scope === null) throw new TRPCError({ code: "FORBIDDEN", message });
  return scope;
}

/** FORBIDDEN unless the caller holds at least one of `caps`. */
export function requireAnyCapability(
  ctx: Pick<HonoTRPCContext, "perms">,
  caps: readonly Capability[],
  message: string,
): void {
  if (!hasAnyCapability(permsOf(ctx), caps)) throw new TRPCError({ code: "FORBIDDEN", message });
}

/**
 * The target population the caller may act on for `cap` (P5). Throws
 * FORBIDDEN when the capability is not held at all.
 */
export async function requirePopulation(
  ctx: Pick<HonoTRPCContext, "perms" | "sql">,
  cap: Capability,
  message: string,
): Promise<Population> {
  const scope = requireCapability(ctx, cap, message);
  return populationForScope(ctx.sql, permsOf(ctx), scope);
}
