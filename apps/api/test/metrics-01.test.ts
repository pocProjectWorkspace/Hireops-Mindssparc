/**
 * METRICS-01 — tRPC tests for getHrMetrics (the /metrics HR analytics read).
 *
 * The single aggregate behind the chart grid. Verified through real
 * cloud-minted JWTs (reality #110 — no local JWT minting; we sign in as the
 * seeded kyndryl-poc personas whose memberships carry the roles under test),
 * the same idiom as dash-01.
 *
 * Coverage:
 *   1. Role gating — hr_head + admin succeed; recruiter gets FORBIDDEN
 *      (the API gate, not just the nav).
 *   2. Shape + stage ordering — funnel and timeInStage each list all 11
 *      application_stage labels in enum order; scoreDistribution is the 10
 *      width-10 buckets low→high with the right tier bands; offerFunnel and
 *      kpis carry the documented keys.
 *   3. Cross-panel invariants that hold for ANY tenant data (robust to
 *      demo-data churn on the shared DB): applications = Σ funnel counts;
 *      hired = the offer_accepted bucket; extended >= accepted + declined;
 *      sourceMix ordered by applications desc.
 *   4. Seeded spot value — the kyndryl-poc demo tenant has at least one
 *      application (a posted req with applicants per the demo runbook), so
 *      kpis.applications >= 1 and the funnel is non-empty.
 */

import "../src/bootstrap";

import { beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const USERS = {
  recruiter: "recruiter1@kyndryl-poc.test",
  hrHead: "hrhead1@kyndryl-poc.test",
  admin: "admin1@kyndryl-poc.test",
} as const;

const jwt: Record<string, string> = {};

function tok(k: keyof typeof USERS): string {
  const t = jwt[k];
  if (!t) throw new Error(`no JWT for ${k} — did signIn run in beforeAll?`);
  return t;
}

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

async function trpcQuery<O>(name: string, jwtToken: string): Promise<TRPCSuccess<O> | TRPCErr> {
  const res = await app.request(`/trpc/${name}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwtToken}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

const ALL_STAGES = [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
];

const TERMINAL = new Set(["offer_accepted", "offer_declined", "withdrawn", "recruiter_rejected"]);

interface HrMetrics {
  kpis: {
    applications: number;
    active: number;
    hired: number;
    offers_extended: number;
    avg_ai_score: number | null;
  };
  funnel: Array<{ stage: string; count: number }>;
  timeInStage: Array<{ stage: string; avg_days: number | null }>;
  sourceMix: Array<{ source: string; applications: number }>;
  offerFunnel: { extended: number; accepted: number; declined: number };
  aiSpend: Array<{ day: string; cost_micros: string; calls: number }>;
  scoreDistribution: Array<{
    label: string;
    min: number;
    max: number;
    count: number;
    tier: string;
  }>;
}

describe("METRICS-01 — getHrMetrics", () => {
  beforeAll(async () => {
    for (const [k, email] of Object.entries(USERS)) {
      jwt[k] = await signIn(email);
    }
  });

  it("Test 1: role gating — recruiter FORBIDDEN, hr_head + admin allowed", async () => {
    const asRecruiter = await trpcQuery<HrMetrics>("getHrMetrics", tok("recruiter"));
    assert.ok(isErr(asRecruiter), "recruiter should be denied");
    assert.equal(
      asRecruiter.error.data.code,
      "FORBIDDEN",
      `recruiter should get FORBIDDEN, got ${JSON.stringify(asRecruiter.error)}`,
    );

    const asHrHead = await trpcQuery<HrMetrics>("getHrMetrics", tok("hrHead"));
    assert.ok(!isErr(asHrHead), `hr_head should be allowed: ${JSON.stringify(asHrHead)}`);

    const asAdmin = await trpcQuery<HrMetrics>("getHrMetrics", tok("admin"));
    assert.ok(!isErr(asAdmin), `admin should be allowed: ${JSON.stringify(asAdmin)}`);
  });

  it("Test 2: shape + stage ordering + score buckets", async () => {
    const res = await trpcQuery<HrMetrics>("getHrMetrics", tok("admin"));
    assert.ok(!isErr(res), `query should succeed: ${JSON.stringify(res)}`);
    const m = res.result.data;

    // funnel — all 11 stages, enum order.
    assert.equal(m.funnel.length, 11, "funnel lists all 11 stages");
    assert.deepEqual(
      m.funnel.map((f) => f.stage),
      ALL_STAGES,
      "funnel in enum order",
    );
    assert.ok(
      m.funnel.every((f) => Number.isInteger(f.count) && f.count >= 0),
      "funnel counts are non-negative ints",
    );

    // timeInStage — all 11 stages, enum order, avg_days number|null.
    assert.equal(m.timeInStage.length, 11, "timeInStage lists all 11 stages");
    assert.deepEqual(
      m.timeInStage.map((s) => s.stage),
      ALL_STAGES,
      "timeInStage in enum order",
    );
    assert.ok(
      m.timeInStage.every((s) => s.avg_days === null || typeof s.avg_days === "number"),
      "avg_days is number|null",
    );

    // scoreDistribution — 10 width-10 buckets low→high with tier bands.
    assert.equal(m.scoreDistribution.length, 10, "10 score buckets");
    const expectedTiers = [
      "neutral", // 0–9
      "neutral", // 10–19
      "neutral", // 20–29
      "neutral", // 30–39
      "neutral", // 40–49
      "silver", // 50–59
      "silver", // 60–69
      "gold", // 70–79
      "gold", // 80–89
      "platinum", // 90–100
    ];
    m.scoreDistribution.forEach((b, i) => {
      assert.equal(b.min, i * 10, `bucket ${i} min`);
      assert.equal(b.max, i === 9 ? 100 : i * 10 + 9, `bucket ${i} max`);
      assert.equal(b.label, `${b.min}–${b.max}`, `bucket ${i} label`);
      assert.equal(b.tier, expectedTiers[i], `bucket ${i} tier band`);
      assert.ok(Number.isInteger(b.count) && b.count >= 0, `bucket ${i} count`);
    });

    // offerFunnel + kpis keys.
    for (const key of ["extended", "accepted", "declined"] as const) {
      assert.ok(Number.isInteger(m.offerFunnel[key]), `offerFunnel.${key} is an int`);
    }
    assert.ok(Number.isInteger(m.kpis.applications), "kpis.applications int");
    assert.ok(
      m.kpis.avg_ai_score === null || typeof m.kpis.avg_ai_score === "number",
      "avg_ai_score",
    );

    // aiSpend — at most 14 daily rows, each well-formed.
    assert.ok(m.aiSpend.length <= 14, "aiSpend is at most 14 days");
    assert.ok(
      m.aiSpend.every(
        (d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day) && typeof d.cost_micros === "string",
      ),
      "aiSpend rows are well-formed",
    );
  });

  it("Test 3: cross-panel invariants (churn-robust)", async () => {
    const res = await trpcQuery<HrMetrics>("getHrMetrics", tok("admin"));
    assert.ok(!isErr(res), `query should succeed: ${JSON.stringify(res)}`);
    const m = res.result.data;

    const funnelByStage = Object.fromEntries(m.funnel.map((f) => [f.stage, f.count]));
    const funnelSum = m.funnel.reduce((s, f) => s + f.count, 0);
    const activeSum = m.funnel
      .filter((f) => !TERMINAL.has(f.stage))
      .reduce((s, f) => s + f.count, 0);

    assert.equal(m.kpis.applications, funnelSum, "applications = Σ funnel counts");
    assert.equal(m.kpis.active, activeSum, "active = Σ non-terminal funnel counts");
    assert.equal(m.kpis.hired, funnelByStage.offer_accepted, "hired = offer_accepted bucket");

    assert.ok(
      m.offerFunnel.extended >= m.offerFunnel.accepted + m.offerFunnel.declined,
      "extended >= accepted + declined (funnel invariant)",
    );
    assert.equal(m.kpis.offers_extended, m.offerFunnel.extended, "kpis.offers_extended matches");

    // sourceMix ordered by applications desc.
    for (let i = 1; i < m.sourceMix.length; i++) {
      assert.ok(
        m.sourceMix[i - 1]!.applications >= m.sourceMix[i]!.applications,
        "sourceMix ordered by applications desc",
      );
    }
  });

  it("Test 4: seeded spot value — the demo tenant has applications", async () => {
    const res = await trpcQuery<HrMetrics>("getHrMetrics", tok("hrHead"));
    assert.ok(!isErr(res), `query should succeed: ${JSON.stringify(res)}`);
    const m = res.result.data;

    // The kyndryl-poc demo tenant always carries at least one seeded
    // application (a posted requisition with applicants per the demo runbook).
    assert.ok(m.kpis.applications >= 1, "demo tenant has >= 1 application");
    assert.ok(
      m.funnel.some((f) => f.count > 0),
      "at least one funnel stage is non-empty",
    );
  });
});
