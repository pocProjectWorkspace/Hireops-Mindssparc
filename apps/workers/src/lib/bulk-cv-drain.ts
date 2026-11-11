/**
 * PC-2 — drains queued bulk_cv_items: stored CV → parsed → candidate +
 * application on the batch's requisition (or a duplicate / failure with a
 * reason the recruiter can act on).
 *
 * Per claimed item:
 *   1. The requisition must still accept candidates (approved / posted) —
 *      a req closed mid-batch stops creating applications ('failed',
 *      requisition_not_accepting; retryable once it is reopened).
 *   2. Parse the stored CV with the SAME parser + wrapper the partner path
 *      uses (`parseStoredResume`, @hireops/api/application-ingest). Done
 *      OUTSIDE any transaction — it is a model call.
 *        - storage object gone          → 'failed' file_missing (terminal)
 *        - other storage error          → retry with backoff
 *        - parse_failed (no text / the
 *          parser gave up)              → retry, then 'failed' unreadable_cv
 *        - no email AND no phone        → 'failed' no_contact_details (we
 *          cannot dedup, and could not contact the person anyway)
 *   3. In ONE tenant-bound transaction impersonating the uploader (so RLS
 *      applies and audit_logs attribute the rows to the human who uploaded):
 *        - advisory-lock the normalised email/phone so two files for the same
 *          person in one batch cannot both create a person
 *        - person by normalised email, then phone (`findPersonByContact` —
 *          the partner path's lookup)
 *        - person already has an application on THIS req → 'duplicate'
 *          (already_on_requisition), linked to the existing candidate
 *        - otherwise create the person if new, then `ingestApplication` —
 *          the shared core (knockouts, candidate upsert, application upsert,
 *          ai_score_outbox enqueue) → 'created' (new_candidate |
 *          existing_candidate)
 *        - a candidate_dedup_attempts row (attempted_by_membership_id = the
 *          uploader; metadata carries the batch + item ids)
 *        - the item row's terminal state
 *
 * NO candidate email is sent from here, by design — these people did not
 * apply. (The public apply path's "application received" email lives in
 * submitApplication, not in the shared core.) A new candidate row carries
 * NO consent stamp (consent_granted_at / consent_version NULL); the
 * processing basis is the uploader's attestation on bulk_cv_batches.
 *
 * Shape follows ai-interview-evidence-drain: lease-bounded claim via
 * UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED), attempt cap,
 * exponential backoff via lease_expires_at as not-before, exhausted leases
 * retired. One difference: claimed items are processed CONCURRENTLY (the
 * batch size IS the concurrency), because each item is dominated by one
 * parser model call and a 400-CV drop processed one at a time would take
 * hours. See BULK_CV_DRAIN_CONCURRENCY.
 */

import { randomUUID } from "node:crypto";
import {
  candidateDedupAttempts,
  drizzleSql,
  persons,
  sql as poolSql,
  withTenantContext,
  type TenantBoundDb,
} from "@hireops/db";
import type { Logger } from "@hireops/observability";
import { and, eq } from "drizzle-orm";
import {
  findApplicationForPersonOnRequisition,
  findPersonByContact,
  ingestApplication,
  normaliseEmail,
  normalisePhone,
  parseStoredResume,
  type ResumeParser,
} from "@hireops/api/application-ingest";
import { BULK_CV_ACCEPTING_REQ_STATUSES } from "@hireops/api/bulk-cv/policy";
import { StorageNotFoundError } from "@hireops/api/storage";

/** Attempts before a row goes terminal. */
export const BULK_CV_ATTEMPT_CAP = 3;

/** A claim is in flight for this long. One parse call is ~5–30 s. */
export const BULK_CV_LEASE_MS = 5 * 60_000;

/** Retry backoff base: attempt n waits BASE × 2^(n-1). */
const RETRY_BACKOFF_BASE_MS = 30_000;

/**
 * Items claimed AND parsed in parallel per pass. Each is one resume-parse
 * model call (see the throughput note in the PC-2 hand-back). Overridable via
 * BULK_CV_DRAIN_CONCURRENCY so a deploy can raise it against its provider's
 * rate limit without a code change; garbage falls back to the default.
 */
export const DEFAULT_BULK_CV_CONCURRENCY = 4;

