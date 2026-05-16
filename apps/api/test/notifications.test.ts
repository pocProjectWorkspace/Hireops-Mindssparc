/**
 * Module 3 — notifications + signed-link + worker integration tests.
 *
 * Coverage (16 cases):
 *   signed-link primitive
 *     1.  signLink + verifyLink roundtrip returns the same payload
 *     2.  verifyLink rejects an expired token
 *     3.  verifyLink rejects a tampered signature
 *     4.  verifyLink rejects malformed input
 *   /api/links/:token route
 *     5.  first redemption succeeds, writes signed_link_uses row
 *     6.  second redemption returns 409 + audit row with failure_reason
 *     7.  unknown action returns 404
 *     8.  expired token returns 400 with reason='expired'
 *   enqueue + mutation wiring
 *     9.  submitApplication enqueues 'candidate.application_received' (new app only)
 *    10.  re-submit of same (candidate, req) does NOT enqueue a second row
 *    11.  advanceApplication → shortlisted enqueues 'candidate.stage_advanced'
 *    12.  advanceApplication → recruiter_review does NOT enqueue (internal)
 *    13.  enqueueNotification with duplicate dedup_key raises 23505
 *   worker dispatcher + scheduler
 *    14.  drainOutboxOnce dispatches pending → sent + writes dev_email_outbox
 *    15.  drainOutboxOnce retry path increments attempt_count + leaves pending
 *    16.  runSchedulerTick respects per-job intervalMs
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../src/index.js";
import {
  sql as poolSql,
  db as poolDb,
  notificationOutbox,
  devEmailOutbox,
  signedLinkUses,
} from "@hireops/db";
import { and, eq } from "drizzle-orm";
import {
  signLink,
  verifyLink,
  hashToken,
  enqueueNotification,
} from "@hireops/notifications";
import { getStorageClient } from "../src/lib/storage";
import { drainOutboxOnce, recoverOrphans } from "../../../apps/workers/src/lib/dispatcher.js";
import { runSchedulerTick } from "../../../apps/workers/src/lib/scheduler.js";
import { createLogger } from "@hireops/observability";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_CV_PATH = resolve(
  HERE,
  "../../../packages/ai-client/test/fixtures/resumes/Variant_1_Traditional_Single_Column.docx",
);

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY)
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");

// Synth fixture chain in kyndryl-poc.
const M3_BU = "00000000-0000-4000-8000-000000a3b001";
const M3_POSITION = "00000000-0000-4000-8000-000000a3b002";
const M3_JD = "00000000-0000-4000-8000-000000a3b003";
const M3_REQ = "00000000-0000-4000-8000-000000a3b004";
const M3_PERSON = "00000000-0000-4000-8000-000000a3b005";
const M3_CANDIDATE = "00000000-0000-4000-8000-000000a3b006";
const M3_APP = "00000000-0000-4000-8000-000000a3b007";

const log = createLogger({ level: "error" });

let jwt: string;
let testTenantId: string;
let testMembershipId: string;

async function getTestJwt(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin failed: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErrorEnv {
  error: { data: { code: string; httpStatus: number } };
}

async function trpcMutation<O>(name: string, input: unknown, opts: { jwt?: string } = {}) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {}),
    },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErrorEnv;
}

function isError<T>(env: TRPCSuccess<T> | TRPCErrorEnv): env is TRPCErrorEnv {
  return "error" in env;
}

async function cleanup(): Promise<void> {
  // Aggressive sweep — tests 9 + 10 create transient candidates/persons via
  // submitApplication (random emails) AND tests 14 + 15 leave dev_email_outbox
  // rows. We can't enumerate every random fixture by id, so we walk the FK
  // chain top-down for everything tied to M3_REQ and then drop the static
  // M3_* parents. Each step wrapped so a transient failure doesn't leak
  // fixtures into the next test file (would break tenant-context test 7's
  // "exactly 1 BU" assertion).
  const stmts: Array<() => Promise<unknown>> = [
    () => poolSql`DELETE FROM public.dev_email_outbox WHERE tenant_id = ${testTenantId}`,
    () => poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${testTenantId}`,
    () => poolSql`DELETE FROM public.signed_link_uses WHERE tenant_id = ${testTenantId}`,
    () => poolSql`
      DELETE FROM public.application_state_transitions
      WHERE application_id IN (
        SELECT id FROM public.applications WHERE requisition_id = ${M3_REQ}
      )
    `,
    () => poolSql`DELETE FROM public.applications WHERE requisition_id = ${M3_REQ}`,
    // candidates / persons created via submitApplication may not be referenced
    // any more; this delete is best-effort. M3_CANDIDATE is the static one.
    () => poolSql`DELETE FROM public.candidates WHERE id = ${M3_CANDIDATE}`,
    () => poolSql`DELETE FROM public.persons WHERE id = ${M3_PERSON}`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${M3_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${M3_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${M3_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${M3_BU}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("M3 cleanup step failed (continuing):", err);
    }
  }
}

async function seedFixtures(): Promise<void> {
  await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${M3_BU}, ${testTenantId}, 'M3 BU', 'm3-bu')`;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${M3_POSITION}, ${testTenantId}, ${M3_BU}, 'M3 Senior Engineer', 'remote', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions
      (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${M3_JD}, ${testTenantId}, ${M3_POSITION}, 1, '# JD', 'approved')
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${M3_REQ}, ${testTenantId}, ${M3_POSITION}, ${M3_JD}, ${testMembershipId}, ${testMembershipId}, 'posted')
  `;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
    VALUES (${M3_PERSON}, ${testTenantId}, 'M3 Tester', 'm3-test@example.com', 'm3-test@example.com')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${M3_CANDIDATE}, ${testTenantId}, ${M3_PERSON}, 'career_site', 'v1')
  `;
}

async function seedApplication(stage: string): Promise<void> {
  await poolSql.unsafe(`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES ('${M3_APP}', '${testTenantId}', '${M3_CANDIDATE}', '${M3_REQ}', 'career_site', '${stage}', now())
  `);
}

describe("Module 3 — notifications + signed-link + workers", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    const claims = decodeJwt(jwt);
    const userId = claims.sub as string;
    testTenantId = (claims as { tid?: string }).tid as string;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${userId} AND tenant_id = ${testTenantId} LIMIT 1
    `;
    if (!m) throw new Error("test user membership missing");
    testMembershipId = m.id;
    await cleanup();
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 2 });
  });

  // ─────────── signed-link primitive ───────────

  it("1. signLink + verifyLink roundtrip preserves payload", () => {
    const subjectId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    const token = signLink({ action: "candidate.view_offer", subjectId, expiresAt });
    const v = verifyLink(token);
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.equal(v.payload.action, "candidate.view_offer");
    assert.equal(v.payload.subjectId, subjectId);
    assert.equal(v.payload.tokenHash, hashToken(token));
  });

  it("2. verifyLink rejects an expired token", () => {
    const token = signLink({
      action: "candidate.view_offer",
      subjectId: randomUUID(),
      expiresAt: new Date(Date.now() - 1000),
    });
    const v = verifyLink(token);
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.equal(v.reason, "expired");
  });

  it("3. verifyLink rejects a tampered signature", () => {
    const token = signLink({
      action: "candidate.view_offer",
      subjectId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const tampered = token.slice(0, -2) + "AA";
    const v = verifyLink(tampered);
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.equal(v.reason, "bad_signature");
  });

  it("4. verifyLink rejects malformed input", () => {
    const v = verifyLink("not-a-token");
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.equal(v.reason, "malformed");
  });

  // ─────────── /api/links/:token route ───────────

  it("5. first redemption succeeds + writes signed_link_uses row", async () => {
    const token = signLink({
      action: "candidate.view_offer",
      subjectId: M3_CANDIDATE,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await app.request(`/api/links/${token}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; tenantId: string };
    assert.equal(body.ok, true);
    assert.equal(body.tenantId, testTenantId);
    const rows = await poolDb
      .select()
      .from(signedLinkUses)
      .where(eq(signedLinkUses.tokenHash, hashToken(token)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.successful, true);
  });

  it("6. second redemption returns 409 + records failure_reason", async () => {
    const token = signLink({
      action: "candidate.view_offer",
      subjectId: M3_CANDIDATE,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await app.request(`/api/links/${token}`);
    const res = await app.request(`/api/links/${token}`);
    assert.equal(res.status, 409);
    const rows = await poolDb
      .select()
      .from(signedLinkUses)
      .where(eq(signedLinkUses.tokenHash, hashToken(token)));
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.successful === false && r.failureReason === "already_redeemed"));
  });

  it("7. unknown action returns 404", async () => {
    const token = signLink({
      action: "candidate.unknown_action",
      subjectId: M3_CANDIDATE,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await app.request(`/api/links/${token}`);
    assert.equal(res.status, 404);
  });

  it("8. expired token returns 400 with reason='expired'", async () => {
    const token = signLink({
      action: "candidate.view_offer",
      subjectId: M3_CANDIDATE,
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await app.request(`/api/links/${token}`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { reason: string };
    assert.equal(body.reason, "expired");
  });

  // ─────────── enqueue + mutation wiring ───────────

  it("9. submitApplication enqueues candidate.application_received", async () => {
    const cvBuffer = await readFile(SEED_CV_PATH);
    const storage = getStorageClient();
    const storageKey = `resumes/m3-test-9-${randomUUID()}.docx`;
    await storage.put(storageKey, cvBuffer, {
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const newCandEmail = `m3-fresh-${randomUUID()}@example.com`;
    const env = await trpcMutation<{ applicationId: string }>("submitApplication", {
      requisitionId: M3_REQ,
      source: "career_site",
      consentVersion: "v1",
      resumeUploadKey: storageKey,
      applicant: {
        fullName: "M3 Fresh Applicant",
        email: newCandEmail,
        phone: "+91 99999 00009",
        locationCountry: "IN",
      },
    });
    assert.equal(isError(env), false);
    if (isError(env)) return;
    const rows = await poolDb
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.tenantId, testTenantId),
          eq(notificationOutbox.recipientEmail, newCandEmail),
        ),
      );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.templateKey, "candidate.application_received");
    assert.equal(rows[0]?.status, "pending");
  });

  it("10. re-submit of same (candidate, req) does NOT enqueue a second row", async () => {
    const cvBuffer = await readFile(SEED_CV_PATH);
    const storage = getStorageClient();
    const storageKey = `resumes/m3-test-10-${randomUUID()}.docx`;
    await storage.put(storageKey, cvBuffer, {
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const newCandEmail = `m3-dup-${randomUUID()}@example.com`;
    const payload = {
      requisitionId: M3_REQ,
      source: "career_site" as const,
      consentVersion: "v1",
      resumeUploadKey: storageKey,
      applicant: {
        fullName: "M3 Dup Applicant",
        email: newCandEmail,
        phone: "+91 99999 00010",
        locationCountry: "IN",
      },
    };
    await trpcMutation("submitApplication", payload);
    await trpcMutation("submitApplication", payload);
    const rows = await poolDb
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.tenantId, testTenantId),
          eq(notificationOutbox.recipientEmail, newCandEmail),
        ),
      );
    assert.equal(rows.length, 1, "should not double-enqueue on re-submit");
  });

  it("11. advanceApplication → shortlisted enqueues candidate.stage_advanced", async () => {
    await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${M3_APP}`;
    await poolSql`DELETE FROM public.applications WHERE id = ${M3_APP}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${testTenantId} AND recipient_candidate_id = ${M3_CANDIDATE}`;
    await seedApplication("recruiter_review");

    const env = await trpcMutation<{ transitionId: string }>(
      "advanceApplication",
      { applicationId: M3_APP, targetStage: "shortlisted" },
      { jwt },
    );
    assert.equal(isError(env), false);

    const rows = await poolDb
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.tenantId, testTenantId),
          eq(notificationOutbox.recipientCandidateId, M3_CANDIDATE),
          eq(notificationOutbox.templateKey, "candidate.stage_advanced"),
        ),
      );
    assert.equal(rows.length, 1);
  });

  it("12. advanceApplication → recruiter_review does NOT enqueue (internal)", async () => {
    await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${M3_APP}`;
    await poolSql`DELETE FROM public.applications WHERE id = ${M3_APP}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${testTenantId} AND recipient_candidate_id = ${M3_CANDIDATE}`;
    await seedApplication("ai_screening");

    await trpcMutation("advanceApplication", {
      applicationId: M3_APP,
      targetStage: "recruiter_review",
    }, { jwt });

    const rows = await poolDb
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.tenantId, testTenantId),
          eq(notificationOutbox.recipientCandidateId, M3_CANDIDATE),
        ),
      );
    assert.equal(rows.length, 0);
  });

  it("13. enqueueNotification with duplicate dedup_key raises 23505", async () => {
    const dedupKey = `m3-dedup-${randomUUID()}`;
    await enqueueNotification(poolDb, {
      tenantId: testTenantId,
      recipientType: "candidate",
      recipientEmail: "dedup1@example.com",
      templateKey: "candidate.application_received",
      dedupKey,
    });
    let threw = false;
    try {
      await enqueueNotification(poolDb, {
        tenantId: testTenantId,
        recipientType: "candidate",
        recipientEmail: "dedup2@example.com",
        templateKey: "candidate.application_received",
        dedupKey,
      });
    } catch (err) {
      threw = true;
      // Drizzle wraps the postgres-js error; the original pg fields live on
      // err.cause. Flatten both layers when looking for the unique-violation
      // signal.
      const e = err as {
        code?: string;
        constraint_name?: string;
        message?: string;
        cause?: { code?: string; constraint_name?: string; message?: string };
      };
      const c = e.cause ?? {};
      const haystack = [
        e.code,
        e.constraint_name,
        e.message,
        c.code,
        c.constraint_name,
        c.message,
      ]
        .filter(Boolean)
        .join(" | ");
      assert.ok(
        haystack.includes("uniq_notification_outbox_dedup") || haystack.includes("23505"),
        `expected unique violation, got: ${haystack}`,
      );
    }
    assert.equal(threw, true);
  });

  // ─────────── worker dispatcher + scheduler ───────────

  it("14. drainOutboxOnce dispatches pending → sent + writes dev_email_outbox", async () => {
    // Drain anything left from earlier tests so this case's count is clean.
    await poolSql`DELETE FROM public.dev_email_outbox WHERE tenant_id = ${testTenantId}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${testTenantId}`;

    const { outboxId } = await enqueueNotification(poolDb, {
      tenantId: testTenantId,
      recipientType: "candidate",
      recipientEmail: "drain@example.com",
      recipientCandidateId: M3_CANDIDATE,
      templateKey: "candidate.application_received",
      templateData: {
        candidateName: "Drain",
        positionTitle: "Test Role",
        companyName: "Kyndryl",
      },
    });

    const r = await drainOutboxOnce({ log });
    // The drain is global (no per-tenant filter — that's correct for the
    // worker), so assert "at least our row" rather than exact count.
    assert.ok(r.sent >= 1, `expected r.sent >= 1, got ${r.sent}`);

    const [sent] = await poolDb
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, outboxId));
    assert.equal(sent?.status, "sent");
    assert.ok(sent?.providerMessageId?.startsWith("local-"));

    const devRows = await poolDb
      .select()
      .from(devEmailOutbox)
      .where(eq(devEmailOutbox.outboxId, outboxId));
    assert.equal(devRows.length, 1);
    assert.ok(devRows[0]?.renderedHtml.includes("Application received"));
  });

  it("15. drainOutboxOnce retry path increments attempt_count + leaves pending", async () => {
    await poolSql`DELETE FROM public.dev_email_outbox WHERE tenant_id = ${testTenantId}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${testTenantId}`;

    // Insert a row with an UNKNOWN templateKey — renderTemplate throws,
    // dispatcher catches, increments attempt_count, resets to pending.
    const [row] = await poolSql<{ id: string }[]>`
      INSERT INTO public.notification_outbox
        (tenant_id, recipient_type, recipient_email, template_key, template_data)
      VALUES (${testTenantId}, 'candidate', 'retry@example.com', 'bogus.template_key', '{}'::jsonb)
      RETURNING id
    `;
    const outboxId = row!.id;

    const r = await drainOutboxOnce({ log });
    assert.equal(r.retried, 1);

    const [state] = await poolDb
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, outboxId));
    assert.equal(state?.status, "pending");
    assert.equal(state?.attemptCount, 1);
    assert.ok(state?.lastError && state.lastError.length > 0);
  });

  it("16a. recoverOrphans flips long-stuck 'processing' rows back to 'pending'", async () => {
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${testTenantId}`;
    // Insert a row directly in 'processing' with a claimed_at well past the
    // stale threshold the worker uses (default 5 min).
    const [row] = await poolSql<{ id: string }[]>`
      INSERT INTO public.notification_outbox
        (tenant_id, recipient_type, recipient_email, template_key,
         template_data, status, claimed_at, claimed_by, attempt_count)
      VALUES (${testTenantId}, 'candidate', 'orphan@example.com',
              'candidate.application_received', '{}'::jsonb,
              'processing', now() - interval '1 hour', 'crashed-worker-1', 1)
      RETURNING id
    `;
    const orphanId = row!.id;
    const recovered = await recoverOrphans(5 * 60_000);
    assert.ok(recovered >= 1, `expected >= 1 orphan recovered, got ${recovered}`);
    const [state] = await poolDb
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, orphanId));
    assert.equal(state?.status, "pending");
    assert.equal(state?.claimedBy, null);
    assert.ok(state?.lastError?.includes("orphan_recovered"));
  });

  it("16. runSchedulerTick respects per-job intervalMs", async () => {
    await poolSql`DELETE FROM public.scheduled_job_runs WHERE job_name = 'm3_test_job'`;
    let runs = 0;
    const job = {
      name: "m3_test_job",
      intervalMs: 60_000,
      run: async () => {
        runs += 1;
      },
    };
    // First tick: no prior run → executes.
    const r1 = await runSchedulerTick({ jobs: [job], log });
    assert.equal(r1.ran.length, 1);
    assert.equal(runs, 1);
    // Second tick immediately after: interval not elapsed → skip.
    const r2 = await runSchedulerTick({ jobs: [job], log });
    assert.equal(r2.ran.length, 0);
    assert.equal(runs, 1);
    await poolSql`DELETE FROM public.scheduled_job_runs WHERE job_name = 'm3_test_job'`;
  });
});
