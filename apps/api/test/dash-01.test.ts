/**
 * DASH-01 — persona landing dashboards (getMyDashboard).
 *
 * Verifies the one aggregate read per persona through real cloud-minted JWTs
 * (reality #110 — no local JWT minting; we sign in as the seeded personas whose
 * kyndryl-poc memberships carry the roles under test):
 *
 *   - shape per role: {variants, kpis[], actions[]} with typed tiles/rows
 *   - role variant selection: recruiter ≠ hr_head payloads (different variants
 *     AND different KPI keys)
 *   - every href in every payload matches an existing route (allowlist)
 *   - a non-internal identity (candidate) is DENIED (candidate JWT carries no
 *     `tid`, so protectedProcedure rejects it UNAUTHORIZED — a strictly stronger
 *     denial than the internal-role FORBIDDEN gate)
 *   - a seed-stable spot value: admin AI-spend tiles are "$"-prefixed strings
 *
 * Requires the test-user seed (`pnpm db:seed:test-users`): recruiter1@,
 * hiringmanager1@, hrhead1@, panel1@, hr_ops1@, admin1@. The candidate check
 * additionally uses the candidate-demo seed (priya.subramanian@example.test);
 * it soft-passes with a warning if that account is absent, so the gate never
 * red-lines on a seed this ticket does not own. Asserts on SHAPE + href
 * validity, not row counts, so it is robust to demo-data churn on the shared DB.
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
  panel: "panel1@kyndryl-poc.test",
  hrOps: "hr_ops1@kyndryl-poc.test",
  admin: "admin1@kyndryl-poc.test",
} as const;
const CANDIDATE = "priya.subramanian@example.test";

const jwt: Record<string, string> = {};
let candidateJwt: string | null = null;

/** Token accessor — throws a clear error rather than passing `undefined` on. */
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

// ─── route allowlist: every dashboard href must match one of these ───
type Template = string[]; // segment list; ":id" is a wildcard single segment
const ROUTE_TEMPLATES: Template[] = [
  ["dashboard"],
  ["triage"],
  ["approvals"],
  ["onboarding"],
  ["offboarding"],
  ["requisitions"],
  ["requisition-approvals"],
  ["interviews"],
  ["panel"],
  ["admin", "workflows"],
  ["admin", "audit"],
  ["admin", "costs"],
  ["admin", "ai-settings"],
  ["admin", "users"],
  ["admin", "reports"],
  ["admin", "integrations"],
  ["requisitions", ":id"],
  ["onboarding", ":id"],
  ["offboarding", ":id"],
  ["panel", ":id"],
];

function hrefIsAllowed(href: string): boolean {
  const path = href.split("?")[0] ?? href;
  const segs = path.split("/").filter(Boolean);
  return ROUTE_TEMPLATES.some(
    (tpl) => tpl.length === segs.length && tpl.every((t, i) => t === ":id" || t === segs[i]),
  );
}

interface Kpi {
  key: string;
  label: string;
  value: number | string;
  hint: string | null;
  tone: string;
  href: string;
}
interface Action {
  key: string;
  label: string;
  detail: string | null;
  href: string;
  urgency: string;
}
interface Dashboard {
  variants: string[];
  kpis: Kpi[];
  actions: Action[];
  activity?: { key: string; href: string | null }[];
}

function assertShape(d: Dashboard) {
  assert.ok(Array.isArray(d.variants), "variants is an array");
  assert.ok(Array.isArray(d.kpis), "kpis is an array");
  assert.ok(Array.isArray(d.actions), "actions is an array");
  for (const k of d.kpis) {
    assert.ok(typeof k.key === "string" && k.key.length > 0, "kpi.key");
    assert.ok(typeof k.label === "string", "kpi.label");
    assert.ok(
      ["neutral", "accent", "positive", "warning", "error", "info"].includes(k.tone),
      `kpi.tone ${k.tone}`,
    );
    assert.ok(hrefIsAllowed(k.href), `kpi.href not in allowlist: ${k.href}`);
  }
  for (const a of d.actions) {
    assert.ok(["normal", "attention", "urgent"].includes(a.urgency), `action.urgency ${a.urgency}`);
    assert.ok(hrefIsAllowed(a.href), `action.href not in allowlist: ${a.href}`);
  }
  for (const it of d.activity ?? []) {
    if (it.href) assert.ok(hrefIsAllowed(it.href), `activity.href not in allowlist: ${it.href}`);
  }
}