export function bulkCvDrainConcurrency(): number {
  const raw = Number(process.env.BULK_CV_DRAIN_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_BULK_CV_CONCURRENCY;
  return Math.min(16, Math.floor(raw));
}

export interface BulkCvDrainOpts {
  log: Logger;
  batchSize?: number;
  workerId?: string;
  /** Test seam — replaces the resume parser. */
  parser?: ResumeParser;
}

export interface BulkCvDrainResult {
  claimed: number;
  created: number;
  duplicate: number;
  failed: number;
  retried: number;
  retired: number;
}

interface ClaimedItem {
  id: string;
  tenant_id: string;
  batch_id: string;
  requisition_id: string;
  storage_key: string | null;
  file_name: string;
  attempt_count: number;
}

interface BatchInfo {
  uploaded_by_user_id: string;
  uploaded_by_membership_id: string | null;
  tenant_slug: string;
}

/**
 * A known, recruiter-readable failure. `terminal` = no retry can change it
 * (the item goes straight to 'failed'); otherwise it is retried with backoff
 * and the reason is kept if the cap is reached.
 */
class ItemError extends Error {
  constructor(
    public readonly reason: string,
    public readonly terminal: boolean,
  ) {
    super(reason);
    this.name = "ItemError";
  }
}

type Outcome = "created" | "duplicate";

export async function drainBulkCvOnce(opts: BulkCvDrainOpts): Promise<BulkCvDrainResult> {
  const batchSize = opts.batchSize ?? bulkCvDrainConcurrency();
  const workerId = opts.workerId ?? `bulk-cv-${randomUUID().slice(0, 8)}`;
  const log = opts.log;

  const retired = await retireExhaustedLeases(log);

  const rows = await poolSql<ClaimedItem[]>`
    UPDATE public.bulk_cv_items
    SET status = 'parsing',
        attempt_count = attempt_count + 1,
        lease_expires_at = now() + (${BULK_CV_LEASE_MS}::int * interval '1 millisecond'),
        updated_at = now()
    WHERE id IN (
      SELECT id FROM public.bulk_cv_items
      WHERE (status = 'queued' AND (lease_expires_at IS NULL OR lease_expires_at <= now()))
         OR (status = 'parsing' AND lease_expires_at < now()
             AND attempt_count < ${BULK_CV_ATTEMPT_CAP})
      ORDER BY created_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, batch_id, requisition_id, storage_key, file_name, attempt_count
  `;

  const result: BulkCvDrainResult = {
    claimed: rows.length,
    created: 0,
    duplicate: 0,
    failed: 0,
    retried: 0,
    retired,
  };
  if (rows.length === 0) return result;

  await Promise.all(
    rows.map(async (row) => {
      const child = log.child({
        bulk_cv_item_id: row.id,
        batch_id: row.batch_id,
        tenant_id: row.tenant_id,
        attempt: row.attempt_count,
        worker_id: workerId,
      });
      try {
        const outcome = await processItem(row, child, opts.parser);
        result[outcome] += 1;
      } catch (err) {
        const terminal =
          (err instanceof ItemError && err.terminal) || row.attempt_count >= BULK_CV_ATTEMPT_CAP;
        const reason =
          err instanceof ItemError
            ? err.reason
            : `error: ${(err instanceof Error ? err.message : String(err)).slice(0, 500)}`;
        if (terminal) {
          await poolSql`
            UPDATE public.bulk_cv_items
            SET status = 'failed', failure_reason = ${reason}, lease_expires_at = NULL,
                updated_at = now()
            WHERE id = ${row.id}
          `;
          result.failed += 1;
          child.warn({ reason }, "bulk_cv.failed");
        } else {
          const backoffMs = RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, row.attempt_count - 1);
          await poolSql`
            UPDATE public.bulk_cv_items
            SET status = 'queued', failure_reason = ${reason},
                lease_expires_at = now() + (${backoffMs}::int * interval '1 millisecond'),
                updated_at = now()
            WHERE id = ${row.id}
          `;
          result.retried += 1;
          child.warn({ reason, backoff_ms: backoffMs }, "bulk_cv.retry");
        }
      }
    }),
  );
  return result;
}

