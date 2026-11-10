/**
 * PC-14 / PC-17 — pre-joining journey + touchpoint drain against a real DB.
 *
 *   1. Journey start is idempotent and gated: disabled tenant → nothing;
 *      enabled → one journey, touchpoints planned to the joining date; a
 *      second start adds nothing.
 *   2. The drain sends a due touchpoint ONCE: one notification_outbox row
 *      (candidate-scoped, template key per step, reply-to token, pulse link),
 *      touchpoint 'sent'; a second pass — and a replayed claim — sends nothing
 *      more. Future touchpoints are untouched.
 *   3. company_update picks the next unsent active update; none left → skipped.
 *   4. Renege (PC-17) stops the journey: scheduled touchpoints cancelled, and
 *      a draining pass sends nothing for that candidate.
 *
 * Synthetic tenant (namespace 14d), raw poolSql. REQUIRES migration 0128.
 * The drain claims across tenants (service role), so assertions are on THIS
 * tenant's rows only.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { startPreJoiningJourney } from "../src/lib/pre-joining/journey";
import { recordRenege } from "../src/lib/pre-joining/watchlist";
import { drainPreJoiningTouchpointsOnce } from "../../../apps/workers/src/lib/pre-joining-drain.js";
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

const ids = seedIds("14d");
const log = createLogger({ base: { service: "pc14-drain-test" } });

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface TpRow {
  id: string;
  step_key: string;
  status: string;
  scheduled_for: Date;
  notification_outbox_id: string | null;
  pulse_token_hash: string | null;
  company_update_id: string | null;
  skip_reason: string | null;
}

async function touchpoints(app: string): Promise<TpRow[]> {
  return poolSql<TpRow[]>`
    SELECT id, step_key, status, scheduled_for, notification_outbox_id, pulse_token_hash,
           company_update_id, skip_reason
    FROM public.pre_joining_touchpoints
    WHERE tenant_id = ${ids.T} AND application_id = ${app}
    ORDER BY scheduled_for, step_key
  `;
}

async function outboxFor(candidate: string) {
  return poolSql<{ id: string; template_key: string; template_data: Record<string, unknown> }[]>`
    SELECT id, template_key, template_data FROM public.notification_outbox
    WHERE tenant_id = ${ids.T} AND recipient_candidate_id = ${candidate}
    ORDER BY created_at
  `;
}

/** Make every touchpoint of this app of `step` due now. */
async function makeDue(app: string, step: string): Promise<void> {
  await poolSql`
    UPDATE public.pre_joining_touchpoints
    SET scheduled_for = now() - interval '1 minute'
    WHERE tenant_id = ${ids.T} AND application_id = ${app} AND step_key = ${step}
      AND status = 'scheduled'
  `;
}

/** Drain until nothing of ours is due (other tenants' rows may share passes). */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const r = await drainPreJoiningTouchpointsOnce({ log, batchSize: 50 });
    if (r.claimed === 0) break;
  }
}

