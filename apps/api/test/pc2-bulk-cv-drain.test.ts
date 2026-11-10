/**
 * PC-2 — the bulk-CV drain against a real database: parse → create → dedup.
 *
 * Drives `drainBulkCvOnce` (apps/workers) over seeded bulk_cv_items whose
 * files sit in the in-memory storage client (NODE_ENV=test). The resume
 * parser is injected (the drain's `parser` seam) and returns canned output
 * keyed by file content, so the test controls exactly what each "CV" says
 * without fixture-hashing real documents.
 *
 * What each item protects:
 *   A  new person → 'created' / new_candidate: person + candidate + application
 *      (source bulk_upload), candidate consent NULL (nobody consented), an
 *      ai_score_outbox row, a dedup attempt (allow_new) attributed to the
 *      uploader's membership — and NO notification_outbox row (no email).
 *   A2 a SECOND file for the same person in the same pass → serialised by the
 *      advisory lock: exactly one person / application; the other item is
 *      'duplicate' / already_on_requisition.
 *   B  person already on THIS requisition → 'duplicate' linked to the existing
 *      candidate + application; nothing new created.
 *   C  person known from ANOTHER requisition → 'created' / existing_candidate:
 *      the same candidate gets a second application.
 *   E  CV with no email and no phone → 'failed' / no_contact_details (terminal).
 *   F  unreadable CV (parser confidence 0) → retried with backoff (back to
 *      'queued', reason kept, not immediately re-claimable).
 *   G  requisition closed → 'failed' / requisition_not_accepting.
 *
 * Synthetic tenant (c2d namespace). REQUIRES migration 0123.
 *
 * NOTE: the drain claims across tenants; bulk_cv_items is new, but assertions
 * are on THIS tenant's rows regardless.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import type { ParserOutput } from "@hireops/ai-client";
import { getStorageClient, resetStorageClient } from "../src/lib/storage";
import { drainBulkCvOnce } from "../../../apps/workers/src/lib/bulk-cv-drain.js";

const T = "00000000-0000-4000-8000-000000c2d001";
const BU = "00000000-0000-4000-8000-000000c2d002";
const MEMBERSHIP = "00000000-0000-4000-8000-000000c2d003";
const POSITION = "00000000-0000-4000-8000-000000c2d004";
const JD = "00000000-0000-4000-8000-000000c2d005";
const REQ = "00000000-0000-4000-8000-000000c2d006";
const REQ_OTHER = "00000000-0000-4000-8000-000000c2d007";
const REQ_CLOSED = "00000000-0000-4000-8000-000000c2d008";
const BATCH = "00000000-0000-4000-8000-000000c2d010";
const BATCH_CLOSED = "00000000-0000-4000-8000-000000c2d011";

const PERSON_B = "00000000-0000-4000-8000-000000c2d020";
const CAND_B = "00000000-0000-4000-8000-000000c2d021";
const APP_B = "00000000-0000-4000-8000-000000c2d022";
const PERSON_C = "00000000-0000-4000-8000-000000c2d023";
const CAND_C = "00000000-0000-4000-8000-000000c2d024";
const APP_C_OTHER = "00000000-0000-4000-8000-000000c2d025";

const ITEM = {
  A: "00000000-0000-4000-8000-000000c2d0a1",
  A2: "00000000-0000-4000-8000-000000c2d0a2",
  B: "00000000-0000-4000-8000-000000c2d0b1",
  C: "00000000-0000-4000-8000-000000c2d0c1",
  E: "00000000-0000-4000-8000-000000c2d0e1",
  F: "00000000-0000-4000-8000-000000c2d0f1",
  G: "00000000-0000-4000-8000-000000c2d0f2",
} as const;

const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let UPLOADER: string;

const log = createLogger({ level: "error" });

function parserOutput(
  personal: { name: string | null; email: string | null; phone: string | null },
  confidence = 0.9,
): ParserOutput {
  return {
    personal: {
      full_name: personal.name,
      email: personal.email,
      phone: personal.phone,
      location_city: "Pune",
      location_country: "IN",
      linkedin_url: null,
      github_url: null,
      portfolio_url: null,
    },
    summary: null,
    total_years_experience: 6,
    current_role: null,
    work_history: [],
    education: [],
    skills: { technical: ["SAP FICO"], languages: [], certifications: [], domain: [] },
    notice_period_days: null,
    expected_compensation: null,
    parse_metadata: {
      parser_version: "test",
      parsed_at: new Date().toISOString(),
      confidence_score: confidence,
      source_format: "pdf_text",
      parser_model: "test",
    },
  };
}

/** File body → what the "parser" reads out of it. */
const CANNED: Record<string, ParserOutput> = {
  "cv-A": parserOutput({ name: "Anita Rao", email: "Anita.Rao+jobs@Example.com", phone: null }),
  "cv-A2": parserOutput({ name: "Anita R.", email: "anita.rao@example.com", phone: null }),
  "cv-B": parserOutput({ name: "Ravi Kumar", email: "ravi.c2d@example.com", phone: null }),
  "cv-C": parserOutput({ name: "Chitra S", email: null, phone: "+91 98450 12345" }),
  "cv-E": parserOutput({ name: "No Contact", email: null, phone: null }),
  "cv-F": parserOutput({ name: null, email: null, phone: null }, 0),
  "cv-G": parserOutput({ name: "Closed Req", email: "closed.c2d@example.com", phone: null }),
};

