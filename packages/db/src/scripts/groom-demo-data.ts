/**
 * Grooms the shared dev/staging/demo DB of test residue that pollutes
 * the user-visible demo surfaces (the deployed kyndryl-poc portal).
 *
 * The dev DB doubles as the live staging/demo DB — CI runs and the
 * Railway workers exercise it continuously, so tests leave residue
 * behind that leaks onto /triage, /admin/costs and /approvals. This
 * script removes exactly the named residue classes, idempotently, in
 * FK-safe order, and prints a before/after inventory.
 *
 * Removes (each verified present before deletion; counts reported):
 *
 *   1. CRS-01 E2E apply-form personas — persons in kyndryl-poc with an
 *      `@hireops-dev.local` email ("CRS-01 E2E Tester" et al.) plus
 *      their candidates / applications / state-transitions and any
 *      outbox rows (ai_score / notification / dev_email / workday_sync)
 *      hanging off those applications.
 *   2. AD03 cost fixtures in ai_usage_logs — request_id LIKE 'AD03-%'
 *      OR provider = 'ad03-test' (leaked test rows on /admin/costs).
 *   3. The leaked test agent `robust-01-test-stage-validation` — its
 *      ENTIRE subtree, child-first (approval_requests → run_actions →
 *      runs → run_outbox → approval_rules → actions → triggers → agent).
 *      Its pending approval otherwise pollutes /approvals.
 *   4. Test-created synth tenants (slug ILIKE '%synth%', never
 *      kyndryl-poc) — their orphan ai_usage_logs and, when FK-safe, the
 *      whole tenant (CASCADE clears operational children; append-only
 *      audit_logs — which carry NO tenant FK — are left as acceptable
 *      history). A synth tenant carrying api_audit_logs or pii_access_log
 *      rows is PRESERVED (deleting it would cascade into those append-only
 *      compliance tables); only its orphan ai_usage_logs are removed and
 *      the rest is reported.
 *   5. Stray agent_run_outbox rows whose agent no longer exists or is
 *      retired (reported + deleted).
 *   6. Onboarding residue — onboarding_cases (+ their tasks / documents / bgv
 *      runs+results / IT / assets) tied to `@hireops-dev.local` / `@onb02.test`
 *      test personas, never the seeded a5xx demo cases.
 *   7. Interview residue — interview_plans / interviews / interview_panelists /
 *      interview_feedback left by interrupted INT-02/03/04 runs (their personas
 *      carry an `@example.com` marker; the seed creates NO interview rows and
 *      uses `@example.test`, so no seeded row can match).
 *   8. candidate_accounts residue — accounts tied to a test-marker person,
 *      never Priya's seeded a7xx account (…a701, `@example.test`).
 *
 * HARD PROTECTIONS (enforced, not merely avoided):
 *   - Never deletes a row whose id is in the seed's
 *     `00000000-0000-4000-8000-00000000a5xx` namespace; the interview +
 *     candidate-account classes widen this to the whole `…00000000aXX` seed
 *     block (a5xx/a6xx/a7xx/a8xx) so Priya's …a701 account is protected.
 *   - Never touches audit_logs / api_audit_logs / pii_access_log
 *     (append-only compliance — residue there is acceptable history).
 *   - Never deletes any tenant other than a synth test tenant; never the
 *     kyndryl-poc tenant row itself.
 *   - Refuses to run (loud error) if the kyndryl-poc tenant or the Demo
 *     Follow-ups Agent (…a590) would be affected by any delete.
 *
 * Dry-run by default (prints the full inventory, changes nothing).
 * Pass `--execute` to perform the deletion. Idempotent: a second
 * `--execute` finds nothing.
 *
 * Run:  pnpm db:groom:demo-data            (dry run)
 *       pnpm db:groom:demo-data --execute  (perform deletion)
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const EXECUTE = process.argv.includes("--execute");

// ─────────────── protected constants ───────────────
const KYNDRYL_SLUG = "kyndryl-poc";
// Seed fixture namespace — ids of the form 00000000-0000-4000-8000-00000000a5XX.
const SEED_A5XX_PREFIX = "00000000-0000-4000-8000-00000000a5";
const DEMO_AGENT_ID = "00000000-0000-4000-8000-00000000a590";
const DEMO_AGENT_NAME = "Demo Follow-ups Agent";
const LEAKED_AGENT_NAME = "robust-01-test-stage-validation";
const DEV_LOCAL_EMAIL = "%@hireops-dev.local";
// ONBOARD-02 test personas carry an `@onb02.test` email marker. The
// onboarding lifecycle tests clean up after themselves, but an interrupted
// run can leave onboarding_cases + their whole subtree behind — residue the
// CRS `@hireops-dev.local` class does NOT catch. Class 6 below sweeps both.
const ONB_TEST_EMAIL = "%@onb02.test";
// INT-02/03/04 test personas carry an `@example.com` email marker
// (priya.int02@…, anaya.int03@…, ravi.int04@… etc.). The interview lifecycle
// tests run against kyndryl-poc and clean up after themselves, but an
// interrupted run can leave interviews / plans / panelists / feedback behind —
// residue the CRS `@hireops-dev.local` and ONB `@onb02.test` classes do NOT
// catch. Classes 7 + 8 below sweep them. The seed's own persons all use
// `@example.test` (NOT `.com`), so this marker never matches a seeded row.
const INT_TEST_EMAIL = "%@example.com";
const SYNTH_SLUG = "%synth%";
// The whole seed-fixture id block — a5xx (demo), a6xx (partner), a7xx
// (candidate accounts), a8xx (offboarding). Broader than SEED_A5XX_PREFIX so
// the interview + candidate-account classes protect Priya's …a701 account and
// every other seeded id, not just the a5xx demo block.
const SEED_AXX_PREFIX = "00000000-0000-4000-8000-00000000a";

// postgres-js Sql instance type, derived from the client export.
type SqlTag = (typeof import("../client"))["sql"];
// Either the pool client OR a transaction client — both are tagged-template
// callables. The residue-case fragment builder accepts both so it can run in
// gather() (pool `sql`) and inside sql.begin (transaction `tx`).
type AnySql = SqlTag | postgres.TransactionSql<Record<string, never>>;

interface Row {
  klass: string;
  detail: string;
  count: number;
}

interface SynthTenant {
  id: string;
  slug: string;
  ai_usage_logs: number;
  api_audit_logs: number;
  pii_access_log: number;
  audit_logs: number;
  memberships: number;
  applications: number;
  requisitions: number;
}

function printInventory(title: string, rows: Row[]): void {
  const total = rows.reduce((s, r) => s + r.count, 0);
  console.log("");
  console.log(title);
  console.log("─".repeat(title.length));
  const klassW = Math.max(20, ...rows.map((r) => r.klass.length));
  const detailW = Math.max(34, ...rows.map((r) => r.detail.length));
  for (const r of rows) {
    console.log(
      `  ${r.klass.padEnd(klassW)}  ${r.detail.padEnd(detailW)}  ${String(r.count).padStart(5)}`,
    );
  }
  console.log(
    `  ${"TOTAL rows".padEnd(klassW)}  ${" ".padEnd(detailW)}  ${String(total).padStart(5)}`,
  );
}

async function scalar(query: Promise<{ n: number }[]>): Promise<number> {
  const [row] = await query;
  return row?.n ?? 0;
}

async function agentSubtreeCounts(sql: SqlTag): Promise<{
  triggers: number;
  actions: number;
  approvalRules: number;
  runs: number;
  runActions: number;
  runOutbox: number;
  approvalRequests: number;
}> {
  const agentSub = sql`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`;
  const runSub = sql`SELECT id FROM public.agent_runs WHERE agent_id IN (${sql`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`})`;
  const [row] = await sql<
    {
      triggers: number;
      actions: number;
      approval_rules: number;
      runs: number;
      run_actions: number;
      run_outbox: number;
      approval_requests: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM public.agent_triggers WHERE agent_id IN (${agentSub})) AS triggers,
      (SELECT count(*)::int FROM public.agent_actions WHERE agent_id IN (${sql`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`})) AS actions,
      (SELECT count(*)::int FROM public.agent_approval_rules WHERE agent_id IN (${sql`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`})) AS approval_rules,
      (SELECT count(*)::int FROM public.agent_runs WHERE agent_id IN (${sql`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`})) AS runs,
      (SELECT count(*)::int FROM public.agent_run_actions WHERE run_id IN (${runSub})) AS run_actions,
      (SELECT count(*)::int FROM public.agent_run_outbox WHERE agent_id IN (${sql`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`})) AS run_outbox,
      (SELECT count(*)::int FROM public.agent_approval_requests WHERE agent_id IN (${sql`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`})) AS approval_requests
  `;
  return {
    triggers: row?.triggers ?? 0,
    actions: row?.actions ?? 0,
    approvalRules: row?.approval_rules ?? 0,
    runs: row?.runs ?? 0,
    runActions: row?.run_actions ?? 0,
    runOutbox: row?.run_outbox ?? 0,
    approvalRequests: row?.approval_requests ?? 0,
  };
}

/**
 * The set of RESIDUE onboarding_cases in kyndryl-poc: cases whose backing
 * candidate/person carries a test-marker email (`@hireops-dev.local` from
 * CRS-01 e2e, `@onb02.test` from the ONBOARD-02 lifecycle tests), EXCLUDING
 * anything in the seed a5xx namespace. The seeded ONBOARD-04 demo cases use
 * `example.test` candidate emails + a5xx ids, so they never match — they are
 * protected twice over (email marker AND the NOT LIKE a5xx guard). Reused for
 * both the count (gather) and the child-first delete (tx), so counts and
 * deletes agree by construction.
 */