describe("PC-14 — pre-joining journey + drain", () => {
  const now = new Date();
  let A: Awaited<ReturnType<typeof seedAcceptedCandidate>>;
  let B: Awaited<ReturnType<typeof seedAcceptedCandidate>>;

  beforeAll(async () => {
    process.env.PRE_JOINING_REPLY_DOMAIN = "in.example.test";
    await seedTenant(ids, "14d", { preJoiningEngagement: { enabled: false } });
    A = await seedAcceptedCandidate(ids, "0001", {
      joiningDate: isoDay(addDays(now, 60)),
      acceptedAt: now,
    });
    B = await seedAcceptedCandidate(ids, "0002", {
      joiningDate: isoDay(addDays(now, 45)),
      acceptedAt: now,
    });
  });

  afterAll(async () => {
    await cleanupTenant(ids);
    await poolSql.end({ timeout: 5 });
  });

  it("does nothing while the tenant has engagement off (platform default)", async () => {
    const r = await startPreJoiningJourney(poolSql, { tenantId: ids.T, applicationId: A.app, log });
    assert.equal(r.created, false);
    assert.equal(r.skipped, "disabled");
    assert.equal((await touchpoints(A.app)).length, 0);
  });

  it("starts one journey with touchpoints up to the joining date; restart is a no-op", async () => {
    await poolSql`
      UPDATE public.tenants SET settings = ${JSON.stringify(ENABLED_IST)}::jsonb WHERE id = ${ids.T}
    `;
    const r1 = await startPreJoiningJourney(poolSql, {
      tenantId: ids.T,
      applicationId: A.app,
      log,
    });
    assert.equal(r1.created, true);
    assert.ok(r1.planned >= 5, `planned ${r1.planned}`);
    const tps = await touchpoints(A.app);
    assert.equal(tps.length, r1.planned);
    const keys = new Set(tps.map((t) => t.step_key));
    for (const k of ["welcome", "pulse", "company_update", "two_weeks_to_go", "one_week_to_go"]) {
      assert.ok(keys.has(k), `missing ${k}`);
    }
    const joinT = addDays(now, 60).getTime();
    assert.ok(tps.every((t) => new Date(t.scheduled_for).getTime() < joinT));

    const r2 = await startPreJoiningJourney(poolSql, {
      tenantId: ids.T,
      applicationId: A.app,
      log,
    });
    assert.equal(r2.created, false);
    assert.equal(r2.skipped, "exists");
    assert.equal((await touchpoints(A.app)).length, tps.length);
  });

  it("sends the due welcome + a pulse exactly once, with reply-to token and pulse link", async () => {
    await makeDue(A.app, "pulse");
    await drain();
    const after1 = await touchpoints(A.app);
    const welcome = after1.find((t) => t.step_key === "welcome");
    assert.equal(welcome?.status, "sent");
    const sentPulses = after1.filter((t) => t.step_key === "pulse" && t.status === "sent");
    assert.ok(sentPulses.length >= 1);
    assert.ok(sentPulses.every((p) => p.pulse_token_hash && p.notification_outbox_id));
    // Future, not-yet-due steps untouched.
    assert.ok(
      after1.filter((t) => t.step_key === "one_week_to_go").every((t) => t.status === "scheduled"),
    );

    const out1 = await outboxFor(A.candidate);
    const keys = out1.map((o) => o.template_key).sort();
    assert.ok(keys.includes("candidate.pre_joining_welcome"));
    assert.ok(keys.includes("candidate.pre_joining_pulse"));
    assert.equal(out1.length, 1 + sentPulses.length);
    const pulse = out1.find((o) => o.template_key === "candidate.pre_joining_pulse");
    assert.match(String(pulse?.template_data.pulseUrl), /\/pulse\/[^/]+\.[^/]+$/);
    assert.match(String(pulse?.template_data.replyTo), /^replies\+[a-f0-9]{32}@in\.example\.test$/);

    // Idempotent: another pass sends nothing more…
    await drain();
    assert.equal((await outboxFor(A.candidate)).length, out1.length);

    // …and a replayed claim (row forced back to 'scheduled' as if the worker
    // died after enqueueing) reuses the same outbox row via the dedup key.
    const target = must(sentPulses[0]);
    await poolSql`
      UPDATE public.pre_joining_touchpoints
      SET status = 'scheduled', scheduled_for = now() - interval '1 minute'
      WHERE id = ${target.id}
    `;
    await drain();
    const out2 = await outboxFor(A.candidate);
    assert.equal(out2.length, out1.length, "replay must not create a second email");
    const [replayed] = await poolSql<
      { status: string; notification_outbox_id: string | null; pulse_token_hash: string | null }[]
    >`
      SELECT status, notification_outbox_id, pulse_token_hash FROM public.pre_joining_touchpoints WHERE id = ${target.id}
    `;
    assert.equal(replayed?.status, "sent");
    assert.equal(replayed?.notification_outbox_id, target.notification_outbox_id);
    assert.equal(
      replayed?.pulse_token_hash,
      target.pulse_token_hash,
      "the emailed link stays valid",
    );
  });

  it("company_update sends the next unsent update; none left → skipped", async () => {
    const [u1] = await poolSql<{ id: string }[]>`
      INSERT INTO public.pre_joining_company_updates (tenant_id, title, body, sort_order)
      VALUES (${ids.T}, 'New Pune office', 'We moved in last week.', 1) RETURNING id
    `;
    const cus = (await touchpoints(A.app)).filter((t) => t.step_key === "company_update");
    assert.ok(cus.length >= 2, "need two company_update touchpoints");
    await poolSql`
      UPDATE public.pre_joining_touchpoints SET scheduled_for = now() - interval '1 minute'
      WHERE id = ${must(cus[0]).id}
    `;
    await drain();
    await poolSql`
      UPDATE public.pre_joining_touchpoints SET scheduled_for = now() - interval '1 minute'
      WHERE id = ${must(cus[1]).id}
    `;
    await drain();
    const after = await touchpoints(A.app);
    const first = after.find((t) => t.id === must(cus[0]).id);
    const second = after.find((t) => t.id === must(cus[1]).id);
    assert.equal(first?.status, "sent");
    assert.equal(first?.company_update_id, must(u1).id);
    assert.equal(second?.status, "skipped");
    assert.equal(second?.skip_reason, "no_company_update");
    const out = await outboxFor(A.candidate);
    const cu = out.find((o) => o.template_key === "candidate.pre_joining_company_update");
    assert.equal(cu?.template_data.updateTitle, "New Pune office");
  });

  it("renege stops the journey: scheduled touchpoints cancelled, nothing further sent", async () => {
    const started = await startPreJoiningJourney(poolSql, {
      tenantId: ids.T,
      applicationId: B.app,
      log,
    });
    assert.equal(started.created, true);
    await drain(); // sends B's welcome
    const sentBefore = (await outboxFor(B.candidate)).length;
    assert.equal(sentBefore, 1);

    const r = await recordRenege(poolSql, {
      tenantId: ids.T,
      membershipId: ids.REC_A,
      input: {
        applicationId: B.app,
        reasonCode: "counter_offer",
        notes: "Matched by current employer",
      },
      log,
    });
    assert.equal(r.ok, true);
    const tps = await touchpoints(B.app);
    assert.ok(tps.filter((t) => t.step_key !== "welcome").every((t) => t.status === "cancelled"));
    const [j] = await poolSql<{ status: string; stop_reason: string }[]>`
      SELECT status, stop_reason FROM public.pre_joining_journeys
      WHERE tenant_id = ${ids.T} AND application_id = ${B.app}
    `;
    assert.deepEqual(j, { status: "stopped", stop_reason: "reneged" });

    // Even a touchpoint forced due is not sent for a stopped journey.
    await poolSql`
      UPDATE public.pre_joining_touchpoints SET status = 'scheduled', scheduled_for = now() - interval '1 minute'
      WHERE tenant_id = ${ids.T} AND application_id = ${B.app} AND step_key = 'pulse'
    `;
    await drain();
    assert.equal((await outboxFor(B.candidate)).length, sentBefore);
    assert.ok(
      (await touchpoints(B.app))
        .filter((t) => t.step_key === "pulse")
        .every((t) => t.status === "cancelled"),
    );
  });
});
