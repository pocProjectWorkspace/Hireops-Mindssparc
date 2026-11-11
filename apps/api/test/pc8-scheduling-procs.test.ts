/**
 * PC-8 / PC-9 / PC-10 — the tRPC surface: role gates, self-service
 * availability, settings, and the candidate portal procedures.
 *
 * REQUIRES MIGRATION 0127 — skipped with a warning until it is applied.
 *
 * Harness: appRouter.createCaller with synthetic contexts (cand-01's shape), so
 * no Supabase sign-in is needed — the gates under test are the procedures' own
 * role checks and the candidate person-scoping. A synthetic tenant holds every
 * fixture.
 *
 * Coverage:
 *   1. settings: any member reads; only admin writes; invalid input rejected;
 *      the write is a sibling key (other settings blocks preserved).
 *   2. availability: a panellist edits their own; a recruiter can VIEW another
 *      member but not EDIT; a panellist cannot view another; admin can edit.
 *   3. propose / offer / list are recruiter-HM-admin only (panel_member and
 *      hr_head FORBIDDEN).
 *   4. can't attend: a panellist may mark only themselves and may not swap;
 *      the recruiter may act for them.
 *   5. candidate portal: sees only their own offers, picks a slot, requests a
 *      reschedule within the allowance (idempotent while an offer is open, then
 *      refused past the limit); another candidate gets NOT_FOUND.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";

const T = "00000000-0000-4000-8000-0000000c9001";
const BU = "00000000-0000-4000-8000-0000000c9002";
const POSITION = "00000000-0000-4000-8000-0000000c9003";
const JD = "00000000-0000-4000-8000-0000000c9004";
const REQ = "00000000-0000-4000-8000-0000000c9005";
const ADMIN = "00000000-0000-4000-8000-0000000c9010";
const REC = "00000000-0000-4000-8000-0000000c9011";
const P1 = "00000000-0000-4000-8000-0000000c9012";
const P2 = "00000000-0000-4000-8000-0000000c9013";
const HRH = "00000000-0000-4000-8000-0000000c9014";
const PERSON_A = "00000000-0000-4000-8000-0000000c9020";
const CAND_A = "00000000-0000-4000-8000-0000000c9021";
const APP_A = "00000000-0000-4000-8000-0000000c9022";
const PERSON_B = "00000000-0000-4000-8000-0000000c9030";
const CAND_B = "00000000-0000-4000-8000-0000000c9031";
const APP_B = "00000000-0000-4000-8000-0000000c9032";
const IV_A = "00000000-0000-4000-8000-0000000c9040";

const CAND_AUTH_A = randomUUID();
const CAND_AUTH_B = randomUUID();
const RUN = Date.now().toString(36);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const log = createLogger({ level: "error" });
let migrated = false;
const userIds: Record<string, string> = {};

function skip(name: string): boolean {
  if (migrated) return false;
  console.warn(`PC-8 procs ${name}: migration 0127 is NOT applied — skipping.`);
  return true;
}

function staff(membershipId: string, roles: string[]) {
  const userId = userIds[membershipId]!;
  const claims = { sub: userId, tid: T, roles };
  const ctx: HonoTRPCContext = {
    tenantId: T,
    userId,
    roles,
    claims,
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-pc8-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

function candidate(authId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId: authId,
    roles: [],
    claims: { sub: authId },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-pc8c-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof TRPCError, `expected TRPCError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () => poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.signed_link_uses WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`,
    ...(migrated
      ? [
          () => poolSql`DELETE FROM public.interview_slot_offers WHERE tenant_id = ${T}`,
          () => poolSql`DELETE FROM public.panelist_availability_exceptions WHERE tenant_id = ${T}`,
          () => poolSql`DELETE FROM public.panelist_availability_windows WHERE tenant_id = ${T}`,
        ]
      : []),
    () => poolSql`DELETE FROM public.candidate_accounts WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_panelists WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interviews WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_plans WHERE tenant_id = ${T}`,
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
      console.warn("PC-8 procs cleanup step failed (continuing):", err);
    }
  }
}

async function borrowUsers(n: number): Promise<string[]> {
  const rows = await poolSql<{ user_id: string }[]>`
    SELECT DISTINCT tum.user_id::text FROM public.tenant_user_memberships tum
    JOIN auth.users au ON au.id = tum.user_id AND au.email IS NOT NULL
    WHERE tum.tenant_id <> ${T}
    LIMIT ${n}
  `;
  const ids = rows.map((r) => r.user_id);
  while (ids.length < n) {
    const [u] = await poolSql<{ id: string }[]>`
      INSERT INTO auth.users (email) VALUES (${`pc8p-${RUN}-${ids.length}@example.test`})
      RETURNING id::text
    `;
    ids.push(u!.id);
  }
  return ids;
}

/** Weekdays 09:00–17:00 UTC for a member, via the real procedure. */
const WEEKDAYS = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  start: "09:00",
  end: "17:00",
  timezone: "UTC",
}));

