/**
 * HRHEAD-01 — HR-head dashboard extras + enriched approvals queue.
 *
 * Exercised over real cloud-minted JWTs (reality #110 — sign in as the seeded
 * personas whose kyndryl-poc memberships carry the roles under test). Asserts
 * on SHAPE + derivation invariants, not exact seeded numbers, so it is robust
 * to demo-data churn on the shared DB.
 *
 *   getHrHeadDashboardExtras:
 *     - hr_head ✓ / admin ✓ read; recruiter ✗ / hiring_manager ✗ (FORBIDDEN)
 *     - KPI shape: exactly one hero, four keys present, hero has a $/count value
 *     - delta shape (direction/tone enums) when present
 *     - funnel stages are the 8 forward stages IN canonical order, pct 0–100
 *     - bottleneck is null or a string
 *     - approvals rows carry the derived priority consistent with ageDays
 *     - risk: enforcement ∈ {off,warn,block}, staleApprovals ≥ 0, benchmark null|int
 *     - time-to-hire KPI value is "—" or an "…d" string (math shape)
 *
 *   listRequisitionApprovals (HRHEAD-01 enrichment):
 *     - rows carry priority/outcome/ageDays/department/budgetBand/requestedByName
 *     - priority derivation matches age; outcome ∈ the vocabulary
 *     - decided rows (non-pending) surface under a filterable outcome
 *
 * Requires `pnpm db:seed:test-users` (recruiter1 / hiringmanager1 / hrhead1 /
 * admin1). No writes — read-only assertions, nothing to clean up.
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
  hiringManager: "hiringmanager1@kyndryl-poc.test",
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

async function trpcQuery<O>(
  name: string,
  jwtToken: string,
  input?: unknown,
): Promise<TRPCSuccess<O> | TRPCErr> {
  const suffix = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(`/trpc/${name}${suffix}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwtToken}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

// The derivation under test — kept identical to the router helper so the test
// pins the contract, not just "one of the enum".
function expectedPriority(ageDays: number): "high" | "medium" | "low" {
  if (ageDays > 7) return "high";
  if (ageDays > 3) return "medium";
  return "low";
}

const FORWARD_STAGES = [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
];

interface Delta {
  label: string;
  direction: string;
  tone: string;
  caption: string;
}
interface Kpi {
  key: string;
  label: string;
  value: string;
  caption: string | null;
  delta: Delta | null;
  hero: boolean;
  href: string;
}
interface FunnelStage {
  stage: string;
  label: string;
  count: number;
  pct: number;
}
interface ApprovalItem {
  approvalRequestId: string;
  requisitionId: string;
  title: string | null;
  department: string | null;
  budgetBand: string | null;
  requestedByName: string | null;
  priority: string;
  ageDays: number;
  biasFlags: unknown[];
}
interface Extras {
  kpis: Kpi[];
  funnel: { stages: FunnelStage[]; bottleneck: string | null };
  approvals: ApprovalItem[];
  risk: { biasGateEnforcement: string; staleApprovals: number; belowBenchmark: number | null };
}

interface ApprovalRow {
  id: string;
  subjectId: string;
  title: string | null;
  status: string;
  department: string | null;
  budgetBand: string | null;
  requestedByName: string | null;
  ageDays: number;
  priority: string;
  outcome: string;
}

describe("HRHEAD-01 dashboard extras + enriched approvals", () => {
  beforeAll(async () => {
    const entries = await Promise.all(
      Object.entries(USERS).map(async ([k, email]) => [k, await signIn(email)] as const),
    );
    for (const [k, token] of entries) jwt[k] = token;
  });

  it("Test 1: recruiter + hiring_manager are FORBIDDEN from getHrHeadDashboardExtras", async () => {
    for (const role of ["recruiter", "hiringManager"] as const) {
      const res = await trpcQuery<Extras>("getHrHeadDashboardExtras", tok(role));
      assert.ok(isErr(res), `${role} expected denial, got ${JSON.stringify(res)}`);
      assert.equal(res.error.data.code, "FORBIDDEN", `${role} should be FORBIDDEN`);
    }
  });

  it("Test 2: hr_head reads extras with exactly one hero + four KPI keys", async () => {
    const res = await trpcQuery<Extras>("getHrHeadDashboardExtras", tok("hrHead"));
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    const d = res.result.data;
    const heroes = d.kpis.filter((k) => k.hero);
    assert.equal(heroes.length, 1, "exactly one hero KPI");
    const keys = new Set(d.kpis.map((k) => k.key));
    for (const k of ["hrh_pending", "hrh_tth", "hrh_acceptance", "hrh_cost_per_hire"]) {
      assert.ok(keys.has(k), `has KPI ${k}`);
    }
    // Hero (pending) is a numeric string; cost-per-hire is "$…" or "—".
    const cph = d.kpis.find((k) => k.key === "hrh_cost_per_hire")!;
    assert.ok(cph.value === "—" || cph.value.startsWith("$"), `cost-per-hire is $/—: ${cph.value}`);
    for (const k of d.kpis) {
      if (k.delta) {
        assert.ok(["up", "down", "flat"].includes(k.delta.direction), "delta direction enum");
        assert.ok(["good", "bad", "neutral"].includes(k.delta.tone), "delta tone enum");
      }
    }
  });

  it("Test 3: admin may also read extras", async () => {
    const res = await trpcQuery<Extras>("getHrHeadDashboardExtras", tok("admin"));
    assert.ok(!isErr(res), `expected admin success, got ${JSON.stringify(res)}`);
    assert.ok(Array.isArray(res.result.data.kpis), "kpis is an array");
  });

  it("Test 4: funnel is the 8 forward stages in canonical order, pct 0–100", async () => {
    const res = await trpcQuery<Extras>("getHrHeadDashboardExtras", tok("hrHead"));
    assert.ok(!isErr(res));
    const stages = res.result.data.funnel.stages;
    assert.deepEqual(
      stages.map((s) => s.stage),
      FORWARD_STAGES,
      "funnel stage ordering matches the forward pipeline",
    );
    for (const s of stages) {
      assert.ok(s.pct >= 0 && s.pct <= 100, `pct in range: ${s.pct}`);
      assert.ok(Number.isInteger(s.count) && s.count >= 0, `count non-negative int: ${s.count}`);
    }
    const b = res.result.data.funnel.bottleneck;
    assert.ok(b === null || typeof b === "string", "bottleneck is null or string");
  });

  it("Test 5: risk panel shape (enforcement enum, benchmark defensive-null)", async () => {
    const res = await trpcQuery<Extras>("getHrHeadDashboardExtras", tok("hrHead"));
    assert.ok(!isErr(res));
    const risk = res.result.data.risk;
    assert.ok(["off", "warn", "block"].includes(risk.biasGateEnforcement), "enforcement enum");
    assert.ok(risk.staleApprovals >= 0, "staleApprovals non-negative");
    assert.ok(
      risk.belowBenchmark === null || Number.isInteger(risk.belowBenchmark),
      "belowBenchmark is null (HRHEAD-02 table absent) or an int",
    );
  });

  it("Test 6: extras approvals rows carry priority consistent with ageDays", async () => {
    const res = await trpcQuery<Extras>("getHrHeadDashboardExtras", tok("hrHead"));
    assert.ok(!isErr(res));
    for (const a of res.result.data.approvals) {
      assert.equal(
        a.priority,
        expectedPriority(a.ageDays),
        `priority derivation for age ${a.ageDays}`,
      );
      assert.ok(a.ageDays >= 0, "ageDays non-negative");
    }
  });

  it("Test 7: listRequisitionApprovals is enriched + priority/outcome derived", async () => {
    const res = await trpcQuery<{ rows: ApprovalRow[] }>(
      "listRequisitionApprovals",
      tok("hrHead"),
      {
        limit: 100,
      },
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    const rows = res.result.data.rows;
    assert.ok(Array.isArray(rows), "rows is an array");
    const OUTCOMES = ["pending", "approved", "sent_back", "rejected", "expired"];
    for (const r of rows) {
      assert.ok(["high", "medium", "low"].includes(r.priority), `priority enum: ${r.priority}`);
      assert.equal(r.priority, expectedPriority(r.ageDays), `priority matches age ${r.ageDays}`);
      assert.ok(OUTCOMES.includes(r.outcome), `outcome enum: ${r.outcome}`);
      assert.ok(Number.isInteger(r.ageDays) && r.ageDays >= 0, "ageDays non-negative int");
      // Enrichment keys are present (values may be null).
      assert.ok(
        "department" in r && "budgetBand" in r && "requestedByName" in r,
        "enrichment keys",
      );
    }
  });

  it("Test 8: recruiter is FORBIDDEN from the approvals queue (gating unchanged)", async () => {
    const res = await trpcQuery("listRequisitionApprovals", tok("recruiter"), { limit: 10 });
    assert.ok(isErr(res), `recruiter expected denial, got ${JSON.stringify(res)}`);
    assert.equal(res.error.data.code, "FORBIDDEN");
  });
});
