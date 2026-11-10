/**
 * PC-8 / PC-9 / PC-10 — in-app interview scheduling, against a real Postgres.
 *
 * REQUIRES MIGRATION 0127. Every case is skipped (with a warning) when
 * `interview_slot_offers` does not exist, so this file is safe to run before
 * the migration is applied and needs no edit afterwards.
 *
 * Self-contained: a synthetic tenant (its own scheduling settings, UTC, no
 * notice) with four memberships borrowing existing auth users, one
 * requisition with a 45-minute round 1 whose panel pool holds P1, P2, P3, and
 * two applications. No Supabase sign-in — the tRPC role gates are covered by
 * pc8-scheduling-procs.test.ts.
 *
 * Coverage:
 *   1. propose — weekly windows ∩ across panellists, exceptions removed,
 *      existing interview + buffer removed.
 *   2. propose with a panellist who has no availability → empty + reason, and
 *      the recruiter alert is queued (once per day).
 *   3. offer → row + hashed token + candidate email; a second offer supersedes.
 *   4. public pick page — GET lists still-free slots; POST books (interview +
 *      panel + confirmed + candidate invite + one panellist invite each with
 *      .ics data + signed_link_uses success row); a second POST → 409.
 *   5. signed-link validation — tampered token, wrong action, expired token,
 *      expired offer.
 *   6. RACE — two candidates pick the same slot for the same panel at once →
 *      exactly one books, the other gets `slot_taken` and the refreshed list.
 *   7. can't attend → cannot_attend exception, round needs rescheduling, the
 *      candidate gets a `panelist_unavailable` offer that excludes that window,
 *      recruiter + remaining panellist told; booking it cancels the old round.
 *   8. can't attend + pool replacement who is free at the same time → the
 *      booking stands, the replacement gets the invite, no offer.
 *   9. OOO range over an upcoming round → automatic re-offer.
 *  10. candidate reschedule allowance counter; agent port.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { sql as poolSql } from "@hireops/db";
import { signLink } from "@hireops/notifications";
import { app } from "../src/index.js";
import {
  bookOfferSlot,
  countCandidateReschedules,
  createSlotOffer,
  handleExceptionAdded,
  listNeedsReschedule,
  markCannotAttend,
  proposeSlotsForAgent,
  proposeSlotsForRound,
} from "../src/lib/interview-scheduling";

const T = "00000000-0000-4000-8000-0000000c8001";
const BU = "00000000-0000-4000-8000-0000000c8002";
const POSITION = "00000000-0000-4000-8000-0000000c8003";
const JD = "00000000-0000-4000-8000-0000000c8004";
const REQ = "00000000-0000-4000-8000-0000000c8005";
const POOL = "00000000-0000-4000-8000-0000000c8006";
const REC = "00000000-0000-4000-8000-0000000c8010";
const P1 = "00000000-0000-4000-8000-0000000c8011";
const P2 = "00000000-0000-4000-8000-0000000c8012";
const P3 = "00000000-0000-4000-8000-0000000c8013";
const PERSON_A = "00000000-0000-4000-8000-0000000c8020";
const CAND_A = "00000000-0000-4000-8000-0000000c8021";
const APP_A = "00000000-0000-4000-8000-0000000c8022";
const PERSON_B = "00000000-0000-4000-8000-0000000c8030";
const CAND_B = "00000000-0000-4000-8000-0000000c8031";
const APP_B = "00000000-0000-4000-8000-0000000c8032";

const RUN = Date.now().toString(36);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let migrated = false;

/** Next Monday 00:00Z at least 2 days out — every fixture time hangs off it. */
function nextMonday(): number {
  const d = new Date(Date.now() + 2 * DAY);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = new Date(base).getUTCDay();
  return base + (((8 - dow) % 7) * DAY || 7 * DAY);
}
const MON = nextMonday();
/** "now" for every proposal: the Sunday before MON — keeps results deterministic. */
const NOW = MON - DAY;
const at = (dayOffset: number, h: number, m = 0) => MON + dayOffset * DAY + (h * 60 + m) * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

