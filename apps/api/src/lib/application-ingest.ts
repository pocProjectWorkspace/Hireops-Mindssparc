/**
 * Shared ingest core: CV in storage → candidate + application in the pipeline.
 *
 * Extracted from the router's `ingestPartnerApplication` (PARTNER-02) for PC-2
 * so that the partner submission path and the bulk-CV drain (apps/workers,
 * bulk-cv-drain.ts) run ONE implementation of:
 *
 *   - parse the stored CV (`parseStoredResume`)
 *   - person lookup by normalised email, then phone (`findPersonByContact`)
 *   - knockout evaluation, candidate upsert (one per person per tenant),
 *     application upsert (one per candidate per requisition), and the AI
 *     scoring enqueue (`ingestApplication`)
 *
 * so a candidate is indistinguishable downstream whichever door they came in
 * by — triage, knockouts and scoring all apply identically.
 *
 * WHAT IS NOT HERE, ON PURPOSE:
 *   - authorisation (the caller's job: partner assignment, recruiter role)
 *   - ownership claims and partner receipts (partner-only policy)
 *   - ANY candidate notification. Sending email is a per-door decision: the
 *     public apply form acknowledges the candidate who just applied; a bulk
 *     upload must not email a person who never contacted us.
 *
 * Framework-free: no TRPCError, no tRPC context — the worker calls this with a
 * tenant-bound transaction it opened itself. `db` must be tenant-bound
 * (withTenantContext) so RLS and the audit trigger attribution apply.
 *
 * The public apply path (`submitApplication`) still has its own inline copy of
 * these steps; it runs on the service-role pool rather than a tenant-bound tx
 * and is owned by the apply-form work, so it was left untouched here.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  aiScoreOutbox,
  applications,
  candidates,
  persons,
  requisitionKnockouts,
  tenants,
  type ApplicationSource,
  type TenantBoundDb,
} from "@hireops/db";
import { evaluateKnockouts, type KnockoutInput } from "@hireops/ai-scoring";
import { parseResume, type ParserOutput } from "@hireops/ai-client";
import type { Logger } from "@hireops/observability";
import {
  normalisePhone as normalisePhoneE164,
  phoneMatchKeys,
  resolveTenantDefaultCountry,
  type ScreeningAnswersInput,
  type ScreeningAnswersSource,
} from "@hireops/api-types";
import { getStorageClient } from "./storage";
import { resolveScreeningAnswersForInsert, screeningKnockoutView } from "./screening-answers";

// ─────────────────────────── contact normalisation ───────────────────────────

/**
 * Lowercase, drop +suffix in the local part. Gmail dot-stripping is
 * deferred — see persons.emailNormalised comment in @hireops/db.
 */
export function normaliseEmail(email: string): string {
  const lowered = email.toLowerCase();
  const atIndex = lowered.indexOf("@");
  if (atIndex < 0) return lowered;
  const local = lowered.slice(0, atIndex);
  const domain = lowered.slice(atIndex + 1);
  const plusIndex = local.indexOf("+");
  const trimmedLocal = plusIndex < 0 ? local : local.slice(0, plusIndex);
  return `${trimmedLocal}@${domain}`;
}

/**
 * C1-BUGS BUG-5 — E.164 when the number's country is known (explicit "+"/"00"
 * prefix, else the person's country, else the tenant's `defaultCountry`
 * setting); digits only when it is not. No platform default country. See
 * @hireops/api-types phone.ts.
 */
export function normalisePhone(phone: string, country?: string | null): string {
  return normalisePhoneE164(phone, country);
}

/**
 * The country used to place a bare national phone number: the person's own
 * country when supplied, else the tenant's `settings.defaultCountry`, else
 * null. Reads tenants (RLS: a tenant-bound db reads its own row; the
 * service-role pool reads any). Never throws for a missing row.
 */
export async function resolvePhoneCountry(
  db: Pick<TenantBoundDb, "select">,
  tenantId: string,
  personCountry: string | null | undefined,
): Promise<string | null> {
  const own = personCountry?.trim().toUpperCase();
  if (own && own.length === 2) return own;
  const [row] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return resolveTenantDefaultCountry(row?.settings ?? null);
}

/**
 * The `persons.phone_normalised` values a normalised phone may be stored as —
 * E.164 plus the pre-BUG-5 digits-only forms — so a lookup finds people
 * written before the fix. Use with `inArray`.
 */