describe("DASH-01 persona dashboards", () => {
  beforeAll(async () => {
    const entries = await Promise.all(
      Object.entries(USERS).map(async ([k, email]) => [k, await signIn(email)] as const),
    );
    for (const [k, token] of entries) jwt[k] = token;
    try {
      candidateJwt = await signIn(CANDIDATE);
    } catch {
      candidateJwt = null;
    }
  });

  it("Test 1: recruiter dashboard has the recruiter variant + valid shape", async () => {
    const res = await trpcQuery<Dashboard>("getMyDashboard", tok("recruiter"));
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    const d = res.result.data;
    assertShape(d);
    assert.deepEqual(d.variants, ["recruiter"], "recruiter variant only");
    assert.ok(
      d.kpis.some((k) => k.key === "rec_new"),
      "has rec_new KPI",
    );
    assert.ok(
      d.kpis.some((k) => k.key === "rec_sla"),
      "has rec_sla KPI",
    );
  });

  it("Test 2: hr_head dashboard differs from recruiter (variant selection)", async () => {
    const rec = await trpcQuery<Dashboard>("getMyDashboard", tok("recruiter"));
    const hr = await trpcQuery<Dashboard>("getMyDashboard", tok("hrHead"));
    assert.ok(!isErr(rec) && !isErr(hr), "both succeed");
    assertShape(hr.result.data);
    assert.deepEqual(hr.result.data.variants, ["hr_head"], "hr_head variant only");
    assert.notDeepEqual(
      hr.result.data.variants,
      rec.result.data.variants,
      "recruiter ≠ hr_head variants",
    );
    assert.ok(
      hr.result.data.kpis.some((k) => k.key === "hrh_pending"),
      "has hrh_pending KPI",
    );
    // Disjoint KPI key spaces prove the payloads are genuinely different.
    const recKeys = new Set(rec.result.data.kpis.map((k) => k.key));
    assert.ok(
      hr.result.data.kpis.every((k) => !recKeys.has(k.key)),
      "hr_head KPI keys disjoint from recruiter's",
    );
  });

  it("Test 3: hiring_manager dashboard shape + variant", async () => {
    const res = await trpcQuery<Dashboard>("getMyDashboard", tok("hiringManager"));
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assertShape(res.result.data);
    assert.deepEqual(res.result.data.variants, ["hiring_manager"]);
  });

  it("Test 4: panel_member dashboard shape + variant", async () => {
    const res = await trpcQuery<Dashboard>("getMyDashboard", tok("panel"));
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assertShape(res.result.data);
    assert.deepEqual(res.result.data.variants, ["panel_member"]);
    assert.ok(
      res.result.data.kpis.some((k) => k.key === "pan_feedback"),
      "has pan_feedback KPI",
    );
  });

  it("Test 5: hr_ops dashboard shape + people_ops variant", async () => {
    const res = await trpcQuery<Dashboard>("getMyDashboard", tok("hrOps"));
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assertShape(res.result.data);
    assert.deepEqual(res.result.data.variants, ["people_ops"]);
    assert.ok(
      res.result.data.kpis.some((k) => k.key === "ops_docs"),
      "has ops_docs KPI",
    );
  });

  it("Test 6: admin dashboard is the condensed superset + $-prefixed AI spend", async () => {
    const res = await trpcQuery<Dashboard>("getMyDashboard", tok("admin"));
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    const d = res.result.data;
    assertShape(d);
    assert.deepEqual(d.variants, ["admin"], "admin variant only");
    const spendToday = d.kpis.find((k) => k.key === "adm_spend_today");
    assert.ok(spendToday, "has adm_spend_today KPI");
    assert.ok(
      typeof spendToday!.value === "string" && spendToday!.value.startsWith("$"),
      `AI spend is a $-string, got ${JSON.stringify(spendToday!.value)}`,
    );
    assert.ok(
      d.kpis.some((k) => k.key === "adm_workflows"),
      "has adm_workflows KPI",
    );
  });

  it("Test 7: a non-internal identity (candidate) is denied", async () => {
    if (!candidateJwt) {
      // eslint-disable-next-line no-console
      console.warn(
        "DASH-01 Test 7 soft-pass: candidate-demo account absent (run pnpm db:seed:candidate-demo to exercise fully)",
      );
      return;
    }
    const res = await trpcQuery<Dashboard>("getMyDashboard", candidateJwt);
    assert.ok(isErr(res), `expected denial, got ${JSON.stringify(res)}`);
    assert.ok(
      res.error.data.code === "UNAUTHORIZED" || res.error.data.code === "FORBIDDEN",
      `expected UNAUTHORIZED/FORBIDDEN, got ${res.error.data.code}`,
    );
  });
});