function onboardingResidueCaseSub(sql: AnySql, kid: string) {
  return sql`
    SELECT oc.id
    FROM public.onboarding_cases oc
    JOIN public.candidates c ON c.id = oc.candidate_id AND c.tenant_id = oc.tenant_id
    JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = oc.tenant_id
    WHERE oc.tenant_id = ${kid}
      AND (p.email_primary ILIKE ${DEV_LOCAL_EMAIL} OR p.email_primary ILIKE ${ONB_TEST_EMAIL})
      AND oc.id::text NOT LIKE ${SEED_A5XX_PREFIX + "%"}`;
}

/**
 * The set of RESIDUE interview-test APPLICATIONS in kyndryl-poc: applications
 * whose backing person carries the interview-test marker (`@example.com` — the
 * INT-02/03/04 personas), EXCLUDING anything in a seed aXX namespace. The seed
 * creates ZERO interview rows and all its persons use `@example.test`, so this
 * matches only interrupted-run interview residue. Reused for the count
 * (gather) and the child-first delete (tx) so they agree by construction.
 */
function interviewResidueAppSub(sql: AnySql, kid: string) {
  return sql`
    SELECT a.id
    FROM public.applications a
    JOIN public.candidates c ON c.id = a.candidate_id AND c.tenant_id = a.tenant_id
    JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = a.tenant_id
    WHERE a.tenant_id = ${kid}
      AND p.email_primary ILIKE ${INT_TEST_EMAIL}
      AND a.id::text NOT LIKE ${SEED_AXX_PREFIX + "%"}`;
}