export function phoneLookupKeys(phoneNormalised: string): string[] {
  return phoneMatchKeys(phoneNormalised);
}

// ─────────────────────────── scoring decision ───────────────────────────

/**
 * Parser confidence (`parse_metadata.confidence_score`) below this
 * floor skips AI scoring at submit time — the LLM input would be too
 * unreliable to score against. Logged on the application as
 * `ai_score_explanation = { scored_by: 'skipped', reason:
 * 'parser_confidence_below_threshold', confidence: <value> }`. 0.5 is
 * the AI-03 v1 threshold; tunable here, not per-tenant.
 */
export const PARSER_CONFIDENCE_SCORING_FLOOR = 0.5;

/**
 * Decide the scoring fields an application row should carry at insert time,
 * shared by every ingest door so all get IDENTICAL downstream treatment.
 * Returns the synchronous ai_score_explanation for the skipped cases
 * (knockouts failed, parser confidence below floor) and whether an
 * ai_score_outbox row should be enqueued (only when eligible). Pure — no DB.
 */
export function computeInitialScoringState(
  knockoutPassed: boolean | null,
  parserConfidence: number | null,
  evaluatedAt: Date,
): { initialAiScoreExplanation: Record<string, unknown> | null; outboxEligible: boolean } {
  if (knockoutPassed === false) {
    return {
      initialAiScoreExplanation: {
        scored_by: "skipped",
        reason: "knockouts_failed",
        skipped_at: evaluatedAt.toISOString(),
      },
      outboxEligible: false,
    };
  }
  if (parserConfidence !== null && parserConfidence < PARSER_CONFIDENCE_SCORING_FLOOR) {
    return {
      initialAiScoreExplanation: {
        scored_by: "skipped",
        reason: "parser_confidence_below_threshold",
        confidence: parserConfidence,
        skipped_at: evaluatedAt.toISOString(),
      },
      outboxEligible: false,
    };
  }
  return { initialAiScoreExplanation: null, outboxEligible: true };
}

// ─────────────────────────── parse ───────────────────────────

/** The `parseResume` signature, as an injectable dependency. */
export type ResumeParser = (
  buffer: Buffer,
  mimeType: string,
  opts: { tenantId: string; requestId?: string | null; actorMembershipId?: string | null },
) => Promise<ParserOutput>;

export interface StoredResumeParse {
  parseStatus: "received" | "parse_failed";
  /** The full parser output, or null when the parser threw. */
  parsed: ParserOutput | null;
  parserConfidence: number | null;
  yearsOfExperience: number | null;
}

/**
 * Fetch a stored CV and run the resume parser over it. Never throws for a
 * parse problem — an unreadable CV is `parse_failed`, the same contract the
 * apply and partner paths have always had. Storage errors DO propagate when
 * `rethrowStorageErrors` is set (the drain wants to retry a transient storage
 * outage rather than record a permanent parse failure).
 */
export async function parseStoredResume(
  storageKey: string,
  opts: {
    tenantId: string;
    log: Logger;
    requestId?: string | null;
    actorMembershipId?: string | null;
    logLabel: string;
    rethrowStorageErrors?: boolean;
    /** Test seam: replaces `parseResume` (the drain test injects canned output). */
    parser?: ResumeParser;
  },
): Promise<StoredResumeParse> {
  const storage = getStorageClient();
  let obj: Awaited<ReturnType<typeof storage.get>>;
  try {
    obj = await storage.get(storageKey);
  } catch (err) {
    if (opts.rethrowStorageErrors) throw err;
    opts.log.error({ err, request_id: opts.requestId }, `${opts.logLabel}: storage get threw`);
    return {
      parseStatus: "parse_failed",
      parsed: null,
      parserConfidence: null,
      yearsOfExperience: null,
    };
  }
  try {
    const parsed = await (opts.parser ?? parseResume)(obj.buffer, obj.contentType, {
      tenantId: opts.tenantId,
      requestId: opts.requestId ?? null,
      actorMembershipId: opts.actorMembershipId ?? null,
    });
    return {
      parseStatus: parsed.parse_metadata.confidence_score === 0 ? "parse_failed" : "received",
      parsed,
      parserConfidence: parsed.parse_metadata.confidence_score,
      yearsOfExperience: parsed.total_years_experience,
    };
  } catch (err) {
    opts.log.error({ err, request_id: opts.requestId }, `${opts.logLabel}: parseResume threw`);
    return {
      parseStatus: "parse_failed",
      parsed: null,
      parserConfidence: null,
      yearsOfExperience: null,
    };
  }
}

