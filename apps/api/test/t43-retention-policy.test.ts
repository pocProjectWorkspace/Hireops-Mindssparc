/**
 * T4.3 — document retention policy (config + honest overdue register)
 * (tenants.settings.retentionPolicy).
 *
 * Honesty focus: a tenant's retention policy is genuinely PERSISTED and
 * CONSUMED — the saved retention actually DRIVES the "documents past retention"
 * register (listDocumentsPastRetention). Lowering a document type's retention
 * surfaces a controlled OLD document; raising it drops the document out. Not a
 * display. NO erasure/deletion happens anywhere — the register is read-only.
 * Exercised over real cloud-minted JWTs (reality #110 — sign in as the seeded
 * personas):
 *
 *   Test 1: updateRetentionPolicy (admin) persists a non-default policy →
 *           getRetentionPolicy (admin) returns it + the raw block is in the DB
 *           jsonb; a synthetic sibling tenant is untouched (isolation).
 *   Test 2: resolve-over-defaults — an UNCONFIGURED tenant resolves to
 *           defaultRetentionPolicy() ({overridesByCode:{}, defaultYears:null}).
 *   Test 3: effectiveRetentionYears unit — override > reference > defaultYears >
 *           null (pure helper, no DB).
 *   Test 4: role gating — admin + hr_head can read AND write; recruiter is
 *           FORBIDDEN on both; hiring_manager FORBIDDEN on write.
 *   Test 5: HONESTY — a controlled application_document uploaded 3 years ago
 *           (document type government_id, reference retention 7y) is NOT overdue
 *           with no policy; overriding government_id to 1y flips it INTO the
 *           register; raising the override to 50y drops it back out. This proves
 *           the policy drives the real register, not display.
 *
 * kyndryl-poc's settings jsonb is snapshotted in beforeAll and restored verbatim
 * in afterAll, so the demo config is never clobbered. Seeds a self-contained
 * application chain + one application_document (cleaned up in afterAll).
 * Requires `pnpm db:seed:test-users` (admin1 / hrhead1 / recruiter1 /
 * hiringmanager1).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import {
  defaultRetentionPolicy,
  resolveRetentionPolicy,
  effectiveRetentionYears,
  type RetentionPolicy,
  type ListDocumentsPastRetentionOutput,
} from "@hireops/api-types";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const ADMIN = "admin1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

const SYNTH_TENANT = randomUUID();
const SYNTH_SLUG = "t43-synth-ret";

// t43 synth namespace (groom-safe — deleted in afterAll).
const N = "00000000-0000-4000-8000-0000c0f43b";
const BU = `${N}01`;
const POSITION = `${N}02`;
const JD = `${N}03`;
const REQ = `${N}04`;
const PERSON = `${N}05`;
const CAND = `${N}06`;
const APP = `${N}07`;
const DOC = `${N}08`;

// The controlled document type + its seeded reference retention (0048 migration).
const DOC_CODE = "government_id";
const DOC_REFERENCE_YEARS = 7;

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const q = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(`/trpc/${name}${q}`, {
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

let adminJwt: string;
let hrHeadJwt: string;
let recruiterJwt: string;
let hmJwt: string;
let tenantId: string;
let membershipId: string;
let docTypeId: string;
let originalSettings: unknown = {};

async function stripPolicy() {
  await poolSql`
    UPDATE public.tenants SET settings = settings - 'retentionPolicy' WHERE id = ${tenantId}
  `;
}

/** A complete policy overriding `partial` over the defaults. */
function policyWith(partial: Partial<RetentionPolicy>): RetentionPolicy {
  const base = defaultRetentionPolicy();
  return {
    overridesByCode: partial.overridesByCode ?? base.overridesByCode,
    defaultYears: partial.defaultYears ?? base.defaultYears,
  };
}