/**
 * The requisitions those residue applications point at — the scope for stray
 * interview_plans (plans are per-requisition, not per-candidate). A residue
 * application only ever sits on a test requisition (the INT tests create their
 * own reqs), and seeds create no plans, so this only ever names test reqs.
 * The seed-namespace guard is belt-and-suspenders against a future seed.
 */
function interviewResidueReqSub(sql: AnySql, kid: string) {
  return sql`
    SELECT DISTINCT a.requisition_id
    FROM public.applications a
    JOIN public.candidates c ON c.id = a.candidate_id AND c.tenant_id = a.tenant_id
    JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = a.tenant_id
    WHERE a.tenant_id = ${kid}
      AND p.email_primary ILIKE ${INT_TEST_EMAIL}
      AND a.requisition_id::text NOT LIKE ${SEED_AXX_PREFIX + "%"}`;
}

/**
 * The set of RESIDUE candidate_accounts in kyndryl-poc: accounts whose backing
 * person carries ANY test marker (`@hireops-dev.local` / `@onb02.test` /
 * `@example.com`), EXCLUDING the seed aXX namespace. Priya's seeded account
 * (…a701, person …a505, `priya.subramanian@example.test`) is protected TWICE:
 * her email matches no marker (`example.test` ≠ any), and …a701 is in the aXX
 * namespace the guard excludes.
 */
function candidateAccountResidueSub(sql: AnySql, kid: string) {
  return sql`
    SELECT ca.id
    FROM public.candidate_accounts ca
    JOIN public.persons p ON p.id = ca.person_id AND p.tenant_id = ca.tenant_id
    WHERE ca.tenant_id = ${kid}
      AND (p.email_primary ILIKE ${DEV_LOCAL_EMAIL}
        OR p.email_primary ILIKE ${ONB_TEST_EMAIL}
        OR p.email_primary ILIKE ${INT_TEST_EMAIL})
      AND ca.id::text NOT LIKE ${SEED_AXX_PREFIX + "%"}`;
}

