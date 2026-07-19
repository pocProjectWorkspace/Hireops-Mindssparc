/**
 * HROPS-02 — Comp & offer desk API suite.
 *
 * Exercises the desk over real cloud-minted JWTs (seeded personas, reality
 * #110) against a self-seeded fixture: one application at hr_round with
 * expected ₹36 LPA on a role banded ₹20–30 LPA (major rupees on the position)
 * → deterministic verdict need_approval.
 *
 *   Test 1: listCompDesk (hr_ops) shows the row with the rule-computed verdict
 *           (need_approval, suggested = band max) + stats; recruiter FORBIDDEN.
 *   Test 2: generateCompRationale (LocalAI fixture) → comp_recommendations row
 *           cached + a comp_recommendation ai_usage_logs row; regenerate
 *           REPLACES (still one row); getCompAnalysis returns it.
 *   Test 3: kill-switch — admin disables comp_recommendation → BAD_REQUEST, no
 *           model call (usage-log count unchanged); settings restored.
 *   Test 4: OUT-OF-BAND EXTEND GATE — draftCompOffer above band max returns
 *           needsApproval=true; extendOffer BLOCKED (BAD_REQUEST) until an
 *           HR-head approval is approved; hr_ops FORBIDDEN on the decision;
 *           listOfferApprovals (hr_head) shows the pending row; approve →
 *           extendOffer succeeds.
 *   Test 5: in-band draft → needsApproval=false and requestOfferApproval
 *           refuses (nothing to approve).
 *
 * NODE_ENV=test forces LocalAIClient (fixtures) — no real tokens are spent.
 * Requires `pnpm db:seed:test-users` (hr_ops1 / hrhead1 / admin1 / recruiter1).
 * Cleans up its own rows in afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HR_OPS = "hr_ops1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const ADMIN = "admin1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// Fixed fixture ids (a7c2 namespace — HROPS-02 test rows, groom-safe cleanup).
const FX_BU = "00000000-0000-4000-8000-000000a7c201";
const FX_POSITION = "00000000-0000-4000-8000-000000a7c202";
const FX_JD = "00000000-0000-4000-8000-000000a7c203";
const FX_REQ = "00000000-0000-4000-8000-000000a7c204";
const FX_PERSON = "00000000-0000-4000-8000-000000a7c205";
const FX_CANDIDATE = "00000000-0000-4000-8000-000000a7c206";
const FX_APP = "00000000-0000-4000-8000-000000a7c207";

const RUN = Date.now().toString(36);
const L_PAISE = 100_000 * 100; // ₹1 lakh in paise
const EXPECTED_PAISE = 36 * L_PAISE; // ₹36 LPA > band max ₹30 LPA
const BAND_MAX_PAISE = 30 * L_PAISE;

let recruiterJwt: string;
let hrOpsJwt: string;
let hrHeadJwt: string;
let adminJwt: string;
let tenantId: string;
const writtenFixtures: string[] = [];
const chainIds: string[] = [];

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
  const url =
    input === undefined
      ? `/trpc/${name}`
      : `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
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

/** Generate the comp rationale; on a fixture miss, write a matching LocalAI
 * fixture keyed by the harvested prompt hash and retry (hrhead-02 technique). */
async function generateWithFixture(applicationId: string, jwt: string) {
  const first = await trpcMutation<{ rationale: { rationale: string } }>(
    "generateCompRationale",
    { applicationId },
    jwt,
  );
  if (!isErr(first)) return first;
  const match = /prompt hash ([a-f0-9]{64})/.exec(first.error.message ?? "");
  assert.ok(match, `expected a prompt hash in the error, got: ${first.error.message}`);
  const path = resolve(FIXTURE_DIR, `${match[1]!}.json`);
  writtenFixtures.push(path);
  await writeFile(
    path,
    JSON.stringify({
      json: {
        rationale:
          "The candidate's ask of INR 36,00,000 exceeds the band ceiling of INR 30,00,000, so HR-head approval is required before extending. The suggested figure holds at the band max; no curated benchmark contradicts the band.",
      },
      inputTokens: 500,
      outputTokens: 90,
      costMicros: 4200,
      latencyMs: 400,
    }),
  );
  return trpcMutation<{ rationale: { rationale: string } }>(
    "generateCompRationale",
    { applicationId },
    jwt,
  );
}