async function cleanupChain() {
  await poolSql`DELETE FROM public.application_documents WHERE tenant_id = ${tenantId} AND id = ${DOC}`;
  await poolSql`DELETE FROM public.applications WHERE id = ${APP}`;
  await poolSql`DELETE FROM public.candidates WHERE id = ${CAND}`;
  await poolSql`DELETE FROM public.persons WHERE id = ${PERSON}`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${BU}`;
}

const findMyDoc = (data: ListDocumentsPastRetentionOutput) =>
  data.items.find((d) => d.id === DOC && d.ownerRef === APP);

describe("T4.3 — document retention policy + honest overdue register", () => {
  beforeAll(async () => {
    [adminJwt, hrHeadJwt, recruiterJwt, hmJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(HR_HEAD),
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
    ]);
    const [t] = await poolSql<{ id: string; settings: unknown }[]>`
      SELECT id, settings FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    // Snapshot the PRISTINE settings — strip any retentionPolicy so a killed
    // prior run's residue is never "restored" in afterAll.
    originalSettings = (() => {
      const s = { ...((t.settings ?? {}) as Record<string, unknown>) };
      delete s["retentionPolicy"];
      return s;
    })();
    await stripPolicy();

    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE tenant_id = ${tenantId} AND status = 'active'
      LIMIT 1
    `;
    if (!m) throw new Error("no active membership in kyndryl-poc");
    membershipId = m.id;

    const [dt] = await poolSql<{ id: string; retention_years: number }[]>`
      SELECT id, retention_years FROM public.document_types WHERE code = ${DOC_CODE} LIMIT 1
    `;
    if (!dt) throw new Error(`document type ${DOC_CODE} not found (run migrations)`);
    docTypeId = dt.id;
    assert.equal(
      dt.retention_years,
      DOC_REFERENCE_YEARS,
      "government_id reference retention is 7 years (0048 seed)",
    );

    // Synthetic sibling tenant for the isolation test.
    await poolSql`DELETE FROM public.tenants WHERE id = ${SYNTH_TENANT} OR slug = ${SYNTH_SLUG}`;
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings)
      VALUES (${SYNTH_TENANT}, ${SYNTH_SLUG}, 'T4.3 Synth', 'ap-northeast-1', 'active',
              ${JSON.stringify({ t43_sentinel: "keep-me" })}::jsonb)
    `;

    // Self-contained application chain + ONE application_document uploaded 3
    // years ago (below the 7-year reference retention → NOT overdue by default).
    await cleanupChain();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${tenantId}, 'T43 BU', 't43-bu')`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${tenantId}, ${BU}, 'T43 Platform Engineer', 'onsite', true)
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
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, location_country)
      VALUES (${PERSON}, ${tenantId}, 'T43 Candidate', 't43cand@kyndryl-poc.test', 't43cand@kyndryl-poc.test', 'IN')
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${CAND}, ${tenantId}, ${PERSON}, 'career_site', 'v1')
    `;
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${APP}, ${tenantId}, ${CAND}, ${REQ}, 'career_site', 'tech_interview', now())
    `;
    await poolSql`
      INSERT INTO public.application_documents
        (id, tenant_id, application_id, document_type_id, status, storage_ref, uploaded_at)
      VALUES (${DOC}, ${tenantId}, ${APP}, ${docTypeId}, 'uploaded', 'seed://t43-doc',
              now() - interval '3 years')
    `;
  });

  afterAll(async () => {
    try {
      await cleanupChain();
    } catch {
      /* best-effort — groom sweep picks up residue */
    }
    try {
      await poolSql`
        UPDATE public.tenants SET settings = ${JSON.stringify(originalSettings ?? {})}::jsonb
        WHERE id = ${tenantId}
      `;
    } catch {
      /* best-effort restore */
    }
    try {
      await poolSql`DELETE FROM public.tenants WHERE id = ${SYNTH_TENANT} OR slug = ${SYNTH_SLUG}`;
    } catch {
      /* best-effort cleanup */
    }
  });

  it("Test 1: admin update persists a non-default policy; get returns it; DB carries the raw block; sibling tenant untouched", async () => {
    const policy = policyWith({
      overridesByCode: { government_id: 3, pan_card: 12 },
      defaultYears: 5,
    });
    const up = await trpcMutation<{ ok: true; retentionPolicy: RetentionPolicy }>(
      "updateRetentionPolicy",
      policy,
      adminJwt,
    );
    assert.ok(!isErr(up), `updateRetentionPolicy (admin): ${JSON.stringify(up)}`);
    assert.equal(up.result.data.ok, true);
    assert.deepEqual(up.result.data.retentionPolicy, policy, "echo matches the saved policy");

    const get = await trpcQuery<RetentionPolicy>("getRetentionPolicy", {}, adminJwt);
    assert.ok(!isErr(get), `getRetentionPolicy (admin): ${JSON.stringify(get)}`);
    assert.deepEqual(get.result.data, policy, "get reflects the saved policy");

    // Genuinely persisted as the raw block in the DB jsonb.
    const [row] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${tenantId}
    `;
    assert.deepEqual(
      row!.settings["retentionPolicy"],
      policy,
      "raw policy persisted to tenants.settings jsonb",
    );

    // Sibling tenant did NOT receive the update.
    const [synth] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${SYNTH_TENANT}
    `;
    assert.equal(synth!.settings["t43_sentinel"], "keep-me", "sibling sentinel preserved");
    assert.equal(synth!.settings["retentionPolicy"], undefined, "sibling did NOT receive update");

    await stripPolicy();
  });

  it("Test 2: an unconfigured tenant resolves to the default policy", async () => {
    await stripPolicy();
    const get = await trpcQuery<RetentionPolicy>("getRetentionPolicy", {}, adminJwt);
    assert.ok(!isErr(get), `getRetentionPolicy: ${JSON.stringify(get)}`);
    assert.deepEqual(
      get.result.data,
      defaultRetentionPolicy(),
      "resolves to defaultRetentionPolicy()",
    );
    assert.deepEqual(get.result.data, { overridesByCode: {}, defaultYears: null });
  });

  it("Test 3: effectiveRetentionYears — override > reference > defaultYears > null", async () => {
    const policy: RetentionPolicy = { overridesByCode: { government_id: 3 }, defaultYears: 5 };
    // override wins over the reference.
    assert.equal(effectiveRetentionYears("government_id", 7, policy), 3);
    // no override → reference wins over defaultYears.
    assert.equal(effectiveRetentionYears("pan_card", 7, policy), 7);
    // no override, no reference → defaultYears.
    assert.equal(effectiveRetentionYears("misc_code", null, policy), 5);
    // no override, no reference, no defaultYears → null (never overdue).
    assert.equal(
      effectiveRetentionYears("misc_code", null, { overridesByCode: {}, defaultYears: null }),
      null,
    );
    // an override of 0 is honoured (immediate erasure eligibility), not treated as absent.
    assert.equal(
      effectiveRetentionYears("government_id", 7, {
        overridesByCode: { government_id: 0 },
        defaultYears: null,
      }),
      0,
    );
    // resolveRetentionPolicy over junk falls back to the default, never throws.
    assert.deepEqual(resolveRetentionPolicy("not-a-policy"), defaultRetentionPolicy());
    assert.deepEqual(resolveRetentionPolicy(undefined), defaultRetentionPolicy());
  });

  it("Test 4: admin + hr_head read AND write; recruiter FORBIDDEN (read+write); hiring_manager FORBIDDEN (write)", async () => {
    const p = policyWith({ defaultYears: 4 });

    // hr_head parity — write + read.
    const hrWrite = await trpcMutation<{ ok: true }>("updateRetentionPolicy", p, hrHeadJwt);
    assert.ok(!isErr(hrWrite), `hr_head update allowed: ${JSON.stringify(hrWrite)}`);
    const hrRead = await trpcQuery<RetentionPolicy>("getRetentionPolicy", {}, hrHeadJwt);
    assert.ok(!isErr(hrRead), `hr_head read allowed: ${JSON.stringify(hrRead)}`);
    assert.equal(hrRead.result.data.defaultYears, 4);

    // Recruiter denied on BOTH read and write (getRetentionPolicy +
    // listDocumentsPastRetention + updateRetentionPolicy).
    const recRead = await trpcQuery<RetentionPolicy>("getRetentionPolicy", {}, recruiterJwt);
    assert.ok(
      isErr(recRead) && recRead.error.data.code === "FORBIDDEN",
      `recruiter FORBIDDEN on getRetentionPolicy: ${JSON.stringify(recRead)}`,
    );
    const recRegister = await trpcQuery("listDocumentsPastRetention", {}, recruiterJwt);
    assert.ok(
      isErr(recRegister) && recRegister.error.data.code === "FORBIDDEN",
      `recruiter FORBIDDEN on listDocumentsPastRetention: ${JSON.stringify(recRegister)}`,
    );
    const recWrite = await trpcMutation("updateRetentionPolicy", p, recruiterJwt);
    assert.ok(
      isErr(recWrite) && recWrite.error.data.code === "FORBIDDEN",
      `recruiter FORBIDDEN on write: ${JSON.stringify(recWrite)}`,
    );

    // Hiring manager denied on write.
    const hmWrite = await trpcMutation("updateRetentionPolicy", p, hmJwt);
    assert.ok(
      isErr(hmWrite) && hmWrite.error.data.code === "FORBIDDEN",
      `hiring_manager FORBIDDEN on write: ${JSON.stringify(hmWrite)}`,
    );

    await stripPolicy();
  });

  it("Test 5: HONESTY — the retention policy genuinely drives the overdue register", async () => {
    await stripPolicy();

    // (a) with NO policy, the 3-year-old government_id doc is UNDER the 7-year
    // reference retention → NOT overdue.
    const before = await trpcQuery<ListDocumentsPastRetentionOutput>(
      "listDocumentsPastRetention",
      {},
      hrHeadJwt,
    );
    assert.ok(!isErr(before), `register (no policy): ${JSON.stringify(before)}`);
    assert.ok(
      !findMyDoc(before.result.data),
      "at the 7-year reference retention, the 3-year-old doc must NOT be overdue",
    );

    // (b) override government_id to 1 year → the SAME doc now flips INTO the register.
    const short = await trpcMutation(
      "updateRetentionPolicy",
      policyWith({ overridesByCode: { government_id: 1 } }),
      adminJwt,
    );
    assert.ok(!isErr(short), `updateRetentionPolicy (short): ${JSON.stringify(short)}`);

    const overdue = await trpcQuery<ListDocumentsPastRetentionOutput>(
      "listDocumentsPastRetention",
      {},
      hrHeadJwt,
    );
    assert.ok(!isErr(overdue), `register (1y override): ${JSON.stringify(overdue)}`);
    const mine = findMyDoc(overdue.result.data);
    assert.ok(
      mine,
      "after lowering government_id retention to 1y, the doc FLIPS into the register",
    );
    assert.equal(mine!.source, "application", "sourced from application_documents");
    assert.equal(mine!.documentTypeCode, DOC_CODE);
    assert.equal(
      mine!.effectiveRetentionYears,
      1,
      "register reflects the tenant override, not the reference",
    );
    assert.ok(mine!.ageYears >= 1, "the doc is older than its (overridden) retention");

    // (c) raise the override to 50 years → the SAME doc drops back OUT.
    const long = await trpcMutation(
      "updateRetentionPolicy",
      policyWith({ overridesByCode: { government_id: 50 } }),
      adminJwt,
    );
    assert.ok(!isErr(long), `updateRetentionPolicy (long): ${JSON.stringify(long)}`);

    const after = await trpcQuery<ListDocumentsPastRetentionOutput>(
      "listDocumentsPastRetention",
      {},
      hrHeadJwt,
    );
    assert.ok(!isErr(after), `register (50y override): ${JSON.stringify(after)}`);
    assert.ok(
      !findMyDoc(after.result.data),
      "after raising government_id retention to 50y, the doc drops back OUT of the register",
    );

    // Honesty guarantee: the document itself is untouched — the register never
    // deletes or anonymises anything.
    const [stillThere] = await poolSql<{ id: string; status: string }[]>`
      SELECT id, status FROM public.application_documents WHERE id = ${DOC}
    `;
    assert.ok(stillThere, "the document row is NOT deleted by the register");
    assert.equal(stillThere!.status, "uploaded", "the document is NOT anonymised/mutated");

    await stripPolicy();
  });
});
