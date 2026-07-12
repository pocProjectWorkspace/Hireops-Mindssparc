import { Hono } from "hono";
import { sql as poolSql } from "@hireops/db";
import { verifyLink } from "@hireops/notifications";
import { baseLog } from "../lib/observability";

/**
 * GET /api/links/:token — verify a signed link and (single-use) consume.
 *
 * Flow:
 *   1. verifyLink(token) — checks signature + expiry.
 *   2. Look up signed_link_uses by token_hash. If a row exists, the
 *      token has already been redeemed once — reject 409.
 *   3. INSERT a signed_link_uses row recording the redemption. The
 *      UNIQUE (tenant_id, token_hash) constraint plus the previous
 *      check together enforce one-time use; two concurrent redemptions
 *      race on the insert, one wins, the other gets 23505 and is told
 *      'already redeemed'.
 *
 * Tenant resolution is via the signed-link payload's subjectId — for
 * Wave 1 every signed-link action operates on a tenant-scoped row
 * (candidate / application / offer) whose tenant_id we look up via
 * the relevant table. This route doesn't dispatch the action itself
 * (a future ticket will); it just verifies + audits, then returns
 * the verified payload so the caller can act on it.
 *
 * The audit is INSERT-only (RLS = split + append-only).
 */
export const linksRoutes = new Hono();

linksRoutes.get("/:token", async (c) => {
  const token = c.req.param("token");
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  const v = verifyLink(token);
  if (!v.ok) {
    baseLog.warn({ reason: v.reason, ip }, "links.verify_rejected");
    return c.json({ ok: false, reason: v.reason }, 400);
  }

  const tokenHash = v.payload.tokenHash;

  // Resolve tenant from subjectId. Wave 1: only candidate-scoped actions
  // ship — look up candidate.tenant_id. New action subjects extend this.
  const tenantId = await resolveTenantBySubject(v.payload.action, v.payload.subjectId);
  if (!tenantId) {
    baseLog.warn({ action: v.payload.action }, "links.subject_not_found");
    return c.json({ ok: false, reason: "subject_not_found" }, 404);
  }

  // Cheap explicit precheck so we can record a clean already_redeemed audit
  // row without racing the partial-unique insert. The unique index is the
  // authoritative guard against concurrent successful redemptions; the
  // precheck handles the common sequential case.
  const prior = await poolSql<{ id: string }[]>`
    SELECT id FROM public.signed_link_uses
    WHERE tenant_id = ${tenantId} AND token_hash = ${tokenHash} AND successful = true
    LIMIT 1
  `;
  if (prior.length > 0) {
    await poolSql`
      INSERT INTO public.signed_link_uses
        (tenant_id, token_hash, action, subject_id, redeemed_by_ip,
         successful, failure_reason)
      VALUES (${tenantId}, ${tokenHash}, ${v.payload.action}, ${v.payload.subjectId},
              ${ip}, false, 'already_redeemed')
    `;
    return c.json({ ok: false, reason: "already_redeemed" }, 409);
  }

  try {
    await poolSql`
      INSERT INTO public.signed_link_uses
        (tenant_id, token_hash, action, subject_id, redeemed_by_ip, successful)
      VALUES (${tenantId}, ${tokenHash}, ${v.payload.action}, ${v.payload.subjectId},
              ${ip}, true)
    `;
  } catch (err) {
    const e = err as { constraint_name?: string; message?: string };
    if (
      (e.constraint_name && e.constraint_name === "uniq_signed_link_uses_tenant_token") ||
      (e.message && e.message.includes("uniq_signed_link_uses_tenant_token"))
    ) {
      // Concurrent winner — record + report 409.
      await poolSql`
        INSERT INTO public.signed_link_uses
          (tenant_id, token_hash, action, subject_id, redeemed_by_ip,
           successful, failure_reason)
        VALUES (${tenantId}, ${tokenHash}, ${v.payload.action}, ${v.payload.subjectId},
                ${ip}, false, 'already_redeemed')
      `;
      return c.json({ ok: false, reason: "already_redeemed" }, 409);
    }
    throw err;
  }

  return c.json({
    ok: true,
    action: v.payload.action,
    subjectId: v.payload.subjectId,
    expiresAt: v.payload.expiresAt.toISOString(),
    tenantId,
  });
});

const KNOWN_CANDIDATE_ACTIONS = new Set([
  "candidate.confirm_withdrawal",
  "candidate.view_offer",
  "candidate.accept_offer",
  "candidate.decline_offer",
]);

async function resolveTenantBySubject(action: string, subjectId: string): Promise<string | null> {
  if (KNOWN_CANDIDATE_ACTIONS.has(action)) {
    const rows = await poolSql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM public.candidates WHERE id = ${subjectId} LIMIT 1
    `;
    return rows[0]?.tenant_id ?? null;
  }
  // Future actions land here — add a case and the matching lookup.
  baseLog.warn({ action }, "links.unknown_action");
  return null;
}
