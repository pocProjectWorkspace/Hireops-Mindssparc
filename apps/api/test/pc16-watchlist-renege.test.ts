/**
 * PC-16 / PC-17 — watchlist role gates + the renege transition, through the
 * tRPC router (createCaller with synthetic contexts — no JWT).
 *
 *   1. Gates: panel_member → FORBIDDEN on watchlist / timeline / renege /
 *      settings; recruiter → FORBIDDEN on settings.
 *   2. Scope: admin and hr_head see every accepted-not-joined candidate; a
 *      recruiter sees only applications they own (recruiter B sees none, and
 *      gets NOT_FOUND on A's timeline and renege).
 *   3. Facts on the row: last sent, last pulse answer, open signal chip with
 *      the quote, missed check-ins.
 *   4. Renege: unknown reason → BAD_REQUEST; owner recruiter records it →
 *      offer 'reneged', application 'withdrawn' (+ transition), pre-boarding
 *      case cancelled, journey stopped, row leaves the watchlist and appears
 *      under reneged history; a second renege → CONFLICT.
 *   5. Ask-your-data "declined offers" includes the renege.
 *
 * Synthetic tenant (namespace 16b). REQUIRES migration 0128.
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
import { startPreJoiningJourney } from "../src/lib/pre-joining/journey";
import {
  ENABLED_IST,
  cleanupTenant,
  seedAcceptedCandidate,
  seedIds,
  seedTenant,
} from "./pc14-helpers";

/** Narrow away undefined/null, failing loudly (instead of a non-null assertion). */
function must<V>(v: V | null | undefined, what = "value"): V {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}

const ids = seedIds("16b");
const log = createLogger({ level: "error" });

function caller(roles: string[], userId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: ids.T,
    userId,
    roles,
    claims: { sub: userId, tid: ids.T, tenant_slug: "pc16", roles },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-pc16-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TRPCError) return err.code;
    throw err;
  }
  return "OK";
}