const parser = async (buffer: Buffer): Promise<ParserOutput> => {
  const key = buffer.toString("utf8").replace(/^%PDF-1\.7\n/, "");
  const out = CANNED[key];
  if (!out) throw new Error(`no canned parse for ${key}`);
  return out;
};

const keyFor = (k: string) => `resumes/bulk/${BATCH}/${k}.pdf`;

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.bulk_cv_items WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.bulk_cv_batches WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${T}`;
}

interface ItemState {
  status: string;
  outcome_detail: string | null;
  failure_reason: string | null;
  candidate_id: string | null;
  application_id: string | null;
  attempt_count: number;
  lease_future: boolean;
}

async function item(id: string): Promise<ItemState> {
  const [row] = await poolSql<ItemState[]>`
    SELECT status, outcome_detail, failure_reason, candidate_id::text AS candidate_id,
           application_id::text AS application_id, attempt_count,
           (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_future
    FROM public.bulk_cv_items WHERE tenant_id = ${T} AND id = ${id}
  `;
  if (!row) throw new Error(`item ${id} missing`);
  return row;
}

describe("PC-2 bulk-CV drain — parse → create → dedup", () => {
  beforeAll(async () => {
    resetStorageClient();
    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user)
      throw new Error(
        `prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} (pnpm db:seed:test-users)`,
      );
    UPLOADER = user.id;

    await cleanup();
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${T}, 'synth-pc2-drain', 'PC2 Drain Synth', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${T}, 'PC2 BU', 'pc2-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${MEMBERSHIP}, ${T}, ${UPLOADER}, ARRAY['recruiter']::tenant_role[], 'active', ${BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${POSITION}, ${T}, ${BU}, 'SAP Plant Accountant', 'onsite', 'Pune', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${JD}, ${T}, ${POSITION}, 1, '# JD', 'approved')`;
    for (const [rq, status] of [
      [REQ, "posted"],
      [REQ_OTHER, "posted"],
      [REQ_CLOSED, "closed"],
    ] as const) {
      await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${rq}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, ${status}, true)`;
    }

    // B: already on REQ. C: known from REQ_OTHER only.
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised) VALUES (${PERSON_B}, ${T}, 'Ravi Kumar', 'ravi.c2d@example.com', 'ravi.c2d@example.com')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_B}, ${T}, ${PERSON_B}, 'career_site')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source) VALUES (${APP_B}, ${T}, ${CAND_B}, ${REQ}, 'career_site')`;
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, phone_primary, phone_normalised) VALUES (${PERSON_C}, ${T}, 'Chitra S', '+919845012345', '919845012345')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_C}, ${T}, ${PERSON_C}, 'referral')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source) VALUES (${APP_C_OTHER}, ${T}, ${CAND_C}, ${REQ_OTHER}, 'referral')`;

    await poolSql`INSERT INTO public.bulk_cv_batches (id, tenant_id, requisition_id, uploaded_by_user_id, uploaded_by_membership_id, attestation_version) VALUES (${BATCH}, ${T}, ${REQ}, ${UPLOADER}, ${MEMBERSHIP}, 'test-v1')`;
    await poolSql`INSERT INTO public.bulk_cv_batches (id, tenant_id, requisition_id, uploaded_by_user_id, uploaded_by_membership_id, attestation_version) VALUES (${BATCH_CLOSED}, ${T}, ${REQ_CLOSED}, ${UPLOADER}, ${MEMBERSHIP}, 'test-v1')`;

    const storage = getStorageClient();
    for (const [k, id] of Object.entries(ITEM)) {
      const isClosed = k === "G";
      await storage.put(keyFor(k), Buffer.from(`%PDF-1.7\ncv-${k}`), {
        contentType: "application/pdf",
      });
      await poolSql`
        INSERT INTO public.bulk_cv_items (id, tenant_id, batch_id, requisition_id, file_name, storage_key, content_type, size_bytes, status)
        VALUES (${id}, ${T}, ${isClosed ? BATCH_CLOSED : BATCH}, ${isClosed ? REQ_CLOSED : REQ},
                ${`${k}.pdf`}, ${keyFor(k)}, 'application/pdf', 20, 'queued')
      `;
    }
  });

  afterAll(async () => {
    await cleanup();
    resetStorageClient();
    await poolSql.end({ timeout: 10 });
  });

  it("drains every item to the right terminal state", async () => {
    // One wide pass claims all seven concurrently (A and A2 race for the same
    // person); a second pass mops up anything a concurrent foreign row pushed out.
    await drainBulkCvOnce({ log, parser, batchSize: 20 });
    await drainBulkCvOnce({ log, parser, batchSize: 20 });

    // ── A / A2: one person, one application, one duplicate ──
    const a = await item(ITEM.A);
    const a2 = await item(ITEM.A2);
    const states = [a.status, a2.status].sort();
    assert.deepEqual(states, ["created", "duplicate"], "A/A2: exactly one created");
    const created = a.status === "created" ? a : a2;
    const dup = a.status === "created" ? a2 : a;
    assert.equal(created.outcome_detail, "new_candidate");
    assert.equal(dup.outcome_detail, "already_on_requisition");
    assert.equal(dup.candidate_id, created.candidate_id, "duplicate links the same candidate");
    assert.equal(dup.application_id, created.application_id);

    const anitaPersons = await poolSql<{ id: string }[]>`
      SELECT id FROM public.persons WHERE tenant_id = ${T} AND email_normalised = 'anita.rao@example.com'
    `;
    assert.equal(anitaPersons.length, 1, "the advisory lock prevented a double person");

    const [cand] = await poolSql<
      {
        source: string;
        consent_granted_at: Date | null;
        consent_version: string | null;
        talent_pool_consent: boolean;
        current_resume_url: string | null;
      }[]
    >`
      SELECT source, consent_granted_at, consent_version, talent_pool_consent, current_resume_url
      FROM public.candidates WHERE tenant_id = ${T} AND id = ${created.candidate_id}
    `;
    assert.ok(cand);
    assert.equal(cand.source, "bulk_upload");
    assert.equal(cand.consent_granted_at, null, "no candidate consent is claimed");
    assert.equal(cand.consent_version, null);
    assert.equal(cand.talent_pool_consent, false);
    assert.ok(cand.current_resume_url?.startsWith(`resumes/bulk/${BATCH}/`));

    const [app] = await poolSql<
      { source: string; requisition_id: string; current_stage: string }[]
    >`
      SELECT source, requisition_id::text AS requisition_id, current_stage::text AS current_stage
      FROM public.applications WHERE tenant_id = ${T} AND id = ${created.application_id}
    `;
    assert.ok(app);
    assert.equal(app.source, "bulk_upload");
    assert.equal(app.requisition_id, REQ);
    assert.equal(app.current_stage, "application_received");

    const outbox = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.ai_score_outbox
      WHERE tenant_id = ${T} AND application_id = ${created.application_id}
    `;
    assert.equal(outbox[0]?.n, 1, "created application enters the AI scoring queue");

    const [dedup] = await poolSql<
      {
        decision: string;
        attempted_by_membership_id: string | null;
        submission_metadata: { batchId?: string };
      }[]
    >`
      SELECT decision::text AS decision, attempted_by_membership_id::text AS attempted_by_membership_id,
             submission_metadata
      FROM public.candidate_dedup_attempts
      WHERE tenant_id = ${T} AND decision = 'allow_new'
    `;
    assert.ok(dedup, "dedup attempt recorded");
    assert.equal(dedup.attempted_by_membership_id, MEMBERSHIP, "attributed to the uploader");
    assert.equal(dedup.submission_metadata.batchId, BATCH);

    // ── B: already on this requisition ──
    const b = await item(ITEM.B);
    assert.equal(b.status, "duplicate");
    assert.equal(b.outcome_detail, "already_on_requisition");
    assert.equal(b.candidate_id, CAND_B);
    assert.equal(b.application_id, APP_B);
    const ravi = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.applications WHERE tenant_id = ${T} AND candidate_id = ${CAND_B}
    `;
    assert.equal(ravi[0]?.n, 1, "no second application for B");

    // ── C: known from another requisition → second application, same candidate ──
    const c = await item(ITEM.C);
    assert.equal(c.status, "created");
    assert.equal(c.outcome_detail, "existing_candidate");
    assert.equal(c.candidate_id, CAND_C);
    assert.notEqual(c.application_id, APP_C_OTHER);
    const chitraApps = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.applications WHERE tenant_id = ${T} AND candidate_id = ${CAND_C}
    `;
    assert.equal(chitraApps[0]?.n, 2);

    // ── E: no contact details (terminal) ──
    const e = await item(ITEM.E);
    assert.equal(e.status, "failed");
    assert.equal(e.failure_reason, "no_contact_details");

    // ── F: unreadable → retried with backoff, parked ──
    const f = await item(ITEM.F);
    assert.equal(f.status, "queued");
    assert.equal(f.failure_reason, "unreadable_cv");
    assert.equal(f.attempt_count, 1, "only one attempt spent across two passes (backoff parks it)");
    assert.equal(f.lease_future, true);

    // ── G: requisition closed ──
    const g = await item(ITEM.G);
    assert.equal(g.status, "failed");
    assert.equal(g.failure_reason, "requisition_not_accepting");

    // ── No candidate email from any of it ──
    const notes = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.notification_outbox WHERE tenant_id = ${T}
    `;
    assert.equal(notes[0]?.n, 0, "bulk upload sends no notification");
  });

  it("an item at the attempt cap fails terminally with its reason", async () => {
    await poolSql`
      UPDATE public.bulk_cv_items SET attempt_count = 2, lease_expires_at = NULL
      WHERE tenant_id = ${T} AND id = ${ITEM.F}
    `;
    await drainBulkCvOnce({ log, parser, batchSize: 20 });
    const f = await item(ITEM.F);
    assert.equal(f.status, "failed");
    assert.equal(f.failure_reason, "unreadable_cv");
    assert.equal(f.attempt_count, 3);
  });
});