function skip(name: string): boolean {
  if (migrated) return false;
  console.warn(`PC-8 ${name}: migration 0127 is NOT applied — skipping.`);
  return true;
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () => poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.signed_link_uses WHERE tenant_id = ${T}`,
    ...(migrated
      ? [
          () => poolSql`DELETE FROM public.interview_slot_offers WHERE tenant_id = ${T}`,
          () => poolSql`DELETE FROM public.panelist_availability_exceptions WHERE tenant_id = ${T}`,
          () => poolSql`DELETE FROM public.panelist_availability_windows WHERE tenant_id = ${T}`,
        ]
      : []),
    () => poolSql`DELETE FROM public.interview_panelists WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interviews WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_plans WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.panel_pool_members WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.panel_pools WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenants WHERE id = ${T}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("PC-8 cleanup step failed (continuing):", err);
    }
  }
}

/** Four distinct auth users to hang memberships on (borrowed; a bare local DB gets fresh ones). */
async function borrowUsers(): Promise<string[]> {
  const rows = await poolSql<{ user_id: string }[]>`
    SELECT DISTINCT tum.user_id::text FROM public.tenant_user_memberships tum
    JOIN auth.users au ON au.id = tum.user_id AND au.email IS NOT NULL
    WHERE tum.tenant_id <> ${T}
    LIMIT 4
  `;
  const ids = rows.map((r) => r.user_id);
  while (ids.length < 4) {
    const [u] = await poolSql<{ id: string }[]>`
      INSERT INTO auth.users (email) VALUES (${`pc8-${RUN}-${ids.length}@example.test`})
      RETURNING id::text
    `;
    ids.push(u!.id);
  }
  return ids;
}

async function setWindows(membershipId: string, start: string, end: string): Promise<void> {
  const [h1, m1] = start.split(":").map(Number);
  const [h2, m2] = end.split(":").map(Number);
  await poolSql`DELETE FROM public.panelist_availability_windows WHERE tenant_id = ${T} AND membership_id = ${membershipId}`;
  for (const dow of [1, 2, 3, 4, 5]) {
    await poolSql`
      INSERT INTO public.panelist_availability_windows
        (tenant_id, membership_id, day_of_week, start_minute, end_minute, timezone)
      VALUES (${T}, ${membershipId}, ${dow}, ${h1! * 60 + m1!}, ${h2! * 60 + m2!}, 'UTC')
    `;
  }
}

