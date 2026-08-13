/**
 * P0.4/P0.5 — the partner-facing stage-change email, in one place.
 *
 * These helpers were born inline in the tRPC router next to
 * transitionApplicationStage (P0.4, commit 83205c4), which covered every
 * partner-visible stage move made through tRPC. P0.5 found the two paths that
 * are NOT tRPC transitions: the candidate's own accept and decline, which walk
 * the application forward with raw SQL in lib/offer-accept.ts and
 * routes/offers.ts and therefore never reached the router's enqueue. Those are
 * precisely the two outcomes a sourcing partner most needs to hear about, so
 * the helpers moved here verbatim and all three call sites now share them.
 *
 * Behaviour is deliberately unchanged from the router-local originals:
 *   - PARTNER_VISIBLE_STAGES is the allowlist and the ONLY thing that decides
 *     whether a partner hears about a stage at all;
 *   - the payload is stage + date + candidate name and nothing else
 *     (requirements.md §6.3) — no reason, no score, no feedback, no
 *     interviewer, no hint that another partner exists;
 *   - the enqueue runs in a SAVEPOINT and absorbs 23505 so a duplicate can
 *     never fail the business event that triggered it;
 *   - a deactivated submitting partner user gets nothing.
 *
 * The db handle is the caller's: a withTenantContext transaction from a tRPC
 * procedure, or the service-role pool from the two public offer routes (the
 * same pool enqueueRecruiterNotice already writes the recruiter's copy on).
 */

import { and, eq, isNotNull } from "drizzle-orm";
import {
  db as poolDb,
  applications,
  candidates,
  partnerUsers,
  persons,
  positions,
  requisitions,
  tenants,
  type ApplicationStage,
  type TenantBoundDb,
} from "@hireops/db";
import { enqueueNotification } from "@hireops/notifications";
import type { Logger } from "@hireops/observability";

/**
 * Any drizzle handle these helpers can run on: the pool (the two public offer
 * routes, which are service-role and have no session to bind) or a
 * withTenantContext transaction (every tRPC caller). Neither is assignable to
 * the other — the pool carries `$client`, the transaction carries `rollback` —
 * so the alias is a union. Both members inherit `select` / `transaction` from
 * the same PgDatabase declaration, which is what keeps the union callable.
 */
export type PartnerEmailDb = typeof poolDb | TenantBoundDb;

/**
 * The slice of a tRPC context these helpers actually use. Declared structurally
 * so the two public offer routes — which have a bare `baseLog` and no request
 * id — can call in without inventing a fake context.
 */
export interface PartnerEmailLogContext {
  log: Logger;
  requestId?: string | null;
}

/**
 * P0.4 — the ONLY stages a sourcing partner is told about.
 *
 * Deliberately shorter than the candidate-facing list: a partner gets the
 * milestones that change what they should do (their candidate is in play, is
 * interviewing, has an outcome), not the internal micro-moves. offer_drafted is
 * excluded on purpose — "an offer is being prepared" is commercially sensitive
 * and changes nothing for the partner until it is accepted or declined.
 *
 * Whatever lands here, the email carries stage + date + candidate name and
 * NOTHING else (requirements.md §6.3).
 */
export const PARTNER_VISIBLE_STAGES = new Set<ApplicationStage>([
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_accepted",
  "offer_declined",
  "recruiter_rejected",
  "withdrawn",
]);

/**
 * The subset of the above that ENDS the candidate's run. These get the neutral
 * "no longer progressing" copy — the stage label is stated, the reason never is
 * (a partner never learns WHY, only THAT).
 */
export const PARTNER_TERMINAL_STAGES = new Set<ApplicationStage>([
  "offer_declined",
  "recruiter_rejected",
  "withdrawn",
]);

/**
 * The human label the partner reads, for each allowlisted stage.
 *
 * P0.4 borrowed the router's STAGE_LABELS here, on the reasoning that the
 * router already owned the shared map. P0.5 has callers that are NOT the
 * router (routes/offers.ts, lib/offer-accept.ts) and cannot import it without
 * a cycle, so the partner-facing labels move in beside the allowlist they
 * belong to: one file now decides which stages a partner hears about AND what
 * they are called. Strings are the router's verbatim, so the emails P0.4
 * already sends are byte-identical (partner-notifications.test.ts Tests 4/5
 * pin "Shortlisted" and "Not moving forward").
 *
 * The router's STAGE_LABELS stays where it is: it also feeds the CANDIDATE
 * email and two read surfaces, which have their own audience.
 */
const PARTNER_STAGE_LABELS: Partial<Record<ApplicationStage, string>> = {
  shortlisted: "Shortlisted",
  tech_interview: "Technical interview",
  hr_round: "HR round",
  offer_accepted: "Offer accepted",
  offer_declined: "Offer declined",
  recruiter_rejected: "Not moving forward",
  withdrawn: "Withdrawn",
};

/** "13 August 2026" — date-only, UTC. Same discipline as the partner
 * invitation's expiry line: the minute is noise and a date-only string
 * sidesteps the recipient-timezone question. */
export function formatPartnerEmailDate(d: Date): string {
  return `${d.getUTCDate()} ${PARTNER_EMAIL_MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()}`;
}