describe("PC-8/9/10 — scheduling procedures (migration 0127)", () => {
  beforeAll(async () => {
    const [t] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'interview_slot_offers'
    `;
    migrated = (t?.n ?? 0) > 0;
    await cleanup();
    if (!migrated) return;

    const users = await borrowUsers(5);
    [ADMIN, REC, P1, P2, HRH].forEach((m, i) => {
      userIds[m] = users[i]!;
    });
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings)
      VALUES (${T}, ${`synth-pc8p-${RUN}`}, ${`PC8P ${RUN}`}, 'ap-south-1', 'active',
              ${JSON.stringify({ branding: { keep: true } })}::jsonb)
    `;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${T}, ${`PC8P BU ${RUN}`}, ${`pc8p-bu-${RUN}`})`;
    const roles: [string, string][] = [
      [ADMIN, "admin"],
      [REC, "recruiter"],
      [P1, "panel_member"],
      [P2, "panel_member"],
      [HRH, "hr_head"],
    ];
    for (const [id, role] of roles) {
      await poolSql`
        INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status)
        VALUES (${id}, ${T}, ${userIds[id]!}, ${`{${role}}`}::tenant_role[], 'active')
      `;
    }
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, 'PC8P Analyst', 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# PC8P', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${REC}, ${REC}, 'posted')
    `;
    for (const [person, cand, appId, auth, name] of [
      [PERSON_A, CAND_A, APP_A, CAND_AUTH_A, "Asha"],
      [PERSON_B, CAND_B, APP_B, CAND_AUTH_B, "Bilal"],
    ] as const) {
      const email = `${name.toLowerCase()}-pc8p-${RUN}@example.test`;
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
      await poolSql`
        INSERT INTO public.candidate_accounts (tenant_id, person_id, user_id, status, activated_at)
        VALUES (${T}, ${person}, ${auth}, 'active', now())
      `;
    }
    await poolSql`
      INSERT INTO public.interview_plans
        (tenant_id, requisition_id, round_number, round_name, duration_minutes, mode,
         scorecard_template, default_panel_membership_ids)
      VALUES (${T}, ${REQ}, 1, 'Panel round', 45, 'video', 'technical', ${[P1, P2]}::uuid[]),
             (${T}, ${REQ}, 2, 'HR round', 30, 'video', 'hr', ${[P1]}::uuid[])
    `;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("1. settings: anyone reads, only admin writes, sibling key preserved", async () => {
    if (skip("1")) return;
    const read = await staff(P1, ["panel_member"]).getSchedulingSettings({});
    assert.equal(read.timezone, "UTC");
    assert.equal(read.timezoneSource, "platform");
    assert.deepEqual(read.durationPresets, [30, 45, 60]);
    assert.equal(read.defaultDurationMinutes, 45);

    const body = {
      timezone: null,
      durationPresets: [30, 45, 60],
      defaultDurationMinutes: 45,
      workingHoursStart: "00:00",
      workingHoursEnd: "24:00",
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      bufferMinutes: 10,
      minNoticeHours: 0,
      slotHorizonDays: 21,
      slotIncrementMinutes: 30,
      maxSlotsOffered: 4,
      offerLinkValidityHours: 48,
      maxCandidateReschedules: 1,
      assumeWorkingHoursWhenNoAvailability: false,
    };
    await expectCode(staff(REC, ["recruiter"]).updateSchedulingSettings(body), "FORBIDDEN");
    await expectCode(
      staff(ADMIN, ["admin"]).updateSchedulingSettings({
        ...body,
        workingHoursEnd: "08:00",
        workingHoursStart: "09:00",
      }),
      "BAD_REQUEST",
    );
    const saved = await staff(ADMIN, ["admin"]).updateSchedulingSettings(body);
    assert.equal(saved.scheduling.maxSlotsOffered, 4);
    assert.equal(saved.scheduling.maxCandidateReschedules, 1);
    const [row] = await poolSql<
      { settings: Record<string, unknown> }[]
    >`SELECT settings FROM public.tenants WHERE id = ${T}`;
    assert.deepEqual(row?.settings.branding, { keep: true }, "other settings blocks untouched");
  });

  it("2. availability: self edit, recruiter views others, panellist can't, admin edits others", async () => {
    if (skip("2")) return;
    const p1 = staff(P1, ["panel_member"]);
    const set = await p1.setPanelistAvailabilityWindows({ windows: WEEKDAYS });
    assert.equal(set.membershipId, P1);
    assert.equal(set.windowCount, 5);
    const mine = await p1.getPanelistAvailability({});
    assert.equal(mine.canEdit, true);
    assert.equal(mine.windows.length, 5);
    assert.equal(mine.windows[0]?.start, "09:00");

    await expectCode(p1.getPanelistAvailability({ membershipId: P2 }), "FORBIDDEN");
    await expectCode(
      p1.setPanelistAvailabilityWindows({ membershipId: P2, windows: WEEKDAYS }),
      "FORBIDDEN",
    );

    const rec = staff(REC, ["recruiter"]);
    const viewed = await rec.getPanelistAvailability({ membershipId: P1 });
    assert.equal(viewed.windows.length, 5);
    assert.equal(viewed.canEdit, false);
    await expectCode(
      rec.setPanelistAvailabilityWindows({ membershipId: P1, windows: [] }),
      "FORBIDDEN",
    );

    const byAdmin = await staff(ADMIN, ["admin"]).setPanelistAvailabilityWindows({
      membershipId: P2,
      windows: WEEKDAYS,
    });
    assert.equal(byAdmin.membershipId, P2);

    // A bad window is refused by the input schema.
    await expectCode(
      p1.setPanelistAvailabilityWindows({
        windows: [{ dayOfWeek: 1, start: "17:00", end: "09:00", timezone: "UTC" }],
      }),
      "BAD_REQUEST",
    );
    await expectCode(
      p1.setPanelistAvailabilityWindows({
        windows: [{ dayOfWeek: 1, start: "09:00", end: "17:00", timezone: "Nowhere/Zone" }],
      }),
      "BAD_REQUEST",
    );

    // Exceptions: add + remove own.
    const start = new Date(Date.now() + 30 * DAY).toISOString();
    const end = new Date(Date.now() + 31 * DAY).toISOString();
    const exc = await p1.addAvailabilityException({
      startsAt: start,
      endsAt: end,
      kind: "out_of_office",
      reason: "leave",
    });
    assert.deepEqual(exc.affectedInterviewIds, []);
    await expectCode(
      staff(P2, ["panel_member"]).removeAvailabilityException({ exceptionId: exc.exceptionId }),
      "FORBIDDEN",
    );
    await p1.removeAvailabilityException({ exceptionId: exc.exceptionId });
  });

  it("3. propose / offer / list are recruiter-HM-admin only", async () => {
    if (skip("3")) return;
    const input = { applicationId: APP_A, roundNumber: 1 };
    await expectCode(staff(P1, ["panel_member"]).proposeInterviewSlots(input), "FORBIDDEN");
    await expectCode(staff(HRH, ["hr_head"]).proposeInterviewSlots(input), "FORBIDDEN");
    await expectCode(
      staff(P1, ["panel_member"]).offerInterviewSlots({ ...input, panelMembershipIds: [P1] }),
      "FORBIDDEN",
    );
    await expectCode(
      staff(HRH, ["hr_head"]).listSlotOffersByApplication({ applicationId: APP_A }),
      "FORBIDDEN",
    );
    const r = await staff(REC, ["recruiter"]).proposeInterviewSlots(input);
    assert.equal(r.durationMinutes, 45);
    assert.equal(r.slots.length, 4, "maxSlotsOffered from settings");
    assert.equal(r.emptyReason, null);
    assert.deepEqual(
      r.panel.map((p) => p.hasAvailability),
      [true, true],
    );
    const custom = await staff(REC, ["recruiter"]).proposeInterviewSlots({
      ...input,
      durationMinutes: 30,
    });
    assert.equal(custom.durationMinutes, 30);

    // An unknown round is a BAD_REQUEST, not a crash.
    await expectCode(
      staff(REC, ["recruiter"]).proposeInterviewSlots({ applicationId: APP_A, roundNumber: 9 }),
      "BAD_REQUEST",
    );
  });

  it("4. can't attend: self only for a panellist, no swap; recruiter acts on their behalf", async () => {
    if (skip("4")) return;
    const start = Date.now() + 5 * DAY;
    await poolSql`
      INSERT INTO public.interviews
        (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
         scorecard_template, scheduled_start, scheduled_end, duration_minutes, mode,
         created_by_membership_id)
      VALUES (${IV_A}, ${T}, ${APP_A}, ${REQ}, 1, 'Panel round', 'scheduled', 'technical',
              ${new Date(start).toISOString()}::timestamptz,
              ${new Date(start + 45 * MIN).toISOString()}::timestamptz, 45, 'video', ${REC})
    `;
    await poolSql`
      INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
      VALUES (${T}, ${IV_A}, ${P1}, true), (${T}, ${IV_A}, ${P2}, false)
    `;
    const p1 = staff(P1, ["panel_member"]);
    await expectCode(
      p1.markPanelistCannotAttend({ interviewId: IV_A, membershipId: P2 }),
      "FORBIDDEN",
    );
    await expectCode(
      p1.markPanelistCannotAttend({ interviewId: IV_A, replacementMembershipId: ADMIN }),
      "FORBIDDEN",
    );
    // Not on the panel.
    await expectCode(
      staff(HRH, ["hr_head"]).markPanelistCannotAttend({ interviewId: IV_A }),
      "BAD_REQUEST",
    );
    const res = await staff(REC, ["recruiter"]).markPanelistCannotAttend({
      interviewId: IV_A,
      membershipId: P2,
      reason: "clash",
    });
    assert.ok(res.offerId);
    const listed = await staff(REC, ["recruiter"]).listSlotOffersByApplication({
      applicationId: APP_A,
    });
    assert.equal(listed.items[0]?.reason, "panelist_unavailable");
    assert.equal(listed.needsReschedule[0]?.interviewId, IV_A);
  });

  // ~12 sequential procedure calls, each a dozen-plus pooler round-trips
  // (offer view, availability, booking, audit). Measured ~80s on the shared
  // Supabase pooler with steady per-step progress — slow, not hung — so the
  // 60s default is too tight for this one test.
  it("5. candidate portal: own offers only, pick, reschedule allowance", async () => {
    if (skip("5")) return;
    const a = candidate(CAND_AUTH_A);
    const b = candidate(CAND_AUTH_B);

    // A's open offer is the PC-10 one from test 4.
    const mine = await a.candidateListMySlotOffers();
    assert.equal(mine.items.length, 1);
    const offer = mine.items[0]!;
    assert.equal(offer.reason, "panelist_unavailable");
    assert.ok(offer.slots.length > 0);
    assert.equal((await b.candidateListMySlotOffers()).items.length, 0);
    await expectCode(b.candidateGetSlotOffer({ offerId: offer.offerId }), "NOT_FOUND");
    await expectCode(
      b.candidatePickSlot({ offerId: offer.offerId, slotStart: offer.slots[0]!.start }),
      "NOT_FOUND",
    );

    const picked = await a.candidatePickSlot({
      offerId: offer.offerId,
      slotStart: offer.slots[0]!.start,
    });
    assert.equal(picked.scheduledStart, offer.slots[0]!.start);
    const [old] = await poolSql<
      { status: string }[]
    >`SELECT status FROM public.interviews WHERE id = ${IV_A}`;
    assert.equal(old?.status, "cancelled");

    // Reschedule the new round: allowance is 1 (test 1's settings).
    const listed = await a.candidateListMySlotOffers();
    assert.equal(listed.reschedulesRemaining[picked.interviewId], 1);
    const r1 = await a.candidateRequestReschedule({ interviewId: picked.interviewId });
    assert.ok(r1.offerId);
    assert.equal(r1.remainingReschedules, 0);
    // Asking again while that offer is open returns it — the allowance is not burnt twice.
    const r2 = await a.candidateRequestReschedule({ interviewId: picked.interviewId });
    assert.equal(r2.offerId, r1.offerId);
    // B cannot reschedule A's interview.
    await expectCode(
      b.candidateRequestReschedule({ interviewId: picked.interviewId }),
      "NOT_FOUND",
    );

    // Book it, then the allowance is spent.
    const booked = await a.candidatePickSlot({
      offerId: r1.offerId!,
      slotStart: r1.slots[0]!.start,
    });
    await expectCode(a.candidateRequestReschedule({ interviewId: booked.interviewId }), "CONFLICT");
  }, 180_000);
});