async function seedInterview(
  id: string,
  applicationId: string,
  round: number,
  start: number,
  panel: string[],
): Promise<void> {
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scorecard_template, scheduled_start, scheduled_end, duration_minutes, mode,
       created_by_membership_id)
    VALUES (${id}, ${T}, ${applicationId}, ${REQ}, ${round}, 'Panel round', 'scheduled', 'technical',
            ${new Date(start).toISOString()}::timestamptz, ${new Date(start + 45 * MIN).toISOString()}::timestamptz, 45, 'video', ${REC})
  `;
  for (const m of panel) {
    await poolSql`
      INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
      VALUES (${T}, ${id}, ${m}, ${m === panel[0]})
    `;
  }
}

async function clearBookings(): Promise<void> {
  await poolSql`DELETE FROM public.interview_slot_offers WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.panelist_availability_exceptions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.interview_panelists WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.interviews WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${T}`;
}

async function pickTokenFor(offerId: string): Promise<string> {
  const [row] = await poolSql<{ template_data: { pickUrl?: string } }[]>`
    SELECT template_data FROM public.notification_outbox
    WHERE tenant_id = ${T} AND template_key = 'candidate.interview_slot_offer'
      AND dedup_key LIKE ${`interview_slot_offer:${offerId}:%`}
  `;
  const url = row?.template_data?.pickUrl;
  assert.ok(url, "pickUrl missing from the slot-offer email");
  return url.split("/interviews/pick/")[1]!;
}

async function postPick(token: string, slotStart: string) {
  const res = await app.request(`/api/interviews/pick/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slotStart }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("PC-8/9/10 — in-app interview scheduling (migration 0127)", () => {
  beforeAll(async () => {
    const [t] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'interview_slot_offers'
    `;
    migrated = (t?.n ?? 0) > 0;
    await cleanup();
    if (!migrated) return;

    const [uRec, u1, u2, u3] = await borrowUsers();
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings)
      VALUES (${T}, ${`synth-pc8-${RUN}`}, ${`PC8 ${RUN}`}, 'ap-south-1', 'active',
              ${JSON.stringify({
                scheduling: {
                  timezone: "UTC",
                  workingHoursStart: "00:00",
                  workingHoursEnd: "24:00",
                  workingDays: [0, 1, 2, 3, 4, 5, 6],
                  bufferMinutes: 15,
                  minNoticeHours: 0,
                  slotHorizonDays: 21,
                  slotIncrementMinutes: 30,
                  maxSlotsOffered: 5,
                  offerLinkValidityHours: 72,
                  maxCandidateReschedules: 2,
                },
              })}::jsonb)
    `;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${T}, ${`PC8 BU ${RUN}`}, ${`pc8-bu-${RUN}`})`;
    const members: [string, string, string][] = [
      [REC, uRec!, "recruiter"],
      [P1, u1!, "panel_member"],
      [P2, u2!, "panel_member"],
      [P3, u3!, "panel_member"],
    ];
    for (const [id, userId, role] of members) {
      await poolSql`
        INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status)
        VALUES (${id}, ${T}, ${userId}, ${`{${role}}`}::tenant_role[], 'active')
      `;
    }
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, 'PC8 Analyst', 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# PC8', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${REC}, ${REC}, 'posted')
    `;
    for (const [person, cand, appId, name] of [
      [PERSON_A, CAND_A, APP_A, "Asha Candidate"],
      [PERSON_B, CAND_B, APP_B, "Bilal Candidate"],
    ] as const) {
      const email = `${name.split(" ")[0]!.toLowerCase()}-${RUN}@example.test`;
      await poolSql`
        INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
        VALUES (${person}, ${T}, ${name}, ${email}, ${email})
      `;
      await poolSql`
        INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
        VALUES (${cand}, ${T}, ${person}, 'career_site', 'v1')
      `;
      await poolSql`
        INSERT INTO public.applications
          (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
        VALUES (${appId}, ${T}, ${cand}, ${REQ}, 'career_site', 'shortlisted', now())
      `;
    }
    await poolSql`INSERT INTO public.panel_pools (id, tenant_id, name) VALUES (${POOL}, ${T}, 'PC8 pool')`;
    for (const m of [P1, P2, P3]) {
      await poolSql`INSERT INTO public.panel_pool_members (tenant_id, panel_pool_id, membership_id) VALUES (${T}, ${POOL}, ${m})`;
    }
    await poolSql`
      INSERT INTO public.interview_plans
        (tenant_id, requisition_id, round_number, round_name, duration_minutes, mode,
         scorecard_template, default_panel_membership_ids, panel_pool_id)
      VALUES (${T}, ${REQ}, 1, 'Panel round', 45, 'video', 'technical',
              ${[P1, P2]}::uuid[], ${POOL})
    `;
    // P1 09:00–12:00, P2 10:00–13:00, P3 09:00–17:00 (weekdays, UTC).
    await setWindows(P1, "09:00", "12:00");
    await setWindows(P2, "10:00", "13:00");
    await setWindows(P3, "09:00", "17:00");
  });

  afterAll(async () => {
    await cleanup();
  });

  it("1. propose intersects the panel and removes exceptions + buffered interviews", async () => {
    if (skip("1")) return;
    await clearBookings();
    // Common time = 10:00–12:00 weekdays → 45-min starts 10:00, 10:30, 11:00.
    const r = await proposeSlotsForRound(
      poolSql,
      T,
      { applicationId: APP_A, roundNumber: 1, limit: 50, horizonDaysOverride: 5 },
      NOW,
    );
    assert.equal(r.durationMinutes, 45);
    assert.equal(r.timezone, "UTC");
    assert.equal(r.emptyReason, null);
    assert.deepEqual(
      r.slots.filter((s) => s.start.startsWith(iso(MON).slice(0, 10))).map((s) => s.start),
      [iso(at(0, 10)), iso(at(0, 10, 30)), iso(at(0, 11))],
    );

    // P1 out Monday 10:00–11:00; P2 has another interview Tuesday 10:30–11:15 (+15 buffer).
    await poolSql`
      INSERT INTO public.panelist_availability_exceptions (tenant_id, membership_id, starts_at, ends_at, kind)
      VALUES (${T}, ${P1}, ${new Date(at(0, 10)).toISOString()}::timestamptz, ${new Date(at(0, 11)).toISOString()}::timestamptz, 'out_of_office')
    `;
    await seedInterview("00000000-0000-4000-8000-0000000c8101", APP_B, 1, at(1, 10, 30), [P2]);
    const r2 = await proposeSlotsForRound(
      poolSql,
      T,
      { applicationId: APP_A, roundNumber: 1, limit: 50, horizonDaysOverride: 5 },
      NOW,
    );
    const mon = r2.slots.filter((s) => s.start.startsWith(iso(at(0, 0)).slice(0, 10)));
    const tue = r2.slots.filter((s) => s.start.startsWith(iso(at(1, 0)).slice(0, 10)));
    assert.deepEqual(
      mon.map((s) => s.start),
      [iso(at(0, 11))],
    );
    // Busy 10:15–11:30 with buffer → nothing fits 10:00–12:00 except none (11:30+45 > 12:00).
    assert.deepEqual(tue, []);
  });

  it("2. a panellist with no availability → empty result, reason, recruiter alert once a day", async () => {
    if (skip("2")) return;
    await clearBookings();
    const r = await proposeSlotsForRound(
      poolSql,
      T,
      { applicationId: APP_A, roundNumber: 1, panelMembershipIds: [P1, REC] },
      NOW,
    );
    assert.equal(r.slots.length, 0);
    assert.match(r.emptyReason ?? "", /not set any availability/);
    assert.equal(r.panel.find((p) => p.membershipId === REC)?.hasAvailability, false);

    // createSlotOffer with the same panel: no offer row, the recruiter is alerted.
    const o = await createSlotOffer(poolSql, {
      tenantId: T,
      applicationId: APP_A,
      roundNumber: 1,
      panelMembershipIds: [P1, REC],
      reason: "initial",
      createdByMembershipId: REC,
      now: NOW,
    });
    assert.equal(o.offerId, null);
    assert.equal(o.recruiterAlerted, true);
    const again = await createSlotOffer(poolSql, {
      tenantId: T,
      applicationId: APP_A,
      roundNumber: 1,
      panelMembershipIds: [P1, REC],
      reason: "initial",
      createdByMembershipId: REC,
      now: NOW,
    });
    assert.equal(again.offerId, null);
    const [n] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.notification_outbox
      WHERE tenant_id = ${T} AND template_key = 'recruiter.scheduling_alert'
    `;
    assert.equal(n?.n, 1, "the alert is de-duplicated per recipient per day");
  });

  it("3. offer stores slots + hashed token, emails the candidate, and supersedes the previous one", async () => {
    if (skip("3")) return;
    await clearBookings();
    const first = await createSlotOffer(poolSql, {
      tenantId: T,
      applicationId: APP_A,
      roundNumber: 1,
      panelMembershipIds: [P1, P2],
      leadMembershipId: P1,
      reason: "initial",
      createdByMembershipId: REC,
      now: NOW,
    });
    assert.ok(first.offerId);
    assert.equal(first.slots.length, 5);
    // Spread across days: the first five weekdays' 10:00.
    assert.deepEqual(
      first.slots.map((s) => s.start),
      [0, 1, 2, 3, 4].map((d) => iso(at(d, 10))),
    );
    const [row] = await poolSql<{ token_hash: string | null; status: string; timezone: string }[]>`
      SELECT token_hash, status, timezone FROM public.interview_slot_offers WHERE id = ${first.offerId}
    `;
    assert.ok(row?.token_hash);
    assert.equal(row?.status, "open");
    const token = await pickTokenFor(first.offerId!);
    assert.ok(token.length > 20);

    const second = await createSlotOffer(poolSql, {
      tenantId: T,
      applicationId: APP_A,
      roundNumber: 1,
      panelMembershipIds: [P1, P2],
      slotStarts: [iso(at(2, 11)), iso(at(1, 10, 30))],
      reason: "initial",
      createdByMembershipId: REC,
      now: NOW,
    });
    assert.deepEqual(
      second.slots.map((s) => s.start),
      [iso(at(1, 10, 30)), iso(at(2, 11))],
    );
    const [old] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.interview_slot_offers WHERE id = ${first.offerId}
    `;
    assert.equal(old?.status, "superseded");

    // A chosen start that is not free is refused.
    await assert.rejects(
      createSlotOffer(poolSql, {
        tenantId: T,
        applicationId: APP_A,
        roundNumber: 1,
        panelMembershipIds: [P1, P2],
        slotStarts: [iso(at(0, 9))],
        reason: "initial",
        createdByMembershipId: REC,
        now: NOW,
      }),
      /no longer free/,
    );
  });

  it("4. public pick page lists and books; panel + candidate invites; second POST refused", async () => {
    if (skip("4")) return;
    await clearBookings();
    const offer = await createSlotOffer(poolSql, {
      tenantId: T,
      applicationId: APP_A,
      roundNumber: 1,
      panelMembershipIds: [P1, P2],
      leadMembershipId: P2,
      reason: "initial",
      createdByMembershipId: REC,
      now: NOW,
    });
    const token = await pickTokenFor(offer.offerId!);

    const get = await app.request(`/api/interviews/pick/${token}`);
    assert.equal(get.status, 200);
    const view = (await get.json()) as { ok: boolean; slots: { start: string }[]; status: string };
    assert.equal(view.ok, true);
    assert.equal(view.status, "open");
    assert.equal(view.slots.length, 5);

    const pick = view.slots[1]!.start;
    const res = await postPick(token, pick);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const interviewId = res.body.interviewId as string;

    const [iv] = await poolSql<
      {
        status: string;
        scheduled_start: Date;
        candidate_confirmed_at: Date | null;
        scorecard_template: string;
      }[]
    >`SELECT status, scheduled_start, candidate_confirmed_at, scorecard_template FROM public.interviews WHERE id = ${interviewId}`;
    assert.equal(iv?.status, "scheduled");
    assert.equal(new Date(iv!.scheduled_start).toISOString(), pick);
    assert.ok(iv?.candidate_confirmed_at, "a picked time counts as confirmed");
    assert.equal(iv?.scorecard_template, "technical");

    const panel = await poolSql<{ membership_id: string; is_lead: boolean }[]>`
      SELECT membership_id::text, is_lead FROM public.interview_panelists WHERE interview_id = ${interviewId} ORDER BY membership_id
    `;
    assert.deepEqual(
      panel.map((p) => [p.membership_id, p.is_lead]),
      [
        [P1, false],
        [P2, true],
      ],
    );

    const mail = await poolSql<
      {
        template_key: string;
        recipient_membership_id: string | null;
        template_data: Record<string, unknown>;
      }[]
    >`
      SELECT template_key, recipient_membership_id::text, template_data FROM public.notification_outbox
      WHERE tenant_id = ${T} AND template_key IN ('candidate.interview_invitation', 'panelist.interview_scheduled')
    `;
    assert.equal(mail.filter((m) => m.template_key === "candidate.interview_invitation").length, 1);
    const panelMail = mail.filter((m) => m.template_key === "panelist.interview_scheduled");
    assert.deepEqual(panelMail.map((m) => m.recipient_membership_id).sort(), [P1, P2]);
    assert.equal(panelMail[0]?.template_data.interviewStartIso, pick);

    const [use] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.signed_link_uses
      WHERE tenant_id = ${T} AND action = 'candidate.pick_interview_slot' AND successful = true
    `;
    assert.equal(use?.n, 1);

    const [stage] = await poolSql<
      { current_stage: string }[]
    >`SELECT current_stage FROM public.applications WHERE id = ${APP_A}`;
    assert.equal(stage?.current_stage, "tech_interview", "booking moves the stage forward");

    const again = await postPick(token, view.slots[2]!.start);
    assert.equal(again.status, 409);
    assert.equal(again.body.reason, "already_booked");

    const after = (await (await app.request(`/api/interviews/pick/${token}`)).json()) as {
      status: string;
      bookedSlotStart: string;
    };
    assert.equal(after.status, "booked");
    assert.equal(after.bookedSlotStart, pick);
  });

  it("5. signed-link validation: tampered, wrong action, expired token, expired offer", async () => {
    if (skip("5")) return;
    await clearBookings();
    await poolSql`UPDATE public.applications SET current_stage = 'shortlisted' WHERE id = ${APP_A}`;
    const offer = await createSlotOffer(poolSql, {
      tenantId: T,
      applicationId: APP_A,
      roundNumber: 1,
      panelMembershipIds: [P1, P2],
      reason: "initial",
      createdByMembershipId: REC,
      now: NOW,
    });
    const token = await pickTokenFor(offer.offerId!);

    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    const t1 = await app.request(`/api/interviews/pick/${tampered}`);
    assert.equal(t1.status, 400);

    const confirmToken = signLink({
      action: "candidate.confirm_interview",
      subjectId: offer.offerId!,
      expiresAt: new Date(Date.now() + DAY),
    });
    const t2 = await app.request(`/api/interviews/pick/${confirmToken}`);
    assert.equal(t2.status, 400);
    assert.equal(((await t2.json()) as { reason: string }).reason, "wrong_action");

    const expiredToken = signLink({
      action: "candidate.pick_interview_slot",
      subjectId: offer.offerId!,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const t3 = await postPick(expiredToken, offer.slots[0]!.start);
    assert.equal(t3.status, 400);
    assert.equal(t3.body.reason, "expired");

    // Offer expiry is enforced on its own, even with a live token.
    await poolSql`UPDATE public.interview_slot_offers SET expires_at = now() - interval '1 minute' WHERE id = ${offer.offerId}`;
    const t4 = await postPick(token, offer.slots[0]!.start);
    assert.equal(t4.status, 409);
    assert.equal(t4.body.reason, "offer_expired");

    // A slot that was never offered.
    await poolSql`UPDATE public.interview_slot_offers SET expires_at = now() + interval '1 day', status = 'open' WHERE id = ${offer.offerId}`;
    const t5 = await postPick(token, iso(at(0, 9)));
    assert.equal(t5.status, 400);
    assert.equal(t5.body.reason, "slot_not_offered");
  });

  it("6. RACE: two candidates pick the same slot for the same panel → exactly one books", async () => {
    if (skip("6")) return;
    await clearBookings();
    const slot = iso(at(3, 10));
    const offerA = await createSlotOffer(poolSql, {
      tenantId: T,
      applicationId: APP_A,
      roundNumber: 1,
      panelMembershipIds: [P1, P2],
      slotStarts: [slot, iso(at(3, 11))],
      reason: "initial",
      createdByMembershipId: REC,
      now: NOW,
    });
    const offerB = await createSlotOffer(poolSql, {
      tenantId: T,
      applicationId: APP_B,
      roundNumber: 1,
      panelMembershipIds: [P1, P2],
      slotStarts: [slot, iso(at(4, 10))],
      reason: "initial",
      createdByMembershipId: REC,
      now: NOW,
    });
    const [a, b] = await Promise.all([
      bookOfferSlot(poolSql, {
        by: { tenantId: T, offerId: offerA.offerId! },
        slotStart: slot,
        via: "candidate_portal",
      }),
      bookOfferSlot(poolSql, {
        by: { tenantId: T, offerId: offerB.offerId! },
        slotStart: slot,
        via: "candidate_portal",
      }),
    ]);
    const wins = [a, b].filter((r) => r.ok);
    const losses = [a, b].filter((r) => !r.ok);
    assert.equal(wins.length, 1, `exactly one booking must win: ${JSON.stringify([a, b])}`);
    assert.equal(losses.length, 1);
    const loss = losses[0]!;
    assert.ok(!loss.ok && loss.reason === "slot_taken");
    // The loser is handed what is still free from its own offer.
    assert.ok(!loss.ok && (loss.slots ?? []).every((s) => s.start !== slot));
    assert.ok(!loss.ok && (loss.slots ?? []).length === 1);

    const [n] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.interviews WHERE tenant_id = ${T} AND scheduled_start = ${new Date(slot).toISOString()}::timestamptz
    `;
    assert.equal(n?.n, 1);

    // Same offer, same slot, twice at once → one booking.
    await clearBookings();
    const offerC = await createSlotOffer(poolSql, {
      tenantId: T,
      applicationId: APP_A,
      roundNumber: 1,
      panelMembershipIds: [P1, P2],
      reason: "initial",
      createdByMembershipId: REC,
      now: NOW,
    });
    const s = offerC.slots[0]!.start;
    const both = await Promise.all([
      bookOfferSlot(poolSql, {
        by: { tenantId: T, offerId: offerC.offerId! },
        slotStart: s,
        via: "candidate_portal",
      }),
      bookOfferSlot(poolSql, {
        by: { tenantId: T, offerId: offerC.offerId! },
        slotStart: s,
        via: "candidate_portal",
      }),
    ]);
    assert.equal(both.filter((r) => r.ok).length, 1);
    assert.ok(both.some((r) => !r.ok && r.reason === "already_booked"));
  });

  it("7. can't attend → exception, needs reschedule, automatic re-offer excluding the window, notices; booking replaces the round", async () => {
    if (skip("7")) return;
    await clearBookings();
    const IV = "00000000-0000-4000-8000-0000000c8201";
    const start = at(2, 10);
    await seedInterview(IV, APP_A, 1, start, [P1, P2]);

    const res = await markCannotAttend(poolSql, {
      tenantId: T,
      interviewId: IV,
      membershipId: P1,
      reason: "travel",
      actorMembershipId: P1,
      now: NOW,
    });
    assert.ok(res.exceptionId);
    assert.ok(res.offerId, "the candidate is offered new times automatically");
    assert.equal(res.replacedWith, null);

    const needs = await listNeedsReschedule(poolSql, T, APP_A);
    assert.equal(needs.length, 1);
    assert.equal(needs[0]?.interviewId, IV);
    assert.deepEqual(needs[0]?.membershipIds, [P1]);
    assert.match(needs[0]?.reasons[0] ?? "", /Can't attend: travel/);

    const [offer] = await poolSql<
      { reason: string; replaces_interview_id: string; slots: { start: string }[] }[]
    >`
      SELECT reason, replaces_interview_id::text, slots FROM public.interview_slot_offers WHERE id = ${res.offerId}
    `;
    assert.equal(offer?.reason, "panelist_unavailable");
    assert.equal(offer?.replaces_interview_id, IV);
    for (const s of offer!.slots) {
      const t = new Date(s.start).getTime();
      assert.ok(
        t + 45 * MIN <= start - 15 * MIN || t >= start + 45 * MIN + 15 * MIN,
        `slot ${s.start} overlaps the declined window`,
      );
    }

    const notices = await poolSql<
      { template_key: string; recipient_membership_id: string | null }[]
    >`
      SELECT template_key, recipient_membership_id::text FROM public.notification_outbox WHERE tenant_id = ${T}
    `;
    assert.equal(
      notices.filter((n) => n.template_key === "candidate.interview_slot_offer").length,
      1,
    );
    assert.deepEqual(
      notices
        .filter((n) => n.template_key === "panelist.interview_rescheduling")
        .map((n) => n.recipient_membership_id)
        .sort(),
      [REC, P2].sort(),
      "recruiter + the remaining panellist are told; the absent one is not",
    );

    const book = await bookOfferSlot(poolSql, {
      by: { tenantId: T, offerId: res.offerId! },
      slotStart: offer!.slots[0]!.start,
      via: "candidate_portal",
    });
    assert.ok(book.ok, JSON.stringify(book));
    const [old] = await poolSql<{ status: string; cancelled_at: Date | null }[]>`
      SELECT status, cancelled_at FROM public.interviews WHERE id = ${IV}
    `;
    assert.equal(old?.status, "cancelled");
    assert.ok(old?.cancelled_at);
    assert.deepEqual(await listNeedsReschedule(poolSql, T, APP_A), []);
  });

  it("8. can't attend + a pool replacement free at the same time → booking stands, no offer", async () => {
    if (skip("8")) return;
    await clearBookings();
    const IV = "00000000-0000-4000-8000-0000000c8301";
    await seedInterview(IV, APP_A, 1, at(2, 10), [P1, P2]);
    const res = await markCannotAttend(poolSql, {
      tenantId: T,
      interviewId: IV,
      membershipId: P1,
      replacementMembershipId: P3,
      actorMembershipId: REC,
      now: NOW,
    });
    assert.equal(res.replacedWith, P3);
    assert.equal(res.offerId, null);
    const panel = await poolSql<{ membership_id: string }[]>`
      SELECT membership_id::text FROM public.interview_panelists WHERE interview_id = ${IV} ORDER BY membership_id
    `;
    assert.deepEqual(
      panel.map((p) => p.membership_id),
      [P2, P3],
    );
    const [invite] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.notification_outbox
      WHERE tenant_id = ${T} AND template_key = 'panelist.interview_scheduled' AND recipient_membership_id = ${P3}
    `;
    assert.equal(invite?.n, 1);
    assert.deepEqual(
      await listNeedsReschedule(poolSql, T, APP_A),
      [],
      "swapped out → no conflict left",
    );

    // A replacement from outside the pool is refused.
    await assert.rejects(
      markCannotAttend(poolSql, {
        tenantId: T,
        interviewId: IV,
        membershipId: P2,
        replacementMembershipId: REC,
        actorMembershipId: REC,
        now: NOW,
      }),
      /panel pool/,
    );
  });

  it("9. an OOO range over an upcoming round triggers an automatic re-offer", async () => {
    if (skip("9")) return;
    await clearBookings();
    const IV = "00000000-0000-4000-8000-0000000c8401";
    await seedInterview(IV, APP_B, 1, at(3, 11), [P1, P2]);
    await poolSql`
      INSERT INTO public.panelist_availability_exceptions (tenant_id, membership_id, starts_at, ends_at, kind, reason)
      VALUES (${T}, ${P2}, ${new Date(at(3, 0)).toISOString()}::timestamptz, ${new Date(at(4, 0)).toISOString()}::timestamptz, 'out_of_office', 'leave')
    `;
    const r = await handleExceptionAdded(poolSql, {
      tenantId: T,
      membershipId: P2,
      startsAt: new Date(at(3, 0)),
      endsAt: new Date(at(4, 0)),
      now: NOW,
    });
    assert.deepEqual(r.affected, [IV]);
    assert.deepEqual(r.reoffered, [IV]);
    // Running it again does not stack a second offer.
    const again = await handleExceptionAdded(poolSql, {
      tenantId: T,
      membershipId: P2,
      startsAt: new Date(at(3, 0)),
      endsAt: new Date(at(4, 0)),
      now: NOW,
    });
    assert.deepEqual(again.reoffered, []);
  });

  it("10. candidate reschedule counter + the agent port", async () => {
    if (skip("10")) return;
    await clearBookings();
    assert.equal(await countCandidateReschedules(poolSql, T, APP_A, 1), 0);
    const IV = "00000000-0000-4000-8000-0000000c8501";
    await seedInterview(IV, APP_A, 1, at(4, 10), [P1, P2]);
    await createSlotOffer(poolSql, {
      tenantId: T,
      applicationId: APP_A,
      roundNumber: 1,
      panelMembershipIds: [P1, P2],
      reason: "candidate_reschedule",
      replacesInterviewId: IV,
      createdByMembershipId: REC,
      now: NOW,
    });
    assert.equal(await countCandidateReschedules(poolSql, T, APP_A, 1), 1);

    await clearBookings();
    const viaPool = await proposeSlotsForAgent(poolSql, T, {
      applicationId: APP_B,
      roundNumber: null,
      panelRef: POOL,
      slotCount: 3,
      windowDays: 7,
      durationMinutes: 45,
    });
    assert.equal(viaPool.roundNumber, 1);
    assert.ok(viaPool.slots.length > 0 && viaPool.slots.length <= 3);
    // Pool = P1 ∩ P2 ∩ P3 → 10:00–12:00 weekdays.
    for (const s of viaPool.slots) {
      const h = new Date(s.start).getUTCHours();
      assert.ok(h >= 10 && h < 12, s.start);
    }
    const viaPlan = await proposeSlotsForAgent(poolSql, T, {
      applicationId: APP_B,
      roundNumber: 1,
      panelRef: "not-a-pool",
      slotCount: 2,
      windowDays: 7,
      durationMinutes: 30,
    });
    assert.equal(viaPlan.slots.length, 2);
  });
});
