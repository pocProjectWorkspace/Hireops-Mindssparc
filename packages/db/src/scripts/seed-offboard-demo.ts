/**
 * OFFBOARD-03 demo seed — makes /offboarding look ALIVE on a fresh DB with two
 * departure cases against demo persons who were genuinely hired (they carry an
 * onboarding case from the ONBOARD-04 a5xx set — the honest "was employed"
 * signal HireOps has, since there is no employees table):
 *
 *   1. MID-FLIGHT — Divya Krishnan (…a544, in_progress onboarding …a564):
 *      resignation, status notice_period, KT done, one asset returned (the
 *      other still out), exit interview SCHEDULED but not submitted, settlement
 *      calculated-not-approved (the access-revocation gate visibly blocks
 *      approval). The screen shows the clearance work in motion.
 *   2. COMPLETED — Ananya Gupta (…a546, completed onboarding …a566):
 *      resignation walked all the way — every task resolved, all assets
 *      returned, exit interview submitted (frozen), settlement PAID, and the
 *      Workday terminate event pre-stamped into a 'simulated' terminal outbox
 *      row (mirrors ONBOARD-04's pre-stamped Worker IDs and the sim drain's
 *      terminal state — Integration Health shows a completed Termination).
 *
 * Deliberately NOT touched: Rohan / Meera (agent Act-2 fixtures) and Priya
 * (Person E, the offer-accept demo) — this seed only anchors on the two
 * onboarding-demo persons above.
 *
 * Run:
 *   pnpm db:seed:offboard-demo
 *
 * Requires: DATABASE_URL in .env. Run AFTER db:seed:demo-data (needs the
 * ONBOARD-04 a5xx onboarding cases + their candidates/applications).
 *
 * FIVE-seed runbook order (each idempotent; run in this order on a fresh DB):
 *   1. db:seed:test-users      (auth users + memberships)
 *   2. db:seed:demo-data       (recruitment + onboarding a5xx fixtures)
 *   3. db:seed:partner-demo    (partner org + login, a6xx)
 *   4. db:seed:candidate-demo  (Priya's candidate login, a7xx)
 *   5. db:seed:offboard-demo   (the two departure cases, a8xx)   ← this seed
 *
 * Idempotent x2: deterministic case ids (…a801 / …a802) are deleted (cascading
 * their tasks / asset_returns / exit_interviews / final_settlements) and the
 * terminate outbox row is deleted by business_key, then everything is
 * re-inserted — a second run is a clean no-op net of timestamps.
 *
 * Groom-safe by construction: every row anchors on a5xx demo persons with
 * `example.test` emails (doubly protected — a5xx namespace AND non-marker
 * email), the offboarding tables are in NO groom residue class, and the
 * terminate outbox row hangs off an a5xx application (not a dev.local one).
 * Verify with `pnpm db:groom:demo-data` (dry run): zero new classification.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";
const HR_OPS_EMAIL = "hr_ops1@kyndryl-poc.test";
const ADMIN_EMAIL = "admin1@kyndryl-poc.test";

// Terminate event type + business-key prefix (mirrors apps/api offboarding-case
// lib — duplicated here because the seed can't import from apps/api).
const TERMINATE_EVENT_TYPE = "terminate_employee";
const terminateBusinessKey = (caseId: string) => `terminate:case:${caseId}`;

// The ONBOARD-04 demo persons this seed offboards (from seed-demo-data.ts).
const CAND_MID = "00000000-0000-4000-8000-00000000a544"; // Divya Krishnan
const APP_MID = "00000000-0000-4000-8000-00000000a554";
const ONB_CASE_MID = "00000000-0000-4000-8000-00000000a564";
const CAND_DONE = "00000000-0000-4000-8000-00000000a546"; // Ananya Gupta
const APP_DONE = "00000000-0000-4000-8000-00000000a556";
const ONB_CASE_DONE = "00000000-0000-4000-8000-00000000a566";

// Deterministic offboarding-case ids — a8xx namespace (demo owns a5xx, partner
// a6xx, candidate a7xx).
const OFFB_CASE_MID = "00000000-0000-4000-8000-00000000a801";
const OFFB_CASE_DONE = "00000000-0000-4000-8000-00000000a802";

/** The 7-task clearance checklist (task_type → title, owner) — mirrors the
 *  OFFBOARD-01/02 generator in apps/api/src/lib/offboarding-case.ts. */