// ─────────────────────────── person lookup ───────────────────────────

export interface PersonMatch {
  id: string;
  linkedinUrl: string | null;
  fullName: string | null;
}

/**
 * Resolve an EXISTING person by exact normalised email (the Wave-1 dedup
 * pivot per partner-data-model.md), falling back to normalised phone. No fuzzy
 * matching. Lookup only — creating the person is the caller's decision.
 * A null/empty identifier is simply not used for matching.
 */
export async function findPersonByContact(
  db: TenantBoundDb,
  tenantId: string,
  contact: { emailNormalised: string | null; phoneNormalised: string | null },
): Promise<PersonMatch | null> {
  const cols = { id: persons.id, linkedinUrl: persons.linkedinUrl, fullName: persons.fullName };
  if (contact.emailNormalised) {
    const [emailMatch] = await db
      .select(cols)
      .from(persons)
      .where(
        and(eq(persons.tenantId, tenantId), eq(persons.emailNormalised, contact.emailNormalised)),
      )
      .limit(1);
    if (emailMatch) return emailMatch;
  }
  if (contact.phoneNormalised) {
    // BUG-5: match the E.164 value AND the legacy digits-only forms.
    const [phoneMatch] = await db
      .select(cols)
      .from(persons)
      .where(
        and(
          eq(persons.tenantId, tenantId),
          inArray(persons.phoneNormalised, phoneLookupKeys(contact.phoneNormalised)),
        ),
      )
      .orderBy(persons.createdAt)
      .limit(1);
    if (phoneMatch) return phoneMatch;
  }
  return null;
}

