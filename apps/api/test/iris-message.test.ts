/**
 * message_candidate through the transactional assistant (honesty test). Over real
 * cloud-minted JWTs (the seeded personas):
 *
 *   Test 1 (HONESTY, happy path): as recruiter1, irisExecute(message_candidate)
 *     on a REAL seeded application runs the SAME gated `messageCandidate`
 *     procedure a recruiter uses by hand → a REAL notification_outbox row is
 *     enqueued (recipient_type 'candidate', template_key 'candidate.agent_message',
 *     for that candidate, carrying the human-confirmed subject + body), AND an
 *     assistant_actions provenance row (entity_type 'application') is persisted,
 *     AND irisGetProvenance reads it back stamped assistant='iris' + the confirming
 *     user. No side write-path — the AI never sends; the human Confirm does.
 *
 *   Test 2 (HONESTY, PER-ACTION gate fires THROUGH Iris — IRIS-B1.1): a role
 *     WITHOUT the recruiter-surface gate (hiringmanager1) is FORBIDDEN on BOTH
 *     irisPreview and irisExecute for message_candidate, and the action is absent
 *     from the hiring_manager's irisListActions menu. admin1 (super-role) CAN
 *     preview it.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / recruiter1 / hiringmanager1). Seeds
 * its own FK chain and cleans it up (child-first, incl. the enqueued notification
 * + the provenance rows) in afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const ADMIN = "admin1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// Unique per run so a shared-DB rerun never collides.
const RUN = Date.now().toString(36);
const BU = randomUUID();
const POSITION = randomUUID();
const JD = randomUUID();
const REQ = randomUUID();
const PERSON = randomUUID();
const CANDIDATE = randomUUID();
const APPLICATION = randomUUID();

let adminJwt: string;
let recruiterJwt: string;
let hiringManagerJwt: string;
let recruiterUserId: string;
let tenantId: string;

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
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

async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcMutation<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

async function cleanupChain(): Promise<void> {
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${tenantId} AND recipient_candidate_id = ${CANDIDATE}`;
  await poolSql`DELETE FROM public.assistant_actions WHERE tenant_id = ${tenantId} AND entity_id = ${APPLICATION}`;
  await poolSql`DELETE FROM public.applications WHERE id = ${APPLICATION}`;
  await poolSql`DELETE FROM public.candidates WHERE id = ${CANDIDATE}`;
  await poolSql`DELETE FROM public.persons WHERE id = ${PERSON}`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${BU}`;
}

interface IrisExecuteOutput {
  ok: true;
  entityType: string;
  entityId: string | null;
  resultSummary: string;
}
interface IrisProvenanceOutput {
  rows: {
    entityId: string;
    assistant: string;
    actionId: string;
    confirmedByUserId: string | null;
    createdAt: string;
  }[];
}

const SUBJECT = `Final interview — Backend Engineer (${RUN})`;
const BODY = `Hi there,\n\nWe'd love to invite you to a final interview for the Backend Engineer role. (${RUN})\n\nBest,\nThe team`;

describe("message_candidate through Iris (honesty)", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt, hiringManagerJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
    ]);
    recruiterUserId = decodeJwt(recruiterJwt).sub as string;
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    // A membership to hang the requisition off (any active member works).
    const [m] = await poolSql<{ id: string }[]>`
      SELECT tum.id
      FROM public.tenant_user_memberships tum
      JOIN auth.users au ON au.id = tum.user_id
      WHERE au.email = ${ADMIN} AND tum.tenant_id = ${tenantId}
      LIMIT 1
    `;
    if (!m) throw new Error(`admin membership for ${ADMIN} not found`);
    const membershipId = m.id;

    await cleanupChain();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${tenantId}, ${`IRIS-MSG BU ${RUN}`}, ${`iris-msg-bu-${RUN}`})`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${tenantId}, ${BU}, ${`IRIS-MSG Engineer ${RUN}`}, 'remote', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${tenantId}, ${POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${tenantId}, ${POSITION}, ${JD}, ${membershipId}, ${membershipId}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${PERSON}, ${tenantId}, ${`IRIS-MSG Candidate ${RUN}`}, ${`iris-msg-${RUN}@example.com`}, ${`iris-msg-${RUN}@example.com`})
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${CANDIDATE}, ${tenantId}, ${PERSON}, 'career_site', 'v1')
    `;
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${APPLICATION}, ${tenantId}, ${CANDIDATE}, ${REQ}, 'career_site', 'shortlisted', now())
    `;
  });

  afterAll(async () => {
    try {
      await cleanupChain();
    } catch {
      // best-effort — leave residue for the groom sweep rather than fail.
    }
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1 (HONESTY): irisExecute(message_candidate) enqueues a REAL candidate notification + persists provenance read back by irisGetProvenance", async () => {
    const exec = await trpcMutation<IrisExecuteOutput>(
      "irisExecute",
      {
        actionId: "message_candidate",
        params: { applicationId: APPLICATION, subject: SUBJECT, body: BODY },
      },
      recruiterJwt,
    );
    assert.ok(!isErr(exec), `message_candidate should succeed, got ${JSON.stringify(exec)}`);
    assert.equal(exec.result.data.ok, true);
    assert.equal(exec.result.data.entityType, "application");
    assert.equal(exec.result.data.entityId, APPLICATION, "provenance lands on the application");
    assert.ok(exec.result.data.resultSummary.length > 0, "resultSummary is non-empty");

    // A REAL notification_outbox row was enqueued for this candidate, on the
    // candidate.agent_message path, carrying the human-confirmed subject + body.
    const [note] = await poolSql<
      {
        recipient_type: string;
        recipient_email: string;
        recipient_candidate_id: string;
        template_key: string;
        subject: string;
        template_data: { body?: string; subject?: string };
      }[]
    >`
      SELECT recipient_type, recipient_email, recipient_candidate_id, template_key, subject, template_data
      FROM public.notification_outbox
      WHERE tenant_id = ${tenantId} AND recipient_candidate_id = ${CANDIDATE}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    assert.ok(note, "a real notification_outbox row was enqueued");
    assert.equal(note.recipient_type, "candidate", "recipient is the candidate");
    assert.equal(note.recipient_candidate_id, CANDIDATE, "row targets the seeded candidate");
    assert.equal(note.recipient_email, `iris-msg-${RUN}@example.com`, "real candidate email");
    assert.equal(note.template_key, "candidate.agent_message", "agent-message template");
    assert.equal(note.subject, SUBJECT, "the human-confirmed subject was enqueued");
    assert.equal(note.template_data.body, BODY, "the human-confirmed body was enqueued");

    // A provenance row was persisted, stamped iris + the confirming user, on
    // entity_type "application".
    const [prov] = await poolSql<
      { assistant: string; action_id: string; entity_type: string; confirmed_by_user_id: string }[]
    >`
      SELECT assistant, action_id, entity_type, confirmed_by_user_id
      FROM public.assistant_actions
      WHERE tenant_id = ${tenantId} AND entity_id = ${APPLICATION}
    `;
    assert.ok(prov, "assistant_actions provenance row exists");
    assert.equal(prov.assistant, "iris");
    assert.equal(prov.action_id, "message_candidate");
    assert.equal(prov.entity_type, "application");
    assert.equal(prov.confirmed_by_user_id, recruiterUserId, "confirming user is the caller");

    // irisGetProvenance reads it back (RLS-scoped) for the "application" surface.
    const prv = await trpcQuery<IrisProvenanceOutput>(
      "irisGetProvenance",
      { entityType: "application", entityIds: [APPLICATION] },
      recruiterJwt,
    );
    assert.ok(!isErr(prv), `getProvenance should succeed, got ${JSON.stringify(prv)}`);
    assert.equal(prv.result.data.rows.length, 1, "exactly one provenance row read back");
    const p = prv.result.data.rows[0]!;
    assert.equal(p.entityId, APPLICATION);
    assert.equal(p.assistant, "iris");
    assert.equal(p.actionId, "message_candidate");
    assert.equal(p.confirmedByUserId, recruiterUserId, "confirming user read back");
  });

  it("Test 2 (HONESTY): the PER-ACTION gate fires THROUGH Iris — hiring_manager is FORBIDDEN on message_candidate preview + execute; admin can preview", async () => {
    // hiring_manager's menu OMITS message_candidate (per-action filtering).
    const hmList = await trpcQuery<{ actions: { id: string }[] }>(
      "irisListActions",
      {},
      hiringManagerJwt,
    );
    assert.ok(!isErr(hmList), `hiring_manager can list, got ${JSON.stringify(hmList)}`);
    const hmIds = new Set(hmList.result.data.actions.map((a) => a.id));
    assert.ok(!hmIds.has("message_candidate"), "hiring_manager menu OMITS message_candidate");

    // hiring_manager CANNOT preview message_candidate — FORBIDDEN on that action.
    const hmPreview = await trpcQuery(
      "irisPreview",
      {
        actionId: "message_candidate",
        params: { applicationId: APPLICATION, subject: "Hi", body: "Hello" },
      },
      hiringManagerJwt,
    );
    assert.ok(
      isErr(hmPreview) && hmPreview.error.data.code === "FORBIDDEN",
      `hiring_manager message_candidate preview forbidden, got ${JSON.stringify(hmPreview)}`,
    );

    // hiring_manager CANNOT execute it either — FORBIDDEN before any send.
    const hmExec = await trpcMutation(
      "irisExecute",
      {
        actionId: "message_candidate",
        params: { applicationId: APPLICATION, subject: "Hi", body: "Hello" },
      },
      hiringManagerJwt,
    );
    assert.ok(
      isErr(hmExec) && hmExec.error.data.code === "FORBIDDEN",
      `hiring_manager message_candidate execute forbidden, got ${JSON.stringify(hmExec)}`,
    );

    // admin (super-role): the message_candidate action is present + previewable.
    const adminList = await trpcQuery<{ actions: { id: string; group: string }[] }>(
      "irisListActions",
      {},
      adminJwt,
    );
    assert.ok(!isErr(adminList), `admin can list, got ${JSON.stringify(adminList)}`);
    const adminEntry = adminList.result.data.actions.find((a) => a.id === "message_candidate");
    assert.ok(adminEntry, "admin menu contains message_candidate");
    assert.equal(adminEntry!.group, "Communication", "message_candidate is in Communication");

    const adminPreview = await trpcQuery<{ summary: string; details: string[] }>(
      "irisPreview",
      {
        actionId: "message_candidate",
        params: { applicationId: APPLICATION, subject: SUBJECT, body: BODY },
      },
      adminJwt,
    );
    assert.ok(!isErr(adminPreview), `admin preview ok, got ${JSON.stringify(adminPreview)}`);
    assert.ok(adminPreview.result.data.summary.length > 0, "preview has a summary");
    assert.ok(
      adminPreview.result.data.details.join(" ").includes(SUBJECT),
      "preview names the subject",
    );
  });
});
