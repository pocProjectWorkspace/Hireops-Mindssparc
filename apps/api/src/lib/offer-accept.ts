/**
 * Shared offer-accept mechanics (Module 4 + CAND-02).
 *
 * There are TWO ways a candidate accepts an offer against the SAME `offers`
 * row with the SAME single-winner + side-effect semantics:
 *   - the public signed-link route (`POST /api/offers/accept/:token`,
 *     routes/offers.ts) — for candidates who click the emailed link;
 *   - the authenticated in-portal twin (`candidateAcceptOffer` on
 *     candidateProcedure) — for candidates signed into their dashboard.
 *
 * Both must: flip exactly one `extended` row to `accepted` (atomic winner),
 * then run the post-accept sequence — application state transition, Workday
 * Hire enqueue, onboarding-case auto-create, recruiter notice. The signed-link
 * route ALSO records a signed_link_uses row (that stays route-specific — the
 * in-portal accept has no token). Everything else lives here so the two
 * callers can never drift (CAND-02 hand-back: "REUSE the route's post-accept
 * sequence via a shared helper, do NOT duplicate").
 *
 * All work runs through a postgres.js `sql` client with an EXPLICIT tenant_id
 * on every statement — same discipline as offers.ts / onboarding-case.ts. The
 * public route passes the service-role pool (`poolSql`); the tRPC twin passes
 * `ctx.sql`.
 */

import { sql as poolSql, db as poolDb } from "@hireops/db";
import { enqueueNotification } from "@hireops/notifications";
import type { Logger } from "@hireops/observability";
import { createOnboardingCaseForApplication } from "./onboarding-case";

/** postgres.js tagged-template client (same shape as ctx.sql / poolSql). */
type PgSqlClient = typeof poolSql;

/**
 * Atomically flip the offer `extended` → `accepted`, stamping the accept
 * metadata. Returns true iff THIS call won the race (the row was still
 * `extended`); a concurrent second accept — link or portal — loses the
 * WHERE clause and gets false, which the caller maps to a 409 / CONFLICT.
 */
export async function acceptOfferAtomically(
  sql: PgSqlClient,
  args: { offerId: string; ip: string | null; userAgent: string | null },
): Promise<boolean> {
  const updated = await sql<{ id: string }[]>`
    UPDATE public.offers
    SET status = 'accepted', accepted_at = now(),
        accepted_from_ip = ${args.ip}, accepted_user_agent = ${args.userAgent},
        updated_at = now()
    WHERE id = ${args.offerId} AND status = 'extended'
    RETURNING id
  `;
  return updated.length > 0;
}

/**
 * The post-accept side-effect sequence, run AFTER a winning accept. Each step
 * is wrapped so a downstream failure (a notification, a case-creation hiccup)
 * never unwinds the already-committed, durable acceptance — mirrors the
 * original inline ordering in the public route exactly.
 */
export async function runOfferAcceptSideEffects(
  sql: PgSqlClient,
  args: { tenantId: string; applicationId: string; offerId: string; log: Logger },
): Promise<void> {
  const { tenantId, applicationId, offerId, log } = args;

  // Walk the application forward. Wrapped — a transition failure must not
  // unwind the acceptance.
  try {
    await sql`
      INSERT INTO public.application_state_transitions
        (tenant_id, application_id, from_stage, to_stage, reason)
      VALUES (${tenantId}, ${applicationId}, 'offer_drafted',
              'offer_accepted', ${"offer accepted by candidate (offer_id=" + offerId + ")"})
    `;
    await sql`
      UPDATE public.applications
      SET current_stage = 'offer_accepted', stage_entered_at = now()
      WHERE id = ${applicationId}
    `;
  } catch (err) {
    log.error({ err, offer_id: offerId }, "offers.accept.transition_failed");
  }

  await enqueueWorkdayHire(sql, { offerId, tenantId, applicationId, log });

  // Open the onboarding case + generate its checklist (ONBOARD-02). Best-effort
  // by design: the acceptance is already committed and durable, so a
  // case-creation failure is logged but must NOT unwind a valid acceptance. The
  // creation is idempotent (unique(tenant_id, application_id)); a retried accept
  // returns 409/CONFLICT before reaching here anyway, so the case is opened
  // exactly once by the winning acceptance.
  try {
    await createOnboardingCaseForApplication(sql, { tenantId, applicationId });
  } catch (err) {
    log.error({ err, offer_id: offerId }, "offers.accept.onboarding_case_failed");
  }

  await enqueueRecruiterNotice(sql, tenantId, applicationId, "recruiter.offer_accepted", {
    extraTemplateData: {
      acceptedAtFormatted: new Date().toISOString().slice(0, 16).replace("T", " "),
    },
    dedupKey: `offer_accepted_recruiter:${offerId}`,
    log,
  });
}

interface WorkdayHirePayload {
  pre_hire: {
    full_name: string;
    email: string;
    phone: string;
    address?: { city?: string; country?: string };
  };
  position: {
    requisition_external_id: string;
    title: string;
    business_unit_name: string;
    location: string;
  };
  effective_date: string;
  compensation: {
    base_annual_inr_paise: number;
    variable_target_annual_inr_paise: number | null;
    joining_bonus_inr_paise: number | null;
    currency: "INR";
  };
  source: {
    application_id: string;
    offer_id: string;
    accepted_at: string;
  };
}

/**
 * Enqueue the Workday **Pre-Hire** (Put_Applicant) outbox event fired on
 * offer-accept. Idempotent per application via its business key; best-effort
 * (never throws) so a sync-enqueue hiccup can't unwind the acceptance.
 */