async function main(): Promise<void> {
  // Dynamic import so dotenv (above) runs before client.ts reads
  // DATABASE_URL at module init — same pattern as seed-demo-data.ts.
  const { sql } = await import("../client");

  try {
    // ── resolve + guard the kyndryl-poc tenant ──────────────────────
    const [kyndryl] = await sql<{ id: string }[]>`
      SELECT id::text AS id FROM public.tenants WHERE slug = ${KYNDRYL_SLUG} LIMIT 1
    `;
    if (!kyndryl) {
      console.error(`FATAL: tenant '${KYNDRYL_SLUG}' not found — refusing to run.`);
      process.exit(2);
    }
    const kid = kyndryl.id;

    // ── verify the protected seed agent is present + untouched ──────
    const [demoAgent] = await sql<{ id: string; retired: boolean }[]>`
      SELECT id::text AS id, retired_at IS NOT NULL AS retired
      FROM public.automation_agents WHERE id = ${DEMO_AGENT_ID} LIMIT 1
    `;
    if (!demoAgent) {
      console.error(
        `FATAL: protected '${DEMO_AGENT_NAME}' (${DEMO_AGENT_ID}) not found — refusing to run.`,
      );
      process.exit(2);
    }

    console.log(`Grooming demo residue. kyndryl-poc = ${kid}`);
    console.log(
      `Mode: ${EXECUTE ? "EXECUTE (deletions WILL be performed)" : "DRY RUN (no changes)"}`,
    );

    // ── gather inventory (re-runnable; used for before + after) ─────
    async function gather(): Promise<{ rows: Row[]; synth: SynthTenant[] }> {
      // 1. CRS-01 / dev.local personas in kyndryl-poc.
      const crsPersons = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.persons
        WHERE tenant_id = ${kid} AND email_primary ILIKE ${DEV_LOCAL_EMAIL}
      `);
      const crsCands = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.candidates c
        JOIN public.persons p ON p.id = c.person_id
        WHERE p.tenant_id = ${kid} AND p.email_primary ILIKE ${DEV_LOCAL_EMAIL}
      `);
      const crsApps = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.applications a
        JOIN public.candidates c ON c.id = a.candidate_id
        JOIN public.persons p ON p.id = c.person_id
        WHERE p.tenant_id = ${kid} AND p.email_primary ILIKE ${DEV_LOCAL_EMAIL}
      `);
      const crsTransitions = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.application_state_transitions ast
        WHERE ast.application_id IN (
          SELECT a.id FROM public.applications a
          JOIN public.candidates c ON c.id = a.candidate_id
          JOIN public.persons p ON p.id = c.person_id
          WHERE p.tenant_id = ${kid} AND p.email_primary ILIKE ${DEV_LOCAL_EMAIL})
      `);
      const crsOutbox = await scalar(sql<{ n: number }[]>`
        SELECT (
          (SELECT count(*) FROM public.ai_score_outbox WHERE application_id IN (
            SELECT a.id FROM public.applications a
            JOIN public.candidates c ON c.id = a.candidate_id
            JOIN public.persons p ON p.id = c.person_id
            WHERE p.tenant_id = ${kid} AND p.email_primary ILIKE ${DEV_LOCAL_EMAIL}))
        + (SELECT count(*) FROM public.workday_sync_outbox WHERE subject_application_id IN (
            SELECT a.id FROM public.applications a
            JOIN public.candidates c ON c.id = a.candidate_id
            JOIN public.persons p ON p.id = c.person_id
            WHERE p.tenant_id = ${kid} AND p.email_primary ILIKE ${DEV_LOCAL_EMAIL}))
        + (SELECT count(*) FROM public.notification_outbox WHERE recipient_candidate_id IN (
            SELECT c.id FROM public.candidates c
            JOIN public.persons p ON p.id = c.person_id
            WHERE p.tenant_id = ${kid} AND p.email_primary ILIKE ${DEV_LOCAL_EMAIL}))
        )::int AS n
      `);

      // 2. AD03 cost fixtures (all tenants).
      const ad03 = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.ai_usage_logs
        WHERE request_id LIKE 'AD03-%' OR provider = 'ad03-test'
      `);

      // 3. leaked robust-01 agent subtree.
      const leakedAgents = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}
      `);
      const subtree = await agentSubtreeCounts(sql);

      // 4. synth test tenants.
      const synth = await sql<SynthTenant[]>`
        SELECT t.id::text AS id, t.slug,
          (SELECT count(*)::int FROM public.ai_usage_logs u WHERE u.tenant_id = t.id) AS ai_usage_logs,
          (SELECT count(*)::int FROM public.api_audit_logs a WHERE a.tenant_id = t.id) AS api_audit_logs,
          (SELECT count(*)::int FROM public.pii_access_log a WHERE a.tenant_id = t.id) AS pii_access_log,
          (SELECT count(*)::int FROM public.audit_logs a WHERE a.tenant_id = t.id) AS audit_logs,
          (SELECT count(*)::int FROM public.tenant_user_memberships m WHERE m.tenant_id = t.id) AS memberships,
          (SELECT count(*)::int FROM public.applications ap WHERE ap.tenant_id = t.id) AS applications,
          (SELECT count(*)::int FROM public.requisitions rq WHERE rq.tenant_id = t.id) AS requisitions
        FROM public.tenants t
        WHERE t.slug ILIKE ${SYNTH_SLUG} AND t.slug <> ${KYNDRYL_SLUG}
        ORDER BY t.slug
      `;
      const synthTenants = synth.length;
      const synthUsage = synth.reduce((s, t) => s + t.ai_usage_logs, 0);

      // 5. stray agent_run_outbox (agent missing or retired).
      const strayOutbox = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.agent_run_outbox o
        LEFT JOIN public.automation_agents aa ON aa.id = o.agent_id
        WHERE aa.id IS NULL OR aa.retired_at IS NOT NULL
      `);

      // 6. onboarding residue — cases (+ tasks / documents / bgv / IT /
      //    assets) tied to test-marker personas, never the seeded a5xx cases.
      const onbSub = onboardingResidueCaseSub(sql, kid);
      const onbCases = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.onboarding_cases WHERE id IN (${onbSub})
      `);
      const onbTasks = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.onboarding_tasks
        WHERE case_id IN (${onboardingResidueCaseSub(sql, kid)})
      `);
      const onbDocs = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.onboarding_documents
        WHERE case_id IN (${onboardingResidueCaseSub(sql, kid)})
      `);
      const onbBgvRuns = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.bgv_runs
        WHERE case_id IN (${onboardingResidueCaseSub(sql, kid)})
      `);
      const onbBgvResults = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.bgv_results
        WHERE bgv_run_id IN (
          SELECT id FROM public.bgv_runs WHERE case_id IN (${onboardingResidueCaseSub(sql, kid)})
        )
      `);
      const onbIt = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.it_provisioning_requests
        WHERE case_id IN (${onboardingResidueCaseSub(sql, kid)})
      `);
      const onbAssets = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.asset_assignments
        WHERE case_id IN (${onboardingResidueCaseSub(sql, kid)})
      `);

      // 7. interview residue — plans / interviews / panelists / feedback tied
      //    to INT-02/03/04 test personas (@example.com), never seeded rows.
      const ivInterviews = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.interviews
        WHERE application_id IN (${interviewResidueAppSub(sql, kid)})
      `);
      const ivPanelists = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.interview_panelists
        WHERE interview_id IN (
          SELECT id FROM public.interviews WHERE application_id IN (${interviewResidueAppSub(sql, kid)})
        )
      `);
      const ivFeedback = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.interview_feedback
        WHERE interview_id IN (
          SELECT id FROM public.interviews WHERE application_id IN (${interviewResidueAppSub(sql, kid)})
        )
      `);
      const ivPlans = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.interview_plans
        WHERE tenant_id = ${kid}
          AND requisition_id IN (${interviewResidueReqSub(sql, kid)})
          AND id::text NOT LIKE ${SEED_AXX_PREFIX + "%"}
      `);

      // 8. candidate_accounts residue — accounts tied to a test-marker person,
      //    never the seeded a7xx (Priya) account.
      const candAccounts = await scalar(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.candidate_accounts
        WHERE id IN (${candidateAccountResidueSub(sql, kid)})
      `);

      const rows: Row[] = [
        { klass: "1. CRS-01 dev.local", detail: "persons (kyndryl-poc)", count: crsPersons },
        { klass: "1. CRS-01 dev.local", detail: "candidates", count: crsCands },
        { klass: "1. CRS-01 dev.local", detail: "applications", count: crsApps },
        { klass: "1. CRS-01 dev.local", detail: "state_transitions", count: crsTransitions },
        {
          klass: "1. CRS-01 dev.local",
          detail: "outbox rows (score/notif/workday)",
          count: crsOutbox,
        },
        { klass: "2. AD03 fixtures", detail: "ai_usage_logs (AD03-%/ad03-test)", count: ad03 },
        { klass: "3. robust-01 agent", detail: "automation_agents", count: leakedAgents },
        { klass: "3. robust-01 agent", detail: "agent_triggers", count: subtree.triggers },
        { klass: "3. robust-01 agent", detail: "agent_actions", count: subtree.actions },
        {
          klass: "3. robust-01 agent",
          detail: "agent_approval_rules",
          count: subtree.approvalRules,
        },
        { klass: "3. robust-01 agent", detail: "agent_runs", count: subtree.runs },
        { klass: "3. robust-01 agent", detail: "agent_run_actions", count: subtree.runActions },
        { klass: "3. robust-01 agent", detail: "agent_run_outbox", count: subtree.runOutbox },
        {
          klass: "3. robust-01 agent",
          detail: "agent_approval_requests",
          count: subtree.approvalRequests,
        },
        { klass: "4. synth tenants", detail: "tenants (slug ILIKE %synth%)", count: synthTenants },
        { klass: "4. synth tenants", detail: "their ai_usage_logs (orphans)", count: synthUsage },
        {
          klass: "5. stray outbox",
          detail: "agent_run_outbox (missing/retired agent)",
          count: strayOutbox,
        },
        {
          klass: "6. onboarding residue",
          detail: "onboarding_cases (test personas)",
          count: onbCases,
        },
        { klass: "6. onboarding residue", detail: "onboarding_tasks", count: onbTasks },
        { klass: "6. onboarding residue", detail: "onboarding_documents", count: onbDocs },
        { klass: "6. onboarding residue", detail: "bgv_runs", count: onbBgvRuns },
        { klass: "6. onboarding residue", detail: "bgv_results", count: onbBgvResults },
        { klass: "6. onboarding residue", detail: "it_provisioning_requests", count: onbIt },
        { klass: "6. onboarding residue", detail: "asset_assignments", count: onbAssets },
        { klass: "7. interview residue", detail: "interview_plans (test reqs)", count: ivPlans },
        {
          klass: "7. interview residue",
          detail: "interviews (test personas)",
          count: ivInterviews,
        },
        { klass: "7. interview residue", detail: "interview_panelists", count: ivPanelists },
        { klass: "7. interview residue", detail: "interview_feedback", count: ivFeedback },
        {
          klass: "8. candidate_accounts",
          detail: "candidate_accounts (test personas)",
          count: candAccounts,
        },
      ];
      return { rows, synth };
    }

    const before = await gather();
    printInventory(
      EXECUTE ? "BEFORE — residue inventory" : "DRY RUN — residue inventory",
      before.rows,
    );

    // Per-synth-tenant disposition report.
    if (before.synth.length > 0) {
      console.log("");
      console.log("Synth-tenant disposition:");
      for (const t of before.synth) {
        const protectedRows = t.api_audit_logs + t.pii_access_log;
        const disposition =
          protectedRows > 0
            ? `PRESERVE tenant (has ${t.api_audit_logs} api_audit + ${t.pii_access_log} pii append-only rows); remove ${t.ai_usage_logs} ai_usage_logs only`
            : `DELETE tenant (cascade); ${t.audit_logs} audit_logs left as acceptable orphan history`;
        console.log(
          `  ${t.slug.padEnd(20)} usage=${t.ai_usage_logs} audit=${t.audit_logs} api_audit=${t.api_audit_logs} pii=${t.pii_access_log} memb=${t.memberships} apps=${t.applications} reqs=${t.requisitions}`,
        );
        console.log(`  ${" ".repeat(20)} → ${disposition}`);
      }
    }

    if (!EXECUTE) {
      console.log("");
      console.log("DRY RUN complete — nothing deleted. Re-run with --execute to perform deletion.");
      return;
    }

    // ── PRE-FLIGHT GUARDS (loud refusal) ────────────────────────────
    // Assert no target row lives in the seed a5xx namespace, and that
    // neither the kyndryl-poc tenant nor the …a590 agent is in a delete
    // set. Any violation aborts BEFORE the transaction.
    const a5xxHits = await scalar(sql<{ n: number }[]>`
      SELECT (
          (SELECT count(*) FROM public.persons WHERE tenant_id = ${kid}
             AND email_primary ILIKE ${DEV_LOCAL_EMAIL}
             AND id::text LIKE ${SEED_A5XX_PREFIX + "%"})
        + (SELECT count(*) FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}
             AND id::text LIKE ${SEED_A5XX_PREFIX + "%"})
        + (SELECT count(*) FROM public.ai_usage_logs
             WHERE (request_id LIKE 'AD03-%' OR provider = 'ad03-test')
             AND id::text LIKE ${SEED_A5XX_PREFIX + "%"})
      )::int AS n
    `);
    if (a5xxHits > 0) {
      console.error(
        `FATAL: ${a5xxHits} target row(s) fall in the protected seed a5xx namespace — refusing to delete.`,
      );
      process.exit(3);
    }

    // The onboarding residue subquery already excludes a5xx case ids, but a
    // seeded demo case carrying a test-marker email would be a seed bug we
    // must NOT silently skip — refuse loudly so it gets fixed.
    const onbA5xxHits = await scalar(sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.onboarding_cases oc
      JOIN public.candidates c ON c.id = oc.candidate_id AND c.tenant_id = oc.tenant_id
      JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = oc.tenant_id
      WHERE oc.tenant_id = ${kid}
        AND (p.email_primary ILIKE ${DEV_LOCAL_EMAIL} OR p.email_primary ILIKE ${ONB_TEST_EMAIL})
        AND oc.id::text LIKE ${SEED_A5XX_PREFIX + "%"}
    `);
    if (onbA5xxHits > 0) {
      console.error(
        `FATAL: ${onbA5xxHits} seed a5xx onboarding case(s) carry a test-marker email — refusing (seed bug).`,
      );
      process.exit(3);
    }

    // The leaked-agent set must never include the protected …a590 agent.
    const a590InSet = await scalar(sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.automation_agents
      WHERE name = ${LEAKED_AGENT_NAME} AND id = ${DEMO_AGENT_ID}
    `);
    if (a590InSet > 0) {
      console.error(
        `FATAL: the Demo Follow-ups Agent (${DEMO_AGENT_ID}) is in a delete set — refusing.`,
      );
      process.exit(3);
    }

    // The synth-tenant delete set must never include the kyndryl-poc id.
    const kidInSynth = await scalar(sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.tenants
      WHERE id = ${kid} AND slug ILIKE ${SYNTH_SLUG} AND slug <> ${KYNDRYL_SLUG}
    `);
    if (kidInSynth > 0) {
      console.error(`FATAL: kyndryl-poc tenant matched the synth delete set — refusing.`);
      process.exit(3);
    }

    // A seeded candidate_account carrying a test-marker email would be a seed
    // bug the residue subquery would silently skip (it excludes aXX ids) —
    // refuse loudly instead so it gets fixed. Protects Priya's …a701.
    const caSeedHits = await scalar(sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.candidate_accounts ca
      JOIN public.persons p ON p.id = ca.person_id AND p.tenant_id = ca.tenant_id
      WHERE ca.tenant_id = ${kid}
        AND (p.email_primary ILIKE ${DEV_LOCAL_EMAIL}
          OR p.email_primary ILIKE ${ONB_TEST_EMAIL}
          OR p.email_primary ILIKE ${INT_TEST_EMAIL})
        AND ca.id::text LIKE ${SEED_AXX_PREFIX + "%"}
    `);
    if (caSeedHits > 0) {
      console.error(
        `FATAL: ${caSeedHits} seed aXX candidate_account(s) carry a test-marker email — refusing (seed bug).`,
      );
      process.exit(3);
    }

    // Likewise, a seeded interview_plan on a residue test requisition would be
    // a seed bug (the delete excludes aXX plan ids) — refuse rather than mask.
    const ivPlanSeedHits = await scalar(sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.interview_plans ip
      WHERE ip.tenant_id = ${kid}
        AND ip.requisition_id IN (${interviewResidueReqSub(sql, kid)})
        AND ip.id::text LIKE ${SEED_AXX_PREFIX + "%"}
    `);
    if (ivPlanSeedHits > 0) {
      console.error(
        `FATAL: ${ivPlanSeedHits} seed aXX interview_plan(s) on a residue requisition — refusing (seed bug).`,
      );
      process.exit(3);
    }

    // ── DELETIONS (single transaction, FK-safe order) ───────────────
    await sql.begin(async (tx) => {
      // Re-derive id sets inside the tx for consistency. These fragments
      // resolve against live rows until the parent rows are deleted, so
      // the delete order below (children → parents) keeps them valid.
      const appSub = tx`
        SELECT a.id FROM public.applications a
        JOIN public.candidates c ON c.id = a.candidate_id
        JOIN public.persons p ON p.id = c.person_id
        WHERE p.tenant_id = ${kid} AND p.email_primary ILIKE ${DEV_LOCAL_EMAIL}`;
      const candSub = tx`
        SELECT c.id FROM public.candidates c
        JOIN public.persons p ON p.id = c.person_id
        WHERE p.tenant_id = ${kid} AND p.email_primary ILIKE ${DEV_LOCAL_EMAIL}`;
      const personSub = tx`
        SELECT id FROM public.persons
        WHERE tenant_id = ${kid} AND email_primary ILIKE ${DEV_LOCAL_EMAIL}`;

      // 0. onboarding residue — EXPLICIT child-first teardown of the whole
      // subtree, run FIRST so dev.local onboarding rows are removed here
      // (and counted as class 6), NOT swept implicitly by the class-1
      // application cascade below; it also catches @onb02.test cases that
      // have no matching class-1 application. Order: bgv_results → bgv_runs,
      // asset_assignments, it_provisioning_requests, onboarding_documents,
      // onboarding_tasks, then onboarding_cases LAST. The residue subquery is
      // re-derived each step and stays valid until the cases are deleted.
      // Every statement excludes a5xx by construction (onboardingResidueCaseSub).
      await tx`
        DELETE FROM public.bgv_results
        WHERE bgv_run_id IN (
          SELECT id FROM public.bgv_runs WHERE case_id IN (${onboardingResidueCaseSub(tx, kid)})
        )`;
      await tx`DELETE FROM public.bgv_runs WHERE case_id IN (${onboardingResidueCaseSub(tx, kid)})`;
      await tx`DELETE FROM public.asset_assignments WHERE case_id IN (${onboardingResidueCaseSub(tx, kid)})`;
      await tx`DELETE FROM public.it_provisioning_requests WHERE case_id IN (${onboardingResidueCaseSub(tx, kid)})`;
      await tx`DELETE FROM public.onboarding_documents WHERE case_id IN (${onboardingResidueCaseSub(tx, kid)})`;
      await tx`DELETE FROM public.onboarding_tasks WHERE case_id IN (${onboardingResidueCaseSub(tx, kid)})`;
      await tx`DELETE FROM public.onboarding_cases WHERE id IN (${onboardingResidueCaseSub(tx, kid)})`;

      // 7. interview residue — child-first: feedback + panelists (both FK the
      // interview ON DELETE cascade) BEFORE the interviews, then the per-req
      // plans. Scoped to @example.com INT-test personas; interviews the seed
      // never creates. The residue subqueries re-derive each step and stay
      // valid until the interviews are deleted (this class does NOT delete the
      // backing applications, so the app-scoped subquery holds throughout).
      await tx`
        DELETE FROM public.interview_feedback
        WHERE interview_id IN (
          SELECT id FROM public.interviews WHERE application_id IN (${interviewResidueAppSub(tx, kid)})
        )`;
      await tx`
        DELETE FROM public.interview_panelists
        WHERE interview_id IN (
          SELECT id FROM public.interviews WHERE application_id IN (${interviewResidueAppSub(tx, kid)})
        )`;
      await tx`DELETE FROM public.interviews WHERE application_id IN (${interviewResidueAppSub(tx, kid)})`;
      await tx`
        DELETE FROM public.interview_plans
        WHERE tenant_id = ${kid}
          AND requisition_id IN (${interviewResidueReqSub(tx, kid)})
          AND id::text NOT LIKE ${SEED_AXX_PREFIX + "%"}`;

      // 8. candidate_accounts residue — run BEFORE the class-1 person delete so
      // this class explicitly owns them (deleting the person would otherwise
      // cascade them away). Priya's …a701 is excluded by marker AND namespace.
      await tx`DELETE FROM public.candidate_accounts WHERE id IN (${candidateAccountResidueSub(tx, kid)})`;

      // 1. CRS-01 — child-first. dev_email_outbox references
      // notification_outbox (SET NULL); delete the mirror rows first so
      // no dangling inspection rows remain, then the notif rows.
      await tx`
        DELETE FROM public.dev_email_outbox
        WHERE outbox_id IN (SELECT id FROM public.notification_outbox WHERE recipient_candidate_id IN (${candSub}))
           OR recipient_email ILIKE ${DEV_LOCAL_EMAIL}`;
      await tx`DELETE FROM public.notification_outbox WHERE recipient_candidate_id IN (${candSub})`;
      await tx`DELETE FROM public.application_state_transitions WHERE application_id IN (${appSub})`;
      await tx`DELETE FROM public.workday_sync_outbox WHERE subject_application_id IN (${appSub})`;
      await tx`DELETE FROM public.ai_score_outbox WHERE application_id IN (${appSub})`;
      await tx`DELETE FROM public.candidate_inbound_messages WHERE application_id IN (${appSub})`;
      await tx`DELETE FROM public.partner_candidate_messages WHERE candidate_id IN (${candSub}) OR application_id IN (${appSub})`;
      await tx`DELETE FROM public.candidate_ownership_claims WHERE claimed_via_application_id IN (${appSub}) OR person_id IN (${personSub})`;
      await tx`DELETE FROM public.candidate_dedup_attempts WHERE matched_person_id IN (${personSub})`;
      await tx`DELETE FROM public.offers WHERE application_id IN (${appSub})`;
      await tx`DELETE FROM public.applications WHERE id IN (${appSub})`;
      await tx`DELETE FROM public.candidates WHERE id IN (${candSub})`;
      await tx`DELETE FROM public.persons WHERE tenant_id = ${kid} AND email_primary ILIKE ${DEV_LOCAL_EMAIL}`;

      // 2. AD03 cost fixtures (all tenants).
      await tx`DELETE FROM public.ai_usage_logs WHERE request_id LIKE 'AD03-%' OR provider = 'ad03-test'`;

      // 3. leaked robust-01 agent subtree — child-first (agent_run_actions
      // → agent_actions is ON DELETE RESTRICT, so run_actions before
      // actions). Mirrors seed-demo-data's proven teardown order.
      const agentSub = tx`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`;
      const agentSub2 = tx`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`;
      await tx`DELETE FROM public.agent_approval_requests WHERE agent_id IN (${agentSub})`;
      await tx`DELETE FROM public.agent_run_actions WHERE run_id IN (SELECT id FROM public.agent_runs WHERE agent_id IN (${agentSub2}))`;
      await tx`DELETE FROM public.agent_runs WHERE agent_id IN (${tx`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`})`;
      await tx`DELETE FROM public.agent_run_outbox WHERE agent_id IN (${tx`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`})`;
      await tx`DELETE FROM public.agent_approval_rules WHERE agent_id IN (${tx`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`})`;
      await tx`DELETE FROM public.agent_actions WHERE agent_id IN (${tx`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`})`;
      await tx`DELETE FROM public.agent_triggers WHERE agent_id IN (${tx`SELECT id FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`})`;
      await tx`DELETE FROM public.automation_agents WHERE name = ${LEAKED_AGENT_NAME}`;

      // 4. synth test tenants. Per-tenant: delete whole tenant (cascade)
      // when FK-safe (no append-only api_audit/pii rows), else remove only
      // the orphan ai_usage_logs and preserve the tenant.
      const synthNow = await tx<
        { id: string; slug: string; api_audit_logs: number; pii_access_log: number }[]
      >`
        SELECT t.id::text AS id, t.slug,
          (SELECT count(*)::int FROM public.api_audit_logs a WHERE a.tenant_id = t.id) AS api_audit_logs,
          (SELECT count(*)::int FROM public.pii_access_log a WHERE a.tenant_id = t.id) AS pii_access_log
        FROM public.tenants t
        WHERE t.slug ILIKE ${SYNTH_SLUG} AND t.slug <> ${KYNDRYL_SLUG}`;
      for (const t of synthNow) {
        // defence-in-depth: never touch kyndryl, never a5xx tenant id.
        if (t.id === kid || t.id.startsWith(SEED_A5XX_PREFIX)) continue;
        if (t.api_audit_logs + t.pii_access_log > 0) {
          await tx`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${t.id}`;
        } else {
          await tx`DELETE FROM public.tenants WHERE id = ${t.id} AND slug ILIKE ${SYNTH_SLUG} AND slug <> ${KYNDRYL_SLUG}`;
        }
      }

      // 5. stray agent_run_outbox rows (agent missing or retired). Runs
      // AFTER the robust-01 subtree so it only catches genuinely orphaned
      // rows. awaiting_approval rows off live agents are left untouched.
      await tx`
        DELETE FROM public.agent_run_outbox o
        USING (
          SELECT o2.id FROM public.agent_run_outbox o2
          LEFT JOIN public.automation_agents aa ON aa.id = o2.agent_id
          WHERE aa.id IS NULL OR aa.retired_at IS NOT NULL
        ) stray
        WHERE o.id = stray.id`;
    });

    // ── after inventory (idempotency proof surface) ─────────────────
    const after = await gather();
    printInventory("AFTER — residue inventory (expect zeros)", after.rows);

    // ── post-condition sanity: protected rows intact ────────────────
    const [demoAfter] = await sql<{ id: string; retired: boolean }[]>`
      SELECT id::text AS id, retired_at IS NOT NULL AS retired
      FROM public.automation_agents WHERE id = ${DEMO_AGENT_ID} LIMIT 1`;
    const [kynAfter] = await sql<{ slug: string }[]>`
      SELECT slug FROM public.tenants WHERE id = ${kid} LIMIT 1`;
    console.log("");
    console.log("Post-condition checks:");
    console.log(
      `  kyndryl-poc tenant intact:           ${kynAfter?.slug === KYNDRYL_SLUG ? "YES" : "NO — ALARM"}`,
    );
    console.log(
      `  Demo Follow-ups Agent (a590) intact: ${demoAfter && !demoAfter.retired ? "YES (active)" : "NO — ALARM"}`,
    );
    const residueLeft = after.rows.reduce((s, r) => s + r.count, 0);
    console.log("");
    console.log(
      residueLeft === 0
        ? "Groom complete — zero residue remaining."
        : `Groom complete — ${residueLeft} row(s) still reported (see AFTER table).`,
    );
  } finally {
    await sql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
