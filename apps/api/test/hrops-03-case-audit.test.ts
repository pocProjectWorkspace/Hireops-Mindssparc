/**
 * HROPS-03 — case audit trail: note write + per-case timeline read.
 *
 * Coverage:
 *   1. addCaseAuditNote — writes a REAL hr_case_notes row AND the
 *      audit_record_change() trigger writes the audit_logs event (entity_type
 *      hr_case_notes, action insert) the timeline renders.
 *   2. getCaseAuditTimeline — returns the note (isNote, note text as the
 *      description) plus the application's own trigger events; a direct stage
 *      UPDATE surfaces as a "Stage changed" event with the from → to.
 *   3. listCaseAuditCases — the fixture case appears with its event count +
 *      stats; search by candidate name narrows to it.
 *   4. Validation — a whitespace-only note is BAD_REQUEST.
 *   5. Role gate — recruiter FORBIDDEN on list + note write.
 *   6. hr_ops (same tenant, hr_ops1) passes the gate; RLS hides the note +
 *      its audit event under another tenant's withTenantContext.
 *
 * Fixtures live in the fnd15b test user's own tenant ('0d13' namespace);
 * cleaned in afterAll (audit rows are deleted per-entity, never per-tenant).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { eq } from "drizzle-orm";
import {
  sql as poolSql,
  withTenantContext,
  hrCaseNotes,
  auditLogs,
  type JwtClaims,
} from "@hireops/db";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HR_OPS_USER = "hr_ops1@kyndryl-poc.test";

// '0d13' namespace — valid v4-format fixed UUIDs for this suite's fixtures.
const D13_BU = "00000000-0000-4000-8000-00000d130001";
const D13_POSITION = "00000000-0000-4000-8000-00000d130002";
const D13_JD = "00000000-0000-4000-8000-00000d130003";
const D13_REQ = "00000000-0000-4000-8000-00000d130004";
const D13_PERSON = "00000000-0000-4000-8000-00000d130005";
const D13_CAND = "00000000-0000-4000-8000-00000d130006";
const D13_APP = "00000000-0000-4000-8000-00000d130007";
const SYNTH_TENANT = "00000000-0000-4000-8000-00000d13f001";
const CAND_NAME = "Hrops Thirteen Auditee";

let jwt: string;
let realClaims: JwtClaims;
let tenantId: string;
let membershipId: string;
let recruiterJwt: string;
let hrOpsJwt: string;
let noteId = "";

async function signIn(email: string, password: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}
async function trpcQuery<O>(name: string, input: unknown, tok: string) {
  const inputParam =
    input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(`/trpc/${name}${inputParam}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${tok}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcMutation<O>(name: string, input: unknown, tok: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${tok}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

interface TimelineOut {
  applicationId: string;
  candidateName: string | null;
  stage: string;
  events: {
    id: string;
    kind: string;
    title: string;
    description: string | null;
    isNote: boolean;
  }[];
}

async function cleanup(): Promise<void> {
  // Audit rows are append-only; delete only OUR entities' rows so the shared
  // dev tenant's other audit history is untouched.
  await poolSql`
    DELETE FROM public.audit_logs
    WHERE tenant_id = ${tenantId}
      AND entity_id IN (
        SELECT id FROM public.hr_case_notes WHERE tenant_id = ${tenantId} AND application_id = ${D13_APP}
      )
  `;
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${tenantId} AND entity_id = ${D13_APP}`;
  await poolSql`DELETE FROM public.hr_case_notes WHERE tenant_id = ${tenantId} AND application_id = ${D13_APP}`;
  await poolSql`DELETE FROM public.applications WHERE id = ${D13_APP}`;
  await poolSql`DELETE FROM public.candidates WHERE id = ${D13_CAND}`;
  await poolSql`DELETE FROM public.persons WHERE id = ${D13_PERSON}`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${D13_REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${D13_JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${D13_POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${D13_BU}`;
}

describe("HROPS-03 case audit trail", () => {
  beforeAll(async () => {
    jwt = await signIn(TEST_EMAIL, TEST_PASSWORD);
    realClaims = decodeJwt(jwt) as JwtClaims;
    tenantId = realClaims.tid as string;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${realClaims.sub as string} AND tenant_id = ${tenantId} LIMIT 1
    `;
    if (!m) throw new Error("test user membership missing");
    membershipId = m.id;

    [recruiterJwt, hrOpsJwt] = await Promise.all([
      signIn(RECRUITER, PASSWORD),
      signIn(HR_OPS_USER, PASSWORD),
    ]);

    await cleanup();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${D13_BU}, ${tenantId}, 'HROPS13 BU', 'hrops13-bu')`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${D13_POSITION}, ${tenantId}, ${D13_BU}, 'HROPS13 Audit Engineer', 'onsite', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${D13_JD}, ${tenantId}, ${D13_POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${D13_REQ}, ${tenantId}, ${D13_POSITION}, ${D13_JD}, ${membershipId}, ${membershipId}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, location_country)
      VALUES (${D13_PERSON}, ${tenantId}, ${CAND_NAME}, 'hrops13@hireops-dev.local', 'hrops13@hireops-dev.local', 'IN')
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${D13_CAND}, ${tenantId}, ${D13_PERSON}, 'career_site', 'v1')
    `;
    // INSERT fires the applications audit trigger → the first timeline event.
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${D13_APP}, ${tenantId}, ${D13_CAND}, ${D13_REQ}, 'career_site', 'tech_interview', now())
    `;
    // A stage move (direct UPDATE also fires the trigger) → a "Stage changed" event.
    await poolSql`
      UPDATE public.applications SET current_stage = 'hr_round', stage_entered_at = now()
      WHERE id = ${D13_APP}
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("1. addCaseAuditNote writes the hr_case_notes row + the trigger audit event", async () => {
    const res = await trpcMutation<{ noteId: string; createdAt: string }>(
      "addCaseAuditNote",
      { applicationId: D13_APP, note: "Background verification initiated with vendor." },
      jwt,
    );
    assert.ok(!isErr(res), `addNote: ${JSON.stringify(res)}`);
    noteId = res.result.data.noteId;

    const [note] = await poolSql<{ note: string; author_membership_id: string | null }[]>`
      SELECT note, author_membership_id FROM public.hr_case_notes WHERE id = ${noteId}
    `;
    assert.equal(note?.note, "Background verification initiated with vendor.");
    assert.equal(note?.author_membership_id, membershipId, "author membership stamped");

    const [audit] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.audit_logs
      WHERE tenant_id = ${tenantId} AND entity_type = 'hr_case_notes'
        AND entity_id = ${noteId} AND action = 'insert'
    `;
    assert.equal(Number(audit?.n), 1, "the note produced a REAL audit_logs row via the trigger");
  });

  it("2. getCaseAuditTimeline returns the note + stage events", async () => {
    const res = await trpcQuery<TimelineOut>(
      "getCaseAuditTimeline",
      { applicationId: D13_APP },
      jwt,
    );
    assert.ok(!isErr(res), `timeline: ${JSON.stringify(res)}`);
    const t = res.result.data;
    assert.equal(t.applicationId, D13_APP);
    assert.equal(t.candidateName, CAND_NAME);

    const noteEv = t.events.find((e) => e.isNote);
    assert.ok(noteEv, "note event present");
    assert.equal(noteEv!.kind, "note");
    assert.equal(noteEv!.description, "Background verification initiated with vendor.");

    const stageEv = t.events.find((e) => e.title === "Stage changed");
    assert.ok(stageEv, "stage-change event present");
    assert.ok(
      stageEv!.description?.includes("tech interview") &&
        stageEv!.description?.includes("hr round"),
      `stage description carries from → to (${stageEv!.description})`,
    );
    const createdEv = t.events.find((e) => e.title === "Application created");
    assert.ok(createdEv, "application-created event present");
  });

  it("3. listCaseAuditCases shows the case with its event count; search narrows", async () => {
    const list = await trpcQuery<{
      items: { applicationId: string; eventCount: number; candidateName: string | null }[];
      stats: { cases: number; events: number; notes: number };
    }>("listCaseAuditCases", { limit: 200 }, jwt);
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    const mine = list.result.data.items.find((i) => i.applicationId === D13_APP);
    assert.ok(mine, "fixture case appears");
    assert.ok(
      mine!.eventCount >= 3,
      `insert + update + note = >=3 events (got ${mine!.eventCount})`,
    );
    assert.ok(list.result.data.stats.notes >= 1, "note counted in stats");

    const searched = await trpcQuery<{ items: { applicationId: string }[] }>(
      "listCaseAuditCases",
      { search: "Thirteen Auditee", limit: 50 },
      jwt,
    );
    assert.ok(!isErr(searched));
    assert.equal(searched.result.data.items.length, 1, "search narrows to the fixture case");
    assert.equal(searched.result.data.items[0]!.applicationId, D13_APP);
  });

  it("4. a whitespace-only note is BAD_REQUEST", async () => {
    const res = await trpcMutation(
      "addCaseAuditNote",
      { applicationId: D13_APP, note: "   " },
      jwt,
    );
    assert.ok(isErr(res) && res.error.data.code === "BAD_REQUEST");
  });

  it("5. role gate — recruiter FORBIDDEN on list + note write", async () => {
    const list = await trpcQuery("listCaseAuditCases", { limit: 10 }, recruiterJwt);
    assert.ok(isErr(list) && list.error.data.code === "FORBIDDEN");
    const note = await trpcMutation(
      "addCaseAuditNote",
      { applicationId: D13_APP, note: "should not land" },
      recruiterJwt,
    );
    assert.ok(isErr(note) && note.error.data.code === "FORBIDDEN");
  });

  it("6. hr_ops (same tenant) passes the gate; RLS hides note + audit rows cross-tenant", async () => {
    // hr_ops1 shares the kyndryl-poc tenant with the fnd15b fixtures — a
    // positive check that the plain hr_ops role passes HR_OPS_DOC_ROLES.
    const t = await trpcQuery<TimelineOut>(
      "getCaseAuditTimeline",
      { applicationId: D13_APP },
      hrOpsJwt,
    );
    assert.ok(!isErr(t), `same-tenant hr_ops timeline: ${JSON.stringify(t)}`);
    assert.ok(t.result.data.events.length >= 3, "same-tenant hr_ops sees the events");

    // RLS: the note row and its audit_logs event are invisible under another
    // tenant's context (current_tenant_id() mismatch).
    const synthClaims: JwtClaims = {
      sub: "00000000-0000-4000-8000-00000d13f0aa",
      tid: SYNTH_TENANT,
      roles: ["hr_ops"],
    };
    const crossNotes = await withTenantContext(synthClaims, async ({ db }) =>
      db.select({ id: hrCaseNotes.id }).from(hrCaseNotes).where(eq(hrCaseNotes.id, noteId)),
    );
    assert.equal(crossNotes.length, 0, "note row invisible cross-tenant");
    const crossAudit = await withTenantContext(synthClaims, async ({ db }) =>
      db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.entityId, noteId)),
    );
    assert.equal(crossAudit.length, 0, "audit event invisible cross-tenant");

    // And visible from the owning tenant's context.
    const ownNotes = await withTenantContext(realClaims, async ({ db }) =>
      db.select({ id: hrCaseNotes.id }).from(hrCaseNotes).where(eq(hrCaseNotes.id, noteId)),
    );
    assert.equal(ownNotes.length, 1, "note visible in the owning tenant");
  });
});