async function retireExhaustedLeases(log: Logger): Promise<number> {
  const rows = await poolSql<{ id: string }[]>`
    UPDATE public.bulk_cv_items
    SET status = 'failed',
        failure_reason = COALESCE(failure_reason || ' ', '') || '[lease expired at attempt cap]',
        lease_expires_at = NULL,
        updated_at = now()
    WHERE status = 'parsing'
      AND lease_expires_at < now()
      AND attempt_count >= ${BULK_CV_ATTEMPT_CAP}
    RETURNING id
  `;
  if (rows.length > 0) log.warn({ retired: rows.length }, "bulk_cv.leases_retired");
  return rows.length;
}

/** location_country is char(2): keep only an ISO-2 code the parser happened to return. */
function iso2OrNull(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  return /^[A-Za-z]{2}$/.test(t) ? t.toUpperCase() : null;
}

function trimOrNull(raw: string | null | undefined, max: number): string | null {
  const t = raw?.trim();
  return t ? t.slice(0, max) : null;
}

async function processItem(
  row: ClaimedItem,
  log: Logger,
  parser: ResumeParser | undefined,
): Promise<Outcome> {
  if (!row.storage_key) throw new ItemError("file_missing", true);

  // ── 1. The requisition still accepts candidates ──────────────────────
  const [req] = await poolSql<{ status: string }[]>`
    SELECT status FROM public.requisitions
    WHERE tenant_id = ${row.tenant_id} AND id = ${row.requisition_id}
  `;
  if (!req || !BULK_CV_ACCEPTING_REQ_STATUSES.has(req.status)) {
    throw new ItemError("requisition_not_accepting", true);
  }

  const [batch] = await poolSql<BatchInfo[]>`
    SELECT b.uploaded_by_user_id::text AS uploaded_by_user_id,
           b.uploaded_by_membership_id::text AS uploaded_by_membership_id,
           t.slug AS tenant_slug
    FROM public.bulk_cv_batches b
    JOIN public.tenants t ON t.id = b.tenant_id
    WHERE b.tenant_id = ${row.tenant_id} AND b.id = ${row.batch_id}
  `;
  // Unreachable by construction (FK, CASCADE).
  if (!batch) throw new ItemError("batch_missing", true);

  // ── 2. Parse (outside any tx — a model call) ─────────────────────────
  let parse: Awaited<ReturnType<typeof parseStoredResume>>;
  try {
    parse = await parseStoredResume(row.storage_key, {
      tenantId: row.tenant_id,
      log,
      requestId: row.id,
      actorMembershipId: batch.uploaded_by_membership_id,
      logLabel: "bulkCv",
      rethrowStorageErrors: true,
      parser,
    });
  } catch (err) {
    if (err instanceof StorageNotFoundError) throw new ItemError("file_missing", true);
    throw err;
  }
  // parse_failed covers BOTH an unreadable file (no extractable text — no
  // model call, so a retry is free) and a parser/model failure (often
  // transient: rate limit, overload). Retried with backoff; after the cap the
  // item fails as unreadable_cv and the recruiter can Retry it.
  if (parse.parseStatus === "parse_failed" || !parse.parsed) {
    throw new ItemError("unreadable_cv", false);
  }
  const personal = parse.parsed.personal;
  const email = trimOrNull(personal.email, 320);
  const phone = trimOrNull(personal.phone, 64);
  const emailNorm = email ? normaliseEmail(email) : null;
  const phoneNormRaw = phone ? normalisePhone(phone) : "";
  const phoneNorm = phoneNormRaw.length >= 6 ? phoneNormRaw : null;
  if (!emailNorm && !phoneNorm) throw new ItemError("no_contact_details", true);

  // ── 3. One tenant-bound tx as the uploader ───────────────────────────
  const claims = {
    sub: batch.uploaded_by_user_id,
    tid: row.tenant_id,
    tenant_slug: batch.tenant_slug,
    roles: ["recruiter"],
  };
  return withTenantContext(
    claims,
    async ({ db }) => {
      // Serialise concurrent items for the same identity (same email or
      // phone in two files of one batch). Sorted so two locks cannot deadlock.
      const lockKeys = [emailNorm ? `e:${emailNorm}` : null, phoneNorm ? `p:${phoneNorm}` : null]
        .filter((k): k is string => k !== null)
        .sort();
      for (const k of lockKeys) {
        await db.execute(
          drizzleSql`SELECT pg_advisory_xact_lock(hashtextextended(${`bulkcv:${row.tenant_id}:${k}`}, 0))`,
        );
      }

      const existingPerson = await findPersonByContact(db, row.tenant_id, {
        emailNormalised: emailNorm,
        phoneNormalised: phoneNorm,
      });

      const submissionMetadata = {
        source: "bulk_cv_upload",
        requisitionId: row.requisition_id,
        batchId: row.batch_id,
        itemId: row.id,
        fileName: row.file_name,
      };

      if (existingPerson) {
        const onReq = await findApplicationForPersonOnRequisition(
          db,
          row.tenant_id,
          existingPerson.id,
          row.requisition_id,
        );
        if (onReq) {
          await db.insert(candidateDedupAttempts).values({
            tenantId: row.tenant_id,
            attemptedByMembershipId: batch.uploaded_by_membership_id,
            submittedEmail: email,
            submittedPhone: phone,
            matchedPersonId: existingPerson.id,
            decision: "link_existing",
            decisionReason: "already_on_requisition",
            submissionMetadata,
          });
          await finishItem(db, row, "duplicate", "already_on_requisition", onReq);
          log.info({ outcome: "duplicate" }, "bulk_cv.done");
          return "duplicate";
        }
      }

      let personId: string;
      if (existingPerson) {
        personId = existingPerson.id;
        const linkedin = trimOrNull(personal.linkedin_url, 500);
        if (!existingPerson.linkedinUrl && linkedin) {
          await db
            .update(persons)
            .set({ linkedinUrl: linkedin, updatedAt: new Date() })
            .where(and(eq(persons.tenantId, row.tenant_id), eq(persons.id, personId)));
        }
      } else {
        const [inserted] = await db
          .insert(persons)
          .values({
            tenantId: row.tenant_id,
            fullName: trimOrNull(personal.full_name, 300),
            emailPrimary: email,
            emailNormalised: emailNorm,
            phonePrimary: phone,
            phoneNormalised: phoneNorm,
            locationCountry: iso2OrNull(personal.location_country),
            locationCity: trimOrNull(personal.location_city, 200),
            linkedinUrl: trimOrNull(personal.linkedin_url, 500),
          })
          .returning({ id: persons.id });
        if (!inserted) throw new Error("person insert returned no row");
        personId = inserted.id;
      }

      const ingest = await ingestApplication(db, {
        tenantId: row.tenant_id,
        requisitionId: row.requisition_id,
        personId,
        resumeUploadKey: row.storage_key as string,
        source: "bulk_upload",
        parse,
        // No candidate consent exists — see the header and migration 0123.
        candidateConsent: { grantedAt: null, version: null },
        log,
        requestId: row.id,
        logLabel: "bulkCv",
      });

      await db.insert(candidateDedupAttempts).values({
        tenantId: row.tenant_id,
        attemptedByMembershipId: batch.uploaded_by_membership_id,
        submittedEmail: email,
        submittedPhone: phone,
        matchedPersonId: existingPerson ? personId : null,
        decision: existingPerson ? "link_existing" : "allow_new",
        decisionReason: existingPerson ? "existing_person_new_requisition" : "no_match",
        submissionMetadata,
      });

      await finishItem(
        db,
        row,
        "created",
        ingest.wasNewCandidate ? "new_candidate" : "existing_candidate",
        { candidateId: ingest.candidateId, applicationId: ingest.applicationId },
      );
      log.info({ outcome: "created", new_candidate: ingest.wasNewCandidate }, "bulk_cv.done");
      return "created";
    },
    {
      actorUserId: batch.uploaded_by_user_id,
      actorMembershipId: batch.uploaded_by_membership_id,
      requestId: row.id,
      source: "system",
    },
  );
}

async function finishItem(
  db: TenantBoundDb,
  row: ClaimedItem,
  status: Outcome,
  detail: string,
  link: { candidateId: string; applicationId: string },
): Promise<void> {
  await db.execute(drizzleSql`
    UPDATE public.bulk_cv_items
    SET status = ${status}, outcome_detail = ${detail}, failure_reason = NULL,
        candidate_id = ${link.candidateId}, application_id = ${link.applicationId},
        lease_expires_at = NULL, updated_at = now()
    WHERE tenant_id = ${row.tenant_id} AND id = ${row.id}
  `);
}