export async function enqueueWorkdayHire(
  sql: PgSqlClient,
  args: { offerId: string; tenantId: string; applicationId: string; log: Logger },
): Promise<void> {
  const { offerId, tenantId, applicationId, log } = args;
  const [row] = await sql<
    {
      full_name: string;
      email: string;
      phone: string;
      requisition_external_id: string;
      title: string;
      business_unit_name: string;
      base_salary_inr_paise: bigint;
      variable_target_inr_paise: bigint | null;
      joining_bonus_inr_paise: bigint | null;
      joining_date: string;
      location: string;
    }[]
  >`
    SELECT
      p.full_name,
      p.email_primary AS email,
      p.phone_primary AS phone,
      r.id AS requisition_external_id,
      pos.title,
      bu.name AS business_unit_name,
      o.base_salary_inr_paise,
      o.variable_target_inr_paise,
      o.joining_bonus_inr_paise,
      o.joining_date,
      o.location
    FROM public.offers o
    JOIN public.applications a ON a.id = o.application_id
    JOIN public.candidates c ON c.id = a.candidate_id
    JOIN public.persons p ON p.id = c.person_id
    JOIN public.requisitions r ON r.id = a.requisition_id
    JOIN public.positions pos ON pos.id = r.position_id
    JOIN public.business_units bu ON bu.id = pos.business_unit_id
    WHERE o.id = ${offerId}
    LIMIT 1
  `;
  if (!row) {
    log.error({ offer_id: offerId }, "offers.workday_payload_lookup_failed");
    return;
  }

  const payload: WorkdayHirePayload = {
    pre_hire: {
      full_name: row.full_name,
      email: row.email,
      phone: row.phone,
    },
    position: {
      requisition_external_id: row.requisition_external_id,
      title: row.title,
      business_unit_name: row.business_unit_name,
      location: row.location,
    },
    effective_date: row.joining_date,
    compensation: {
      base_annual_inr_paise: Number(row.base_salary_inr_paise),
      variable_target_annual_inr_paise:
        row.variable_target_inr_paise !== null ? Number(row.variable_target_inr_paise) : null,
      joining_bonus_inr_paise:
        row.joining_bonus_inr_paise !== null ? Number(row.joining_bonus_inr_paise) : null,
      currency: "INR",
    },
    source: {
      application_id: applicationId,
      offer_id: offerId,
      accepted_at: new Date().toISOString(),
    },
  };

  const businessKey = `hire:application:${applicationId}`;
  try {
    await sql`
      INSERT INTO public.workday_sync_outbox
        (tenant_id, event_type, business_key, subject_application_id, payload)
      VALUES (${tenantId}, 'hire_employee', ${businessKey},
              ${applicationId}, ${JSON.stringify(payload)}::jsonb)
    `;
  } catch (err) {
    // Idempotency unique violation: this application's hire already queued.
    const e = err as { code?: string; constraint_name?: string };
    if (e.code === "23505" || e.constraint_name === "uniq_workday_sync_outbox_business_key") {
      log.info({ business_key: businessKey }, "offers.workday_hire_already_queued");
      return;
    }
    log.error({ err, offer_id: offerId }, "offers.workday_enqueue_failed");
  }
}

/**
 * Notify the requisition's primary recruiter that the offer was accepted /
 * declined. Best-effort — a lookup or enqueue failure is logged, never thrown.
 */
export async function enqueueRecruiterNotice(
  sql: PgSqlClient,
  tenantId: string,
  applicationId: string,
  templateKey: "recruiter.offer_accepted" | "recruiter.offer_declined",
  opts: { extraTemplateData: Record<string, unknown>; dedupKey: string; log: Logger },
): Promise<void> {
  const { log } = opts;
  const [row] = await sql<
    {
      recruiter_email: string;
      recruiter_name: string;
      recruiter_membership_id: string;
      candidate_name: string;
      position_title: string;
      joining_date: string;
    }[]
  >`
    SELECT
      au.email AS recruiter_email,
      COALESCE(u.display_name, au.email) AS recruiter_name,
      r.primary_recruiter_id AS recruiter_membership_id,
      p.full_name AS candidate_name,
      pos.title AS position_title,
      COALESCE((
        SELECT MAX(joining_date)::text FROM public.offers
        WHERE application_id = ${applicationId} AND status = 'accepted'
      ), '') AS joining_date
    FROM public.applications a
    JOIN public.candidates c ON c.id = a.candidate_id
    JOIN public.persons p ON p.id = c.person_id
    JOIN public.requisitions r ON r.id = a.requisition_id
    JOIN public.positions pos ON pos.id = r.position_id
    JOIN public.tenant_user_memberships tum
      ON tum.id = r.primary_recruiter_id AND tum.tenant_id = r.tenant_id
    LEFT JOIN public.users u ON u.id = tum.user_id
    JOIN auth.users au ON au.id = tum.user_id
    WHERE a.id = ${applicationId}
    LIMIT 1
  `;
  if (!row || !row.recruiter_email) {
    log.warn({ application_id: applicationId }, "offers.recruiter_notice_lookup_failed");
    return;
  }

  const portalBase = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002";

  try {
    await enqueueNotification(poolDb, {
      tenantId,
      recipientType: "recruiter",
      recipientEmail: row.recruiter_email,
      recipientMembershipId: row.recruiter_membership_id,
      templateKey,
      templateData: {
        recruiterName: row.recruiter_name,
        candidateName: row.candidate_name,
        positionTitle: row.position_title,
        joiningDate: row.joining_date,
        triageUrl: `${portalBase}/triage`,
        ...opts.extraTemplateData,
      },
      dedupKey: opts.dedupKey,
    });
  } catch (err) {
    log.warn(
      { err, application_id: applicationId, templateKey },
      "offers.recruiter_notice_enqueue_failed",
    );
  }
}