/** The candidate's application on a requisition, if any. */
export async function findApplicationForPersonOnRequisition(
  db: TenantBoundDb,
  tenantId: string,
  personId: string,
  requisitionId: string,
): Promise<{ candidateId: string; applicationId: string } | null> {
  const [row] = await db
    .select({ candidateId: candidates.id, applicationId: applications.id })
    .from(candidates)
    .innerJoin(
      applications,
      and(
        eq(applications.tenantId, candidates.tenantId),
        eq(applications.candidateId, candidates.id),
      ),
    )
    .where(
      and(
        eq(candidates.tenantId, tenantId),
        eq(candidates.personId, personId),
        eq(applications.requisitionId, requisitionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ─────────────────────────── candidate + application ───────────────────────────

export interface IngestApplicationArgs {
  tenantId: string;
  requisitionId: string;
  personId: string;
  resumeUploadKey: string;
  source: ApplicationSource;
  /** The parse of `resumeUploadKey` (see parseStoredResume). */
  parse: StoredResumeParse;
  /**
   * Candidate-row consent stamp, used ONLY when a new candidate row is
   * created. Partner: the partner's attestation. Bulk upload: null/null — the
   * candidate has consented to nothing; the basis lives on the batch.
   */
  candidateConsent: { grantedAt: Date | null; version: string | null };
  /** Partner attribution columns on the application (partner door only). */
  partner?: {
    partnerOrgId: string;
    partnerUserId: string;
    submissionMetadata: Record<string, unknown>;
  };
  /**
   * PC-7 — screening answers for a NEW application row (notice period,
   * current/expected CTC, location). Notice is pre-filled from the parsed CV
   * when not supplied; the stored values feed the asserted knockouts.
   */
  screening?: { supplied?: ScreeningAnswersInput; source: ScreeningAnswersSource };
  log: Logger;
  requestId: string;
  /** Log message prefix, e.g. "partnerSubmit". */
  logLabel: string;
}

export interface IngestApplicationResult {
  candidateId: string;
  applicationId: string;
  wasNewCandidate: boolean;
  wasNewApplication: boolean;
  parseStatus: "received" | "parse_failed";
}

function firstOrThrow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`expected at least one row from ${label}`);
  return row;
}

/**
 * Materialise a person into the recruitment pipeline for one requisition:
 * evaluate knockouts, upsert the candidate (one per person per tenant), upsert
 * the application for this req, and enqueue AI scoring when eligible. Runs on
 * the caller's tenant-bound tx so it commits/rolls back atomically with
 * whatever decision the caller wraps around it.
 */
export async function ingestApplication(
  db: TenantBoundDb,
  args: IngestApplicationArgs,
): Promise<IngestApplicationResult> {
  const { tenantId, requisitionId, personId, parse } = args;
  const parsedSkills: unknown = parse.parsed;

  // Knockout evaluation (deterministic, no AI call) — identical to apply.
  const knockoutRows = await db
    .select({
      id: requisitionKnockouts.id,
      type: requisitionKnockouts.type,
      source: requisitionKnockouts.source,
      questionText: requisitionKnockouts.questionText,
      thresholdValue: requisitionKnockouts.thresholdValue,
    })
    .from(requisitionKnockouts)
    .where(
      and(
        eq(requisitionKnockouts.tenantId, tenantId),
        eq(requisitionKnockouts.requisitionId, requisitionId),
      ),
    )
    .orderBy(requisitionKnockouts.orderIndex);
  const knockoutInputs: KnockoutInput[] = knockoutRows.map((r) => ({
    id: r.id,
    type: r.type,
    source: r.source,
    questionText: r.questionText,
    thresholdValue: r.thresholdValue,
  }));
  const screeningCols = resolveScreeningAnswersForInsert({
    supplied: args.screening?.supplied,
    parsedCv: parsedSkills,
    source: args.screening?.source ?? "import",
  });
  const knockoutEval = evaluateKnockouts(
    parsedSkills,
    knockoutInputs,
    screeningKnockoutView(screeningCols),
  );
  const knockoutEvaluatedAt = new Date();

  // Upsert candidate by (tenant, person).
  const [existingCandidate] = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.tenantId, tenantId), eq(candidates.personId, personId)))
    .limit(1);
  const wasNewCandidate = !existingCandidate?.id;
  const candidateId = existingCandidate?.id
    ? existingCandidate.id
    : await db
        .insert(candidates)
        .values({
          tenantId,
          personId,
          source: args.source,
          consentGrantedAt: args.candidateConsent.grantedAt,
          consentVersion: args.candidateConsent.version,
          currentResumeUrl: args.resumeUploadKey,
          parsedSkills,
          yearsOfExperience:
            parse.yearsOfExperience !== null ? parse.yearsOfExperience.toFixed(1) : null,
        })
        .returning({ id: candidates.id })
        .then((rows) => firstOrThrow(rows, `${args.logLabel} candidate insert`).id);

  // Upsert application by (tenant, candidate, req).
  const [existingApp] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.tenantId, tenantId),
        eq(applications.candidateId, candidateId),
        eq(applications.requisitionId, requisitionId),
      ),
    )
    .limit(1);

  const { initialAiScoreExplanation, outboxEligible } = computeInitialScoringState(
    knockoutEval.passed,
    parse.parserConfidence,
    knockoutEvaluatedAt,
  );

  const wasNewApplication = !existingApp?.id;
  const applicationId = existingApp?.id
    ? existingApp.id
    : await db
        .insert(applications)
        .values({
          tenantId,
          candidateId,
          requisitionId,
          source: args.source,
          knockoutPassed: knockoutEval.passed,
          knockoutFailures: knockoutEval.failures.length > 0 ? knockoutEval.failures : null,
          knockoutEvaluatedAt,
          aiScoreExplanation: initialAiScoreExplanation,
          ...(args.partner
            ? {
                sourcePartnerId: args.partner.partnerOrgId,
                submittedByPartnerUserId: args.partner.partnerUserId,
                partnerSubmissionMetadata: args.partner.submissionMetadata,
              }
            : {}),
          ...screeningCols,
        })
        .returning({ id: applications.id })
        .then((rows) => firstOrThrow(rows, `${args.logLabel} application insert`).id);

  // Enqueue AI scoring only on first apply + eligibility — same rule as apply.
  if (wasNewApplication && outboxEligible) {
    try {
      await db.insert(aiScoreOutbox).values({ tenantId, applicationId });
    } catch (err) {
      args.log.warn(
        { err, request_id: args.requestId, application_id: applicationId },
        `${args.logLabel}: ai_score_outbox enqueue failed`,
      );
    }
  }

  return {
    candidateId,
    applicationId,
    wasNewCandidate,
    wasNewApplication,
    parseStatus: parse.parseStatus,
  };
}
