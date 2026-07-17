import { Hono } from "hono";
import { sql as poolSql } from "@hireops/db";
import { verifyLink } from "@hireops/notifications";
import { offerAcceptRequestSchema, offerDeclineRequestSchema } from "@hireops/api-types";
import { baseLog } from "../lib/observability";
import {
  acceptOfferAtomically,
  runOfferAcceptSideEffects,
  enqueueRecruiterNotice,
} from "../lib/offer-accept";

/**
 * Public candidate accept / decline endpoints.
 *
 * Unauthenticated — the signed link IS the authorisation. Tenant is
 * resolved from the offer row (looked up by token_hash), not from a
 * session.
 *
 * Race protection: the offer row's `status = 'extended'` check + the
 * partial UNIQUE on (tenant_id, application_id) WHERE status='extended'
 * + a per-offer guard inside the tx mean only one accept|decline wins.
 * The losing call gets a 409.
 *
 * Mirrors the discipline of /api/links/:token (Module 3): every attempt
 * — success, expired, mismatched name, already-resolved — records a
 * signed_link_uses row.
 */
export const offersRoutes = new Hono();

interface OfferRow {
  id: string;
  tenant_id: string;
  application_id: string;
  status: string;
  // postgres-js sometimes returns timestamptz as a Date, sometimes as a
  // string depending on parser config. Treat as either; coerce at use.
  expiry_at: Date | string;
  accepted_user_agent: string | null;
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/**
 * GET /api/offers/preview/:token
 *
 * Public — used by the candidate page to render the offer summary card
 * before the candidate clicks Accept/Decline. Does NOT consume the
 * signed link; the actual consumption happens on POST. The endpoint
 * returns just enough for the summary: position title, joining date,
 * compensation, location, expiry, plus the expected full_name hint so
 * the UI can pre-fill the confirmation field (we still re-check on
 * accept).
 */
offersRoutes.get("/preview/:token", async (c) => {
  const token = c.req.param("token");
  const verify = verifyLink(token);
  if (!verify.ok) {
    return c.json({ ok: false, reason: verify.reason }, 400);
  }
  if (verify.payload.action !== "candidate.accept_offer") {
    return c.json({ ok: false, reason: "wrong_action" }, 400);
  }
  const tokenHash = verify.payload.tokenHash;

  const [row] = await poolSql<
    {
      id: string;
      application_id: string;
      status: string;
      base_salary_inr_paise: bigint;
      variable_target_inr_paise: bigint | null;
      joining_bonus_inr_paise: bigint | null;
      joining_date: string;
      location: string;
      expiry_at: Date | string;
      terms_html: string | null;
      candidate_full_name: string;
      candidate_email: string;
      position_title: string;
      company_name: string;
    }[]
  >`
    SELECT
      o.id,
      o.application_id,
      o.status,
      o.base_salary_inr_paise,
      o.variable_target_inr_paise,
      o.joining_bonus_inr_paise,
      o.joining_date,
      o.location,
      o.expiry_at,
      o.terms_html,
      p.full_name AS candidate_full_name,
      p.email_primary AS candidate_email,
      pos.title AS position_title,
      t.display_name AS company_name
    FROM public.offers o
    JOIN public.applications a ON a.id = o.application_id
    JOIN public.candidates c ON c.id = a.candidate_id
    JOIN public.persons p ON p.id = c.person_id
    JOIN public.requisitions r ON r.id = a.requisition_id
    JOIN public.positions pos ON pos.id = r.position_id
    JOIN public.tenants t ON t.id = o.tenant_id
    WHERE o.accept_signed_link_token_hash = ${tokenHash}
    LIMIT 1
  `;
  if (!row) return c.json({ ok: false, reason: "offer_not_found" }, 404);

  return c.json({
    ok: true,
    offerId: row.id,
    status: row.status,
    candidateFullName: row.candidate_full_name,
    candidateEmail: row.candidate_email,
    companyName: row.company_name,
    positionTitle: row.position_title,
    baseSalaryInrPaise: Number(row.base_salary_inr_paise),
    variableTargetInrPaise:
      row.variable_target_inr_paise !== null ? Number(row.variable_target_inr_paise) : null,
    joiningBonusInrPaise:
      row.joining_bonus_inr_paise !== null ? Number(row.joining_bonus_inr_paise) : null,
    joiningDate: row.joining_date,
    location: row.location,
    expiryAt: toDate(row.expiry_at).toISOString(),
    termsHtml: row.terms_html,
  });
});

offersRoutes.post("/accept/:token", async (c) => {
  const token = c.req.param("token");
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = c.req.header("user-agent") ?? null;

  const verify = verifyLink(token);
  if (!verify.ok) {
    baseLog.warn({ reason: verify.reason, ip }, "offers.accept.verify_rejected");
    return c.json({ ok: false, reason: verify.reason }, 400);
  }
  if (verify.payload.action !== "candidate.accept_offer") {
    return c.json({ ok: false, reason: "wrong_action" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = offerAcceptRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, reason: "invalid_body" }, 400);
  }

  const tokenHash = verify.payload.tokenHash;

  const [offer] = await poolSql<OfferRow[]>`
    SELECT id, tenant_id, application_id, status, expiry_at, accepted_user_agent
    FROM public.offers
    WHERE accept_signed_link_token_hash = ${tokenHash}
    LIMIT 1
  `;
  if (!offer) {
    return c.json({ ok: false, reason: "offer_not_found" }, 404);
  }

  // Name-match defence — the candidate's full_name as stored on the
  // person record. Case-insensitive trim compare; the candidate doesn't
  // know "how" we stored it.
  const [candidate] = await poolSql<
    { full_name: string; email: string; person_id: string; candidate_id: string }[]
  >`
    SELECT p.full_name, p.email_primary AS email, p.id AS person_id, c.id AS candidate_id
    FROM public.applications a
    JOIN public.candidates c ON c.id = a.candidate_id
    JOIN public.persons p ON p.id = c.person_id
    WHERE a.id = ${offer.application_id}
    LIMIT 1
  `;
  if (!candidate) {
    return c.json({ ok: false, reason: "candidate_not_found" }, 404);
  }
  if (normaliseName(candidate.full_name) !== normaliseName(parsed.data.fullName)) {
    await recordLinkUse(offer.tenant_id, tokenHash, offer.id, ip, false, "name_mismatch");
    return c.json({ ok: false, reason: "name_mismatch" }, 403);
  }

  if (offer.status !== "extended") {
    await recordLinkUse(offer.tenant_id, tokenHash, offer.id, ip, false, "status_not_extended");
    return c.json({ ok: false, reason: "already_resolved", status: offer.status }, 409);
  }
  if (toDate(offer.expiry_at).getTime() < Date.now()) {
    await recordLinkUse(offer.tenant_id, tokenHash, offer.id, ip, false, "expired");
    return c.json({ ok: false, reason: "expired" }, 400);
  }

  // Atomic transition: only the row whose status is still 'extended'
  // gets accepted; another concurrent attempt fails the WHERE clause. The
  // single-winner UPDATE + the post-accept side-effect sequence are shared
  // verbatim with the in-portal twin (candidateAcceptOffer).
  const won = await acceptOfferAtomically(poolSql, {
    offerId: offer.id,
    ip,
    userAgent,
  });
  if (!won) {
    await recordLinkUse(offer.tenant_id, tokenHash, offer.id, ip, false, "concurrent_resolve");
    return c.json({ ok: false, reason: "already_resolved" }, 409);
  }

  await runOfferAcceptSideEffects(poolSql, {
    tenantId: offer.tenant_id,
    applicationId: offer.application_id,
    offerId: offer.id,
    log: baseLog,
  });
  await recordLinkUse(offer.tenant_id, tokenHash, offer.id, ip, true, null);

  return c.json({
    ok: true,
    offerId: offer.id,
    applicationId: offer.application_id,
  });
});

offersRoutes.post("/decline/:token", async (c) => {
  const token = c.req.param("token");
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  const verify = verifyLink(token);
  if (!verify.ok) {
    return c.json({ ok: false, reason: verify.reason }, 400);
  }
  if (verify.payload.action !== "candidate.accept_offer") {
    return c.json({ ok: false, reason: "wrong_action" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = offerDeclineRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, reason: "invalid_body" }, 400);
  }

  const tokenHash = verify.payload.tokenHash;

  const [offer] = await poolSql<OfferRow[]>`
    SELECT id, tenant_id, application_id, status, expiry_at, accepted_user_agent
    FROM public.offers
    WHERE accept_signed_link_token_hash = ${tokenHash}
    LIMIT 1
  `;
  if (!offer) return c.json({ ok: false, reason: "offer_not_found" }, 404);
  if (offer.status !== "extended") {
    return c.json({ ok: false, reason: "already_resolved", status: offer.status }, 409);
  }

  const updated = await poolSql<{ id: string }[]>`
    UPDATE public.offers
    SET status = 'declined', declined_at = now(),
        declined_reason = ${parsed.data.reason ?? null},
        updated_at = now()
    WHERE id = ${offer.id} AND status = 'extended'
    RETURNING id
  `;
  if (updated.length === 0) {
    return c.json({ ok: false, reason: "already_resolved" }, 409);
  }

  try {
    await poolSql`
      INSERT INTO public.application_state_transitions
        (tenant_id, application_id, from_stage, to_stage, reason)
      VALUES (${offer.tenant_id}, ${offer.application_id}, 'offer_drafted',
              'offer_declined', ${"offer declined by candidate (offer_id=" + offer.id + ")"})
    `;
    await poolSql`
      UPDATE public.applications
      SET current_stage = 'offer_declined', stage_entered_at = now()
      WHERE id = ${offer.application_id}
    `;
  } catch (err) {
    baseLog.error({ err, offer_id: offer.id }, "offers.decline.transition_failed");
  }

  await enqueueRecruiterNotice(
    poolSql,
    offer.tenant_id,
    offer.application_id,
    "recruiter.offer_declined",
    {
      extraTemplateData: {
        declinedAtFormatted: new Date().toISOString().slice(0, 16).replace("T", " "),
        declinedReason: parsed.data.reason ?? null,
      },
      dedupKey: `offer_declined_recruiter:${offer.id}`,
      log: baseLog,
    },
  );
  await recordLinkUse(offer.tenant_id, tokenHash, offer.id, ip, true, null);

  return c.json({
    ok: true,
    offerId: offer.id,
    applicationId: offer.application_id,
  });
});

function normaliseName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

async function recordLinkUse(
  tenantId: string,
  tokenHash: string,
  offerId: string,
  ip: string | null,
  successful: boolean,
  failureReason: string | null,
): Promise<void> {
  try {
    await poolSql`
      INSERT INTO public.signed_link_uses
        (tenant_id, token_hash, action, subject_id, redeemed_by_ip, successful, failure_reason)
      VALUES (${tenantId}, ${tokenHash}, 'candidate.accept_offer', ${offerId},
              ${ip}, ${successful}, ${failureReason})
    `;
  } catch (err) {
    // Partial unique on (tenant, token_hash) WHERE successful=true blocks
    // double-successful redemptions; failed records can stack.
    baseLog.warn({ err, offer_id: offerId, successful }, "offers.record_link_use_skipped");
  }
}