describe("PC-16/17 — joining watchlist + renege", () => {
  let A: Awaited<ReturnType<typeof seedAcceptedCandidate>>;
  let C: Awaited<ReturnType<typeof seedAcceptedCandidate>>;

  beforeAll(async () => {
    await seedTenant(ids, "16b", ENABLED_IST);
    const now = new Date();
    const day = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10);
    A = await seedAcceptedCandidate(ids, "0001", { joiningDate: day(40), acceptedAt: now });
    C = await seedAcceptedCandidate(ids, "0003", { joiningDate: day(70), acceptedAt: now });
    await poolSql`
      INSERT INTO public.onboarding_cases (tenant_id, application_id, candidate_id, status, geography_code, expected_start_date)
      VALUES (${ids.T}, ${A.app}, ${A.candidate}, 'pre_boarding', 'IN', ${day(40)}::date)
    `;
    const j = await startPreJoiningJourney(poolSql, { tenantId: ids.T, applicationId: A.app, log });
    assert.equal(j.created, true);
    // Facts: one sent check-in 5 days ago, unanswered (missed); one answered "no"; an open signal.
    const tps = await poolSql<{ id: string }[]>`
      SELECT id FROM public.pre_joining_touchpoints
      WHERE tenant_id = ${ids.T} AND application_id = ${A.app} AND carries_pulse
      ORDER BY scheduled_for LIMIT 2
    `;
    await poolSql`
      UPDATE public.pre_joining_touchpoints SET status = 'sent', sent_at = now() - interval '5 days'
      WHERE id = ${must(tps[0]).id}
    `;
    await poolSql`
      UPDATE public.pre_joining_touchpoints SET status = 'sent', sent_at = now() - interval '1 day'
      WHERE id = ${must(tps[1]).id}
    `;
    const [resp] = await poolSql<{ id: string }[]>`
      INSERT INTO public.pre_joining_pulse_responses (tenant_id, touchpoint_id, journey_id, application_id, on_track, comment)
      VALUES (${ids.T}, ${must(tps[1]).id}, ${j.journeyId}, ${A.app}, 'no', 'Got a counter offer.')
      RETURNING id
    `;
    await poolSql`
      INSERT INTO public.candidate_risk_signals (tenant_id, application_id, journey_id, signal_type, source, quote, pulse_response_id)
      VALUES (${ids.T}, ${A.app}, ${j.journeyId}, 'pulse_not_on_track', 'pulse_response', 'Got a counter offer.', ${must(resp).id})
    `;
  });

  afterAll(async () => {
    await cleanupTenant(ids);
    await poolSql.end({ timeout: 5 });
  });

  it("gates: panel_member is refused everywhere; recruiter is refused settings", async () => {
    const panel = caller(["panel_member"], ids.userP);
    assert.equal(await code(() => panel.listJoiningWatchlist({})), "FORBIDDEN");
    assert.equal(
      await code(() => panel.getEngagementTimeline({ applicationId: A.app })),
      "FORBIDDEN",
    );
    assert.equal(
      await code(() => panel.recordRenege({ applicationId: A.app, reasonCode: "personal" })),
      "FORBIDDEN",
    );
    assert.equal(await code(() => panel.getPreJoiningSettings({})), "FORBIDDEN");
    const rec = caller(["recruiter"], ids.userA);
    assert.equal(await code(() => rec.getPreJoiningSettings({})), "FORBIDDEN");
    assert.equal(await code(() => rec.listPreJoiningCompanyUpdates({})), "FORBIDDEN");
    const hr = caller(["hr_head"], ids.userH);
    assert.equal((await hr.getPreJoiningSettings({})).enabled, true);
  });

  it("scope: admin/hr_head see all; owner recruiter sees own; other recruiter sees none", async () => {
    const all = await caller(["admin"], ids.userH).listJoiningWatchlist({});
    assert.deepEqual(new Set(all.rows.map((r) => r.applicationId)), new Set([A.app, C.app]));
    const hr = await caller(["hr_head"], ids.userH).listJoiningWatchlist({});
    assert.equal(hr.rows.length, 2);
    const owner = await caller(["recruiter"], ids.userA).listJoiningWatchlist({});
    assert.equal(owner.rows.length, 2);
    const other = caller(["recruiter"], ids.userB);
    assert.equal((await other.listJoiningWatchlist({})).rows.length, 0);
    assert.equal(
      await code(() => other.getEngagementTimeline({ applicationId: A.app })),
      "NOT_FOUND",
    );
    assert.equal(
      await code(() => other.recordRenege({ applicationId: A.app, reasonCode: "personal" })),
      "NOT_FOUND",
    );
  });

  it("rows carry facts: last sent, last pulse answer, open signal with quote, missed check-ins", async () => {
    const out = await caller(["admin"], ids.userH).listJoiningWatchlist({});
    assert.equal(out.engagementEnabled, true);
    const a = must(out.rows.find((r) => r.applicationId === A.app));
    assert.equal(a.journeyStatus, "active");
    assert.ok(a.lastSentAt);
    assert.equal(a.lastPulseAnswer, "no");
    assert.equal(a.missedPulses, 1);
    assert.equal(a.openSignals.length, 1);
    assert.equal(a.openSignals[0]?.label, "Pulse: not on track");
    assert.equal(a.openSignals[0]?.quote, "Got a counter offer.");
    assert.ok(a.daysToJoining >= 39 && a.daysToJoining <= 41);
    const c = must(out.rows.find((r) => r.applicationId === C.app));
    assert.equal(c.journeyStatus, "none");
    assert.equal(c.openSignals.length, 0);
    assert.ok(!("score" in a) && !("risk" in a), "no score on the row, by design");

    const tl = await caller(["recruiter"], ids.userA).getEngagementTimeline({
      applicationId: A.app,
    });
    const kinds = new Set(tl.items.map((i) => i.kind));
    assert.ok(kinds.has("touchpoint") && kinds.has("pulse_response") && kinds.has("signal"));
  });

  it("renege: validates reason, flips offer/application/case/journey, moves to history, refuses twice", async () => {
    const rec = caller(["recruiter"], ids.userA);
    assert.equal(
      await code(() => rec.recordRenege({ applicationId: A.app, reasonCode: "not_a_reason" })),
      "BAD_REQUEST",
    );
    const r = await rec.recordRenege({
      applicationId: A.app,
      reasonCode: "counter_offer",
      notes: "Current employer matched.",
    });
    assert.equal(r.ok, true);

    const [offer] = await poolSql<
      { status: string }[]
    >`SELECT status FROM public.offers WHERE id = ${A.offer}`;
    assert.equal(offer?.status, "reneged");
    const [app] = await poolSql<{ current_stage: string; withdrawn_reason: string }[]>`
      SELECT current_stage::text, withdrawn_reason FROM public.applications WHERE id = ${A.app}
    `;
    assert.equal(app?.current_stage, "withdrawn");
    assert.equal(app?.withdrawn_reason, "Reneged: Accepted a counter-offer");
    const [tr] = await poolSql<
      { from_stage: string; to_stage: string; actor_membership_id: string }[]
    >`
      SELECT from_stage::text, to_stage::text, actor_membership_id FROM public.application_state_transitions
      WHERE tenant_id = ${ids.T} AND application_id = ${A.app} ORDER BY transitioned_at DESC LIMIT 1
    `;
    assert.deepEqual(tr, {
      from_stage: "offer_accepted",
      to_stage: "withdrawn",
      actor_membership_id: ids.REC_A,
    });
    const [oc] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.onboarding_cases WHERE tenant_id = ${ids.T} AND application_id = ${A.app}
    `;
    assert.equal(oc?.status, "cancelled");
    const [j] = await poolSql<{ status: string; stop_reason: string }[]>`
      SELECT status, stop_reason FROM public.pre_joining_journeys WHERE tenant_id = ${ids.T} AND application_id = ${A.app}
    `;
    assert.deepEqual(j, { status: "stopped", stop_reason: "reneged" });
    const [scheduled] = await poolSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM public.pre_joining_touchpoints
      WHERE tenant_id = ${ids.T} AND application_id = ${A.app} AND status = 'scheduled'
    `;
    assert.equal(scheduled?.n, 0);

    const out = await caller(["hr_head"], ids.userH).listJoiningWatchlist({});
    assert.ok(!out.rows.some((x) => x.applicationId === A.app));
    const hist = out.reneged.find((x) => x.applicationId === A.app);
    assert.equal(hist?.reasonLabel, "Accepted a counter-offer");
    assert.equal(hist?.notes, "Current employer matched.");

    assert.equal(
      await code(() => rec.recordRenege({ applicationId: A.app, reasonCode: "personal" })),
      "CONFLICT",
    );
  });

  it("Ask your data 'declined offers' lists the renege with its reason", async () => {
    const out = await caller(["admin"], ids.userH).askData({
      intent: "declined_offers",
      params: { period: "all_time" },
    });
    assert.equal(out.status, "answered");
    const rows = out.result?.rows ?? [];
    assert.ok(
      rows.some((r) => r.reason === "Reneged after accepting: Accepted a counter-offer"),
      JSON.stringify(rows),
    );
  });
});