const PARTNER_EMAIL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Postgres unique-violation detector (SQLSTATE 23505), driver-tolerant.
 * Mirrors the router's private copy (and the ownership-claim sweep's). */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}

/**
 * Enqueue one partner-facing email inside the caller's transaction, tolerating
 * the dedup collision.
 *
 * The insert runs in a NESTED transaction (SAVEPOINT) because notification_
 * outbox's partial unique on (tenant_id, dedup_key) is how "send this once"
 * is enforced: a second enqueue of the same logical event raises 23505, and
 * without the savepoint that would poison the OUTER transaction and fail the
 * stage transition / submission that triggered it. Rolling back to the
 * savepoint turns a duplicate into a clean no-op. Any other failure is logged
 * and swallowed for the same reason the candidate-facing enqueue is — a
 * notification problem must never undo the business event.
 */
export async function enqueuePartnerEmail(
  db: PartnerEmailDb,
  ctx: PartnerEmailLogContext,
  args: Parameters<typeof enqueueNotification>[1],
): Promise<void> {
  try {
    await db.transaction((tx) => enqueueNotification(tx, args));
  } catch (err) {
    if (isUniqueViolation(err)) return; // already enqueued — nothing to do
    ctx.log.warn(
      { err, request_id: ctx.requestId, dedup_key: args.dedupKey },
      "enqueuePartnerEmail: enqueueNotification failed",
    );
  }
}

export interface PartnerStageEmailContext {
  partnerEmail: string;
  partnerContactName: string;
  candidateName: string;
  requisitionTitle: string;
  companyName: string;
}

/**
 * The partner-facing address book for one application, or null when there is
 * nobody to write to.
 *
 * Null (i.e. no email) for a direct/referral application, for a partner-sourced
 * application whose submitting user was never recorded, and for a submitter
 * whose partner_users row has since been deactivated — a deactivated partner
 * user has had their access revoked, so continuing to mail them candidate
 * updates would be exactly the leak the deactivation was for.
 */
export async function fetchPartnerStageEmailContext(
  db: PartnerEmailDb,
  applicationId: string,
): Promise<PartnerStageEmailContext | null> {
  const [row] = await db
    .select({
      partnerEmail: partnerUsers.email,
      partnerContactName: partnerUsers.fullName,
      candidateName: persons.fullName,
      requisitionTitle: positions.title,
      companyName: tenants.displayName,
    })
    .from(applications)
    .innerJoin(
      partnerUsers,
      and(
        eq(partnerUsers.tenantId, applications.tenantId),
        eq(partnerUsers.id, applications.submittedByPartnerUserId),
        eq(partnerUsers.active, true),
      ),
    )
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(persons, eq(persons.id, candidates.personId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(positions, eq(positions.id, requisitions.positionId))
    .innerJoin(tenants, eq(tenants.id, applications.tenantId))
    .where(and(eq(applications.id, applicationId), isNotNull(applications.sourcePartnerId)))
    .limit(1);
  if (!row) return null;
  return {
    partnerEmail: row.partnerEmail,
    partnerContactName: row.partnerContactName,
    candidateName: row.candidateName ?? "your candidate",
    requisitionTitle: row.requisitionTitle,
    companyName: row.companyName,
  };
}

/**
 * The whole partner half of "this application moved to <stage>", as one call.
 *
 * Never throws: every caller here is finishing a business event that has
 * already happened (a committed stage transition, a committed acceptance), and
 * a notification must never be able to unwind or fail it. The allowlist check
 * and the label lookup both live inside, so no call site — router, offer route
 * or a future one — can accidentally widen the first or reword the second.
 */
export async function enqueuePartnerStageChangedEmail(
  db: PartnerEmailDb,
  ctx: PartnerEmailLogContext,
  args: {
    tenantId: string;
    applicationId: string;
    toStage: ApplicationStage;
  },
): Promise<void> {
  if (!PARTNER_VISIBLE_STAGES.has(args.toStage)) return;

  const partnerMeta = await fetchPartnerStageEmailContext(db, args.applicationId).catch(
    (err: unknown) => {
      ctx.log.warn(
        { err, request_id: ctx.requestId, application_id: args.applicationId },
        "enqueuePartnerStageChangedEmail: partner email context lookup failed",
      );
      return null;
    },
  );
  if (!partnerMeta) return;

  await enqueuePartnerEmail(db, ctx, {
    tenantId: args.tenantId,
    recipientType: "partner",
    recipientEmail: partnerMeta.partnerEmail,
    templateKey: "partner.stage_changed",
    templateData: {
      partnerContactName: partnerMeta.partnerContactName,
      candidateName: partnerMeta.candidateName,
      requisitionTitle: partnerMeta.requisitionTitle,
      companyName: partnerMeta.companyName,
      stageLabel: PARTNER_STAGE_LABELS[args.toStage] ?? args.toStage,
      changedAtFormatted: formatPartnerEmailDate(new Date()),
      isTerminal: PARTNER_TERMINAL_STAGES.has(args.toStage),
    },
    // Once per (application, destination stage), ever — a bounce back and
    // forth between two stages must not re-mail the partner each lap.
    dedupKey: `partner_stage:${args.applicationId}:${args.toStage}`,
  });
}