async function seedFixtures(): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${FX_BU}, ${tenantId}, ${`HROPS-02 QA ${RUN}`}, ${`hrops02-qa-${RUN}`})
    ON CONFLICT (id) DO NOTHING
  `;
  // Band ₹20–30 LPA in MAJOR rupees (positions convention).
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, primary_location,
       comp_band_min, comp_band_max, comp_currency, is_active)
    VALUES (${FX_POSITION}, ${tenantId}, ${FX_BU}, ${`HROPS-02 Platform Engineer ${RUN}`},
            'hybrid', 'Bengaluru', 2000000, 3000000, 'INR', true)
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${FX_JD}, ${tenantId}, ${FX_POSITION}, 1, '# HROPS-02 JD', 'approved')
    ON CONFLICT (id) DO NOTHING
  `;
  const [m] = await poolSql<{ id: string }[]>`
    SELECT id FROM public.tenant_user_memberships WHERE tenant_id = ${tenantId} LIMIT 1
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${FX_REQ}, ${tenantId}, ${FX_POSITION}, ${FX_JD}, ${m!.id}, ${m!.id}, 'posted')
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
    VALUES (${FX_PERSON}, ${tenantId}, 'HROPS-02 Test Candidate',
            'hrops02-cand@example.test', 'hrops02-cand@example.test')
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${FX_CANDIDATE}, ${tenantId}, ${FX_PERSON}, 'career_site', 'v1')
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql.unsafe(`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage,
       stage_entered_at, expected_salary_inr_paise)
    VALUES ('${FX_APP}', '${tenantId}', '${FX_CANDIDATE}', '${FX_REQ}', 'career_site',
            'hr_round', now(), ${EXPECTED_PAISE})
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup(): Promise<void> {
  const steps: (() => Promise<unknown>)[] = [
    () =>
      poolSql`DELETE FROM public.approval_decisions WHERE request_id IN (
        SELECT id FROM public.approval_requests WHERE tenant_id = ${tenantId}
          AND subject_type = 'offer'
          AND subject_id IN (SELECT id FROM public.offers WHERE application_id = ${FX_APP}))`,
    () =>
      poolSql`DELETE FROM public.approval_requests WHERE tenant_id = ${tenantId}
        AND subject_type = 'offer'
        AND subject_id IN (SELECT id FROM public.offers WHERE application_id = ${FX_APP})`,
    ...chainIds.map((id) => () => poolSql`DELETE FROM public.approval_chains WHERE id = ${id}`),
    () =>
      poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${tenantId}
        AND recipient_email = 'hrops02-cand@example.test'`,
    () => poolSql`DELETE FROM public.comp_recommendations WHERE application_id = ${FX_APP}`,
    () => poolSql`DELETE FROM public.offers WHERE application_id = ${FX_APP}`,
    () =>
      poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${FX_APP}`,
    () => poolSql`DELETE FROM public.applications WHERE id = ${FX_APP}`,
    () => poolSql`DELETE FROM public.candidates WHERE id = ${FX_CANDIDATE}`,
    () => poolSql`DELETE FROM public.persons WHERE id = ${FX_PERSON}`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${FX_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${FX_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${FX_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${FX_BU}`,
  ];
  for (const run of steps) {
    try {
      await run();
    } catch (err) {
      console.warn("HROPS-02 cleanup step failed (continuing):", err);
    }
  }
  for (const p of writtenFixtures) await unlink(p).catch(() => {});
}

describe("HROPS-02 comp & offer desk", () => {
  beforeAll(async () => {
    [recruiterJwt, hrOpsJwt, hrHeadJwt, adminJwt] = await Promise.all([
      signIn(RECRUITER),
      signIn(HR_OPS),
      signIn(HR_HEAD),
      signIn(ADMIN),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    await cleanup(); // wipe residue from a prior aborted run
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("Test 1: listCompDesk shows the rule-computed verdict; recruiter FORBIDDEN", async () => {
    interface DeskOut {
      rows: {
        applicationId: string;
        verdict: string | null;
        suggestedPaise: number | null;
        expectedSalaryInrPaise: number | null;
        bandMaxPaise: number | null;
        approvalStatus: string;
        reasons: string[];
      }[];
      stats: { total: number; needApproval: number };
    }
    const res = await trpcQuery<DeskOut>("listCompDesk", {}, hrOpsJwt);
    assert.ok(!isErr(res), `listCompDesk: ${JSON.stringify(res)}`);
    const mine = res.result.data.rows.find((r) => r.applicationId === FX_APP);
    assert.ok(mine, "fixture application appears on the desk");
    assert.equal(mine!.expectedSalaryInrPaise, EXPECTED_PAISE);
    assert.equal(mine!.bandMaxPaise, BAND_MAX_PAISE, "band converted major→paise");
    assert.equal(mine!.verdict, "need_approval", "expected > band max → need_approval");
    assert.equal(mine!.suggestedPaise, BAND_MAX_PAISE, "suggestion capped at band max");
    assert.ok(mine!.reasons.length >= 1, "reasons present");
    assert.equal(mine!.approvalStatus, "not_required", "no offer yet → nothing to approve yet");
    assert.ok(res.result.data.stats.total >= 1);

    const forbidden = await trpcQuery("listCompDesk", {}, recruiterJwt);
    assert.ok(
      isErr(forbidden) && forbidden.error.data.code === "FORBIDDEN",
      "recruiter cannot read the comp desk",
    );
  });

  it("Test 2: generateCompRationale caches + regenerate replaces + cost-logged", async () => {
    const res = await generateWithFixture(FX_APP, hrOpsJwt);
    assert.ok(!isErr(res), `generate: ${JSON.stringify(res)}`);
    assert.ok(res.result.data.rationale.rationale.length > 10, "prose rationale returned");

    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.comp_recommendations
      WHERE tenant_id = ${tenantId} AND application_id = ${FX_APP}
    `;
    assert.equal(Number(n), 1, "one comp_recommendations row cached");

    const [{ un } = { un: 0 }] = await poolSql<{ un: number }[]>`
      SELECT count(*)::int AS un FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'comp_recommendation' AND succeeded = true
    `;
    assert.ok(Number(un) >= 1, "a successful comp_recommendation ai_usage_logs row exists");

    // Regenerate → REPLACES (still exactly one row).
    const again = await generateWithFixture(FX_APP, hrOpsJwt);
    assert.ok(!isErr(again), `regenerate: ${JSON.stringify(again)}`);
    const [{ n2 } = { n2: 0 }] = await poolSql<{ n2: number }[]>`
      SELECT count(*)::int AS n2 FROM public.comp_recommendations
      WHERE tenant_id = ${tenantId} AND application_id = ${FX_APP}
    `;
    assert.equal(Number(n2), 1, "regenerate replaced the cached row");

    // Readable via getCompAnalysis, with the verdict snapshot attached.
    interface AnalysisOut {
      analysis: {
        rationale: { rationale: string; verdictSnapshot: string } | null;
      } | null;
    }
    const got = await trpcQuery<AnalysisOut>(
      "getCompAnalysis",
      { applicationId: FX_APP },
      hrOpsJwt,
    );
    assert.ok(!isErr(got), `getCompAnalysis: ${JSON.stringify(got)}`);
    assert.ok(got.result.data.analysis?.rationale, "cached rationale on the analysis");
    assert.equal(got.result.data.analysis!.rationale!.verdictSnapshot, "need_approval");
  });

  it("Test 3: kill-switch — disabled feature refuses cleanly, no model call", async () => {
    interface Settings {
      [k: string]: unknown;
      comp_recommendation: { enabled: boolean };
    }
    const current = await trpcQuery<Settings>("getTenantAiSettings", {}, adminJwt);
    assert.ok(!isErr(current), `getTenantAiSettings: ${JSON.stringify(current)}`);
    const original = current.result.data;

    const [{ before } = { before: 0 }] = await poolSql<{ before: number }[]>`
      SELECT count(*)::int AS before FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'comp_recommendation'
    `;

    const disabled = {
      ...original,
      comp_recommendation: { ...original.comp_recommendation, enabled: false },
    };
    const off = await trpcMutation("updateTenantAiSettings", disabled, adminJwt);
    assert.ok(!isErr(off), `disable: ${JSON.stringify(off)}`);

    try {
      const refused = await trpcMutation(
        "generateCompRationale",
        { applicationId: FX_APP },
        hrOpsJwt,
      );
      assert.ok(isErr(refused), "disabled feature refuses");
      assert.equal(refused.error.data.code, "BAD_REQUEST");
      assert.ok(
        (refused.error.message ?? "").toLowerCase().includes("disabled"),
        `clean disabled message: ${refused.error.message}`,
      );
      const [{ after } = { after: 0 }] = await poolSql<{ after: number }[]>`
        SELECT count(*)::int AS after FROM public.ai_usage_logs
        WHERE tenant_id = ${tenantId} AND feature = 'comp_recommendation'
      `;
      assert.equal(Number(after), Number(before), "no usage log written while disabled");
    } finally {
      const restore = await trpcMutation("updateTenantAiSettings", original, adminJwt);
      assert.ok(!isErr(restore), `restore settings: ${JSON.stringify(restore)}`);
    }
  });

  it("Test 4: out-of-band extend is server-gated until HR-head approval", async () => {
    // Draft ABOVE band max (₹36 LPA > ₹30 LPA) from the desk composer.
    interface DraftOut {
      offerId: string;
      needsApproval: boolean;
    }
    const draft = await trpcMutation<DraftOut>(
      "draftCompOffer",
      {
        applicationId: FX_APP,
        baseSalaryInrPaise: EXPECTED_PAISE,
        joiningDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        location: "Bengaluru (Hybrid)",
        contractType: "full_time",
        probationMonths: 3,
        benefits: ["health_insurance", "provident_fund"],
        expiryDays: 7,
      },
      hrOpsJwt,
    );
    assert.ok(!isErr(draft), `draftCompOffer: ${JSON.stringify(draft)}`);
    assert.equal(draft.result.data.needsApproval, true, "over-band draft flags approval");
    const offerId = draft.result.data.offerId;

    // The HROPS-02 offer terms landed on the row.
    const [offerRow] = await poolSql<
      { contract_type: string; probation_months: number; benefits: unknown }[]
    >`
      SELECT contract_type, probation_months, benefits FROM public.offers WHERE id = ${offerId}
    `;
    assert.equal(offerRow!.contract_type, "full_time");
    assert.equal(offerRow!.probation_months, 3);
    assert.deepEqual(offerRow!.benefits, ["health_insurance", "provident_fund"]);

    // Extend BLOCKED before any approval.
    const blocked = await trpcMutation("extendOffer", { offerId }, hrOpsJwt);
    assert.ok(isErr(blocked), "extend refused pre-approval");
    assert.equal(blocked.error.data.code, "BAD_REQUEST");
    assert.ok(
      (blocked.error.message ?? "").includes("HR-head approval"),
      `gate message: ${blocked.error.message}`,
    );

    // Raise the approval (idempotent).
    interface ReqOut {
      approvalRequestId: string;
      status: string;
      alreadyRequested: boolean;
    }
    const req = await trpcMutation<ReqOut>("requestOfferApproval", { offerId }, hrOpsJwt);
    assert.ok(!isErr(req), `requestOfferApproval: ${JSON.stringify(req)}`);
    assert.equal(req.result.data.status, "pending");
    const approvalRequestId = req.result.data.approvalRequestId;
    const [chainRow] = await poolSql<{ chain_id: string }[]>`
      SELECT chain_id FROM public.approval_requests WHERE id = ${approvalRequestId}
    `;
    if (chainRow) chainIds.push(chainRow.chain_id);

    // Second request is a clean idempotent no-op.
    const req2 = await trpcMutation<ReqOut>("requestOfferApproval", { offerId }, hrOpsJwt);
    assert.ok(!isErr(req2), `requestOfferApproval#2: ${JSON.stringify(req2)}`);
    assert.equal(req2.result.data.alreadyRequested, true);
    assert.equal(req2.result.data.approvalRequestId, approvalRequestId);

    // Still blocked while pending.
    const stillBlocked = await trpcMutation("extendOffer", { offerId }, hrOpsJwt);
    assert.ok(isErr(stillBlocked), "extend still refused while approval pending");

    // hr_ops cannot decide; the queue is visible to the HR head.
    const cannotDecide = await trpcMutation(
      "decideOfferApproval",
      { approvalRequestId, decision: "approve" },
      hrOpsJwt,
    );
    assert.ok(
      isErr(cannotDecide) && cannotDecide.error.data.code === "FORBIDDEN",
      "hr_ops cannot decide an offer approval",
    );
    interface QueueOut {
      rows: { approvalRequestId: string; baseInrPaise: number; bandMaxPaise: number | null }[];
    }
    const queue = await trpcQuery<QueueOut>("listOfferApprovals", {}, hrHeadJwt);
    assert.ok(!isErr(queue), `listOfferApprovals: ${JSON.stringify(queue)}`);
    const qrow = queue.result.data.rows.find((r) => r.approvalRequestId === approvalRequestId);
    assert.ok(qrow, "pending approval visible to the HR head");
    assert.equal(qrow!.baseInrPaise, EXPECTED_PAISE);
    assert.equal(qrow!.bandMaxPaise, BAND_MAX_PAISE);

    // HR head approves → gate opens → extend succeeds.
    const decide = await trpcMutation(
      "decideOfferApproval",
      { approvalRequestId, decision: "approve", reason: "Critical skill — band exception" },
      hrHeadJwt,
    );
    assert.ok(!isErr(decide), `decideOfferApproval: ${JSON.stringify(decide)}`);

    const extend = await trpcMutation<{ offerId: string }>("extendOffer", { offerId }, hrOpsJwt);
    assert.ok(!isErr(extend), `extend after approval: ${JSON.stringify(extend)}`);
    const [o] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.offers WHERE id = ${offerId}
    `;
    assert.equal(o!.status, "extended", "offer extended once approved");
  });

  it("Test 5: in-band draft needs no approval and refuses a redundant request", async () => {
    // Cancel the extended offer first so a fresh draft is allowed.
    interface DeskOut {
      rows: { applicationId: string; offerId: string | null }[];
    }
    const desk = await trpcQuery<DeskOut>("listCompDesk", {}, hrOpsJwt);
    assert.ok(!isErr(desk));
    const mine = desk.result.data.rows.find((r) => r.applicationId === FX_APP);
    if (mine?.offerId) {
      await trpcMutation(
        "cancelOffer",
        { offerId: mine.offerId, reason: "HROPS-02 test reset" },
        hrOpsJwt,
      );
    }

    const draft = await trpcMutation<{ offerId: string; needsApproval: boolean }>(
      "draftCompOffer",
      {
        applicationId: FX_APP,
        baseSalaryInrPaise: 28 * L_PAISE, // within the ₹20–30 LPA band
        joiningDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        location: "Bengaluru (Hybrid)",
        contractType: "full_time",
        probationMonths: 3,
        benefits: [],
        expiryDays: 7,
      },
      hrOpsJwt,
    );
    assert.ok(!isErr(draft), `in-band draft: ${JSON.stringify(draft)}`);
    assert.equal(draft.result.data.needsApproval, false, "in-band → no approval needed");

    const refuse = await trpcMutation(
      "requestOfferApproval",
      { offerId: draft.result.data.offerId },
      hrOpsJwt,
    );
    assert.ok(isErr(refuse), "approval request refused for an in-band offer");
    assert.equal(refuse.error.data.code, "BAD_REQUEST");
  });
});