const CHECKLIST: { type: string; title: string; owner: "manager" | "initiator" }[] = [
  { type: "knowledge_transfer", title: "Knowledge transfer & handover", owner: "manager" },
  {
    type: "asset_return",
    title: "Return company assets (laptop, peripherals, ID card)",
    owner: "initiator",
  },
  { type: "access_revocation", title: "Revoke system & building access", owner: "initiator" },
  { type: "final_settlement", title: "Full & final settlement", owner: "initiator" },
  { type: "exit_interview", title: "Conduct exit interview", owner: "initiator" },
  { type: "manager_signoff", title: "Manager sign-off", owner: "manager" },
  { type: "hr_clearance", title: "HR clearance", owner: "initiator" },
];

/** YYYY-MM-DD for now + offsetDays. */
function dateStr(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
/** ISO timestamp for now + offsetDays. */
function iso(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
}

async function main(): Promise<void> {
  const { sql: poolSql } = await import("../client");

  try {
    const [tenant] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!tenant) {
      console.error(`tenant ${TENANT_SLUG} not found; run db:migrate first.`);
      process.exit(2);
    }
    const tid = tenant.id;
    console.log(`Seeding offboarding demo into tenant ${TENANT_SLUG} (${tid})`);

    // ── resolve HR / manager memberships ────────────────────────────
    const membershipFor = async (email: string): Promise<string> => {
      const [m] = await poolSql<{ id: string }[]>`
        SELECT tum.id FROM public.tenant_user_memberships tum
        JOIN auth.users au ON au.id = tum.user_id
        WHERE tum.tenant_id = ${tid} AND au.email = ${email} LIMIT 1
      `;
      if (!m) {
        console.error(`membership for ${email} not found. Run pnpm db:seed:test-users first.`);
        process.exit(2);
      }
      return m.id;
    };
    const hrOps = await membershipFor(HR_OPS_EMAIL);
    const manager = await membershipFor(ADMIN_EMAIL);

    // ── verify the ONBOARD-04 demo persons exist ────────────────────
    for (const [label, cid] of [
      ["Divya Krishnan (…a544)", CAND_MID],
      ["Ananya Gupta (…a546)", CAND_DONE],
    ] as const) {
      const [c] = await poolSql<{ id: string }[]>`
        SELECT id FROM public.candidates WHERE id = ${cid} AND tenant_id = ${tid} LIMIT 1
      `;
      if (!c) {
        console.error(
          `Demo candidate ${label} not found. Run pnpm db:seed:demo-data before this seed.`,
        );
        process.exit(2);
      }
    }

    // ── idempotent teardown: delete both cases (cascades tasks / assets /
    //    exit interviews / settlements) + the terminate outbox row ────
    for (const caseId of [OFFB_CASE_MID, OFFB_CASE_DONE]) {
      await poolSql`
        DELETE FROM public.workday_sync_outbox
        WHERE tenant_id = ${tid} AND business_key = ${terminateBusinessKey(caseId)}
      `;
      await poolSql`
        DELETE FROM public.offboarding_cases WHERE id = ${caseId} AND tenant_id = ${tid}
      `;
    }

    // ── helper: insert the 7-task checklist with per-type status ─────
    async function insertChecklist(
      caseId: string,
      statusByType: Record<string, string>,
    ): Promise<void> {
      for (const t of CHECKLIST) {
        const assignee = t.owner === "manager" ? manager : hrOps;
        const status = statusByType[t.type] ?? "pending";
        const completedAt = status === "completed" ? iso(-1) : null;
        await poolSql`
          INSERT INTO public.offboarding_tasks
            (tenant_id, case_id, task_type, status, title, assignee_membership_id, completed_at)
          VALUES (${tid}, ${caseId}, ${t.type}, ${status}, ${t.title}, ${assignee}, ${completedAt}::timestamptz)
        `;
      }
    }

    // ════════════════ 1. MID-FLIGHT case (Divya) ════════════════════
    await poolSql`
      INSERT INTO public.offboarding_cases
        (id, tenant_id, candidate_id, application_id, onboarding_case_id, initiation_type,
         status, notice_start_date, last_working_day, reason,
         initiated_by_membership_id, manager_membership_id, created_at, updated_at)
      VALUES (${OFFB_CASE_MID}, ${tid}, ${CAND_MID}, ${APP_MID}, ${ONB_CASE_MID}, 'resignation',
              'notice_period', ${dateStr(-10)}::date, ${dateStr(50)}::date,
              'Relocating to Pune — accepted a role closer to family.',
              ${hrOps}, ${manager}, ${iso(-10)}::timestamptz, now())
    `;
    await insertChecklist(OFFB_CASE_MID, {
      knowledge_transfer: "completed",
      asset_return: "in_progress",
      // access_revocation / final_settlement / exit_interview / manager_signoff /
      // hr_clearance stay pending.
    });
    // One asset returned, one still out → asset_return task stays open (honest).
    await poolSql`
      INSERT INTO public.asset_returns (tenant_id, case_id, asset_type, asset_tag, status, returned_at, received_by_membership_id, notes)
      VALUES
        (${tid}, ${OFFB_CASE_MID}, 'Laptop (MacBook Pro 14")', 'KYN-LT-4821', 'returned', ${iso(-2)}::timestamptz, ${hrOps}, 'Returned to IT, wiped.'),
        (${tid}, ${OFFB_CASE_MID}, 'Access ID card', 'KYN-ID-2290', 'pending', NULL, NULL, 'Employee to hand over on last working day.')
    `;
    // Exit interview scheduled (near LWD) but NOT submitted — a mutable draft.
    await poolSql`
      INSERT INTO public.exit_interviews (tenant_id, case_id, scheduled_at, conducted_by_membership_id, structured_responses, free_text, submitted_at)
      VALUES (${tid}, ${OFFB_CASE_MID}, ${iso(45)}::timestamptz, ${hrOps}, '{}'::jsonb, NULL, NULL)
    `;
    // Settlement calculated but not approved — the access-revocation gate blocks
    // approval on screen (honest disabled-state affordance).
    await poolSql`
      INSERT INTO public.final_settlements (tenant_id, case_id, status, amount_minor, currency, breakdown)
      VALUES (${tid}, ${OFFB_CASE_MID}, 'calculated', ${245000 * 100}, 'INR',
              ${JSON.stringify({
                leave_encashment: 68000 * 100,
                gratuity: 152000 * 100,
                pending_reimbursements: 25000 * 100,
              })}::jsonb)
    `;
    console.log(`  case 1  Divya Krishnan   · notice_period · 1/7 done · settlement calculated`);

    // ════════════════ 2. COMPLETED case (Ananya) ════════════════════
    await poolSql`
      INSERT INTO public.offboarding_cases
        (id, tenant_id, candidate_id, application_id, onboarding_case_id, initiation_type,
         status, notice_start_date, last_working_day, reason,
         initiated_by_membership_id, manager_membership_id, created_at, updated_at)
      VALUES (${OFFB_CASE_DONE}, ${tid}, ${CAND_DONE}, ${APP_DONE}, ${ONB_CASE_DONE}, 'resignation',
              'completed', ${dateStr(-75)}::date, ${dateStr(-15)}::date,
              'Moving to a fintech startup — amicable exit.',
              ${hrOps}, ${manager}, ${iso(-80)}::timestamptz, now())
    `;
    await insertChecklist(OFFB_CASE_DONE, {
      knowledge_transfer: "completed",
      asset_return: "completed",
      access_revocation: "completed",
      final_settlement: "completed",
      exit_interview: "completed",
      manager_signoff: "completed",
      hr_clearance: "completed",
    });
    await poolSql`
      INSERT INTO public.asset_returns (tenant_id, case_id, asset_type, asset_tag, status, returned_at, received_by_membership_id, notes)
      VALUES
        (${tid}, ${OFFB_CASE_DONE}, 'Laptop (MacBook Pro 16")', 'KYN-LT-3310', 'returned', ${iso(-16)}::timestamptz, ${hrOps}, 'Returned, wiped, re-imaged.'),
        (${tid}, ${OFFB_CASE_DONE}, 'Access ID card', 'KYN-ID-1188', 'returned', ${iso(-15)}::timestamptz, ${hrOps}, 'Deactivated.'),
        (${tid}, ${OFFB_CASE_DONE}, 'Company phone', 'KYN-PH-0442', 'returned', ${iso(-16)}::timestamptz, ${hrOps}, NULL)
    `;
    // Exit interview submitted → frozen (immutable).
    await poolSql`
      INSERT INTO public.exit_interviews (tenant_id, case_id, scheduled_at, conducted_by_membership_id, structured_responses, free_text, submitted_at)
      VALUES (${tid}, ${OFFB_CASE_DONE}, ${iso(-17)}::timestamptz, ${hrOps},
              ${JSON.stringify({ rating: 4, wouldRecommend: true })}::jsonb,
              'Great team and mentorship. Leaving purely for a founder-track opportunity; would happily return.',
              ${iso(-16)}::timestamptz)
    `;
    // Settlement PAID with a breakdown + approver.
    await poolSql`
      INSERT INTO public.final_settlements (tenant_id, case_id, status, amount_minor, currency, breakdown, approved_by_membership_id, paid_at)
      VALUES (${tid}, ${OFFB_CASE_DONE}, 'paid', ${480000 * 100}, 'INR',
              ${JSON.stringify({
                leave_encashment: 92000 * 100,
                gratuity: 316000 * 100,
                pending_reimbursements: 72000 * 100,
              })}::jsonb, ${hrOps}, ${iso(-13)}::timestamptz)
    `;
    // Pre-stamp the Workday terminate event in its terminal 'simulated' state —
    // mirrors ONBOARD-04's pre-stamped hire + the sim drain's terminal write.
    const terminatePayload = {
      worker: {
        full_name: "Ananya Gupta",
        email: "ananya.gupta@example.test",
        workday_worker_id: null,
      },
      termination: { reason_type: "resignation", effective_date: dateStr(-15) },
      effective_date: dateStr(-15),
      offboarding_case_id: OFFB_CASE_DONE,
      source: {
        application_id: APP_DONE,
        offboarding_case_id: OFFB_CASE_DONE,
        terminated_at: iso(-15),
      },
    };
    const simulatedResponse = {
      status: "success",
      workday_reference: {
        type: "Termination",
        wid: randomUUID(),
        descriptor: "Termination: Ananya Gupta",
      },
      effective_date: dateStr(-15),
      simulated_at: iso(-15),
      simulation_notes:
        "This is a simulated response. In production, this would be the actual Workday SOAP response.",
    };
    await poolSql`
      INSERT INTO public.workday_sync_outbox
        (tenant_id, event_type, business_key, subject_application_id, payload,
         status, simulated_at, simulated_response, created_at)
      VALUES (${tid}, ${TERMINATE_EVENT_TYPE}, ${terminateBusinessKey(OFFB_CASE_DONE)},
              ${APP_DONE}, ${JSON.stringify(terminatePayload)}::jsonb,
              'simulated', ${iso(-15)}::timestamptz, ${JSON.stringify(simulatedResponse)}::jsonb, ${iso(-15)}::timestamptz)
    `;
    console.log(
      `  case 2  Ananya Gupta     · completed · 7/7 done · settlement paid · terminate simulated`,
    );

    console.log("\nDone. Two offboarding cases seeded:");
    console.log(`  mid-flight → /offboarding/${OFFB_CASE_MID}`);
    console.log(`  completed  → /offboarding/${OFFB_CASE_DONE}`);
    console.log(`  Sign in as ${HR_OPS_EMAIL} (or admin) and open /offboarding.`);
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
