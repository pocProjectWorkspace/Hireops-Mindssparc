// Load .env BEFORE any import that touches process.env at module init.
// Same dotenv-first discipline as the seed scripts.
import "./lib/env";

import { createLogger } from "@hireops/observability";
import { drainOutboxOnce, recoverOrphans } from "./lib/dispatcher";
import { runSchedulerTick, type ScheduledJob } from "./lib/scheduler";
import { slaImminentScan } from "./jobs/sla-imminent-scan";
import { stageStaleScan } from "./jobs/stage-stale-scan";
import { aiBudgetScan } from "./jobs/ai-budget-scan";
import { ownershipClaimSweep } from "./jobs/ownership-claim-sweep";
import { reportDigestScan } from "./jobs/report-digest-scan";
import { interviewMediaPurgeSweep } from "./jobs/interview-media-purge";
import { drainWorkdayOutboxOnce } from "./lib/workday-simulation-drain";
import { drainAiScoreOutboxOnce } from "./lib/ai-score-drain";
import { drainAgentRunOutboxOnce } from "./lib/agent-run-drain";
import { drainTranscriptOutboxOnce } from "./lib/transcript-drain";

/**
 * Worker entrypoint — three concurrent loops:
 *
 *   1. Outbox drain (5s) — primary path for queued notifications.
 *   2. Scheduler tick (60s) — kicks scheduled jobs based on their
 *      individual intervals (sla-imminent-scan + stage-stale-scan,
 *      each every 15 min).
 *   3. Orphan recovery (5 min) — re-queues rows stuck in 'processing'.
 *
 * Graceful shutdown on SIGINT/SIGTERM: stop the tick loops, wait for
 * any in-flight drain to finish, then exit 0.
 *
 * Single-instance assumption (Wave 1). The dispatcher's SKIP LOCKED
 * + the scheduler's advisory lock make multi-instance safe-by-construction
 * when we scale out.
 */

const DRAIN_INTERVAL_MS = 5_000;
const SCHEDULER_INTERVAL_MS = 60_000;
const ORPHAN_INTERVAL_MS = 5 * 60_000;
const WORKDAY_DRAIN_INTERVAL_MS = 5_000;
const AI_SCORE_DRAIN_INTERVAL_MS = 5_000;
const AGENT_RUN_DRAIN_INTERVAL_MS = 5_000;
/**
 * N3.3a transcript drain — 60s, twelve times slower than every other drain.
 *
 * Deliberate. A transcript is not latency-sensitive (nobody is watching a
 * spinner; the panellist reads it after the interview), and the work itself
 * takes MINUTES because the ASR vendor is asynchronous — 2–5 minutes expected,
 * 20 minutes worst case. A 5s tick would poll the same table sixty times
 * during a single transcription for nothing. 60s adds at most a minute to a
 * multi-minute job, under 2% of the expected path, and it matches the
 * scheduler's own cadence. See the lease constants in transcript-drain.ts for
 * the other half of this: the claim lease is 30 minutes and the orphan sweep
 * 45, because a premature reclaim gets the same audio transcribed — and
 * BILLED — twice.
 */
const TRANSCRIPT_DRAIN_INTERVAL_MS = 60_000;

const log = createLogger({ base: { service: "workers" } });

const SCHEDULED_JOBS: ScheduledJob[] = [
  {
    name: "sla_imminent_scan",
    intervalMs: 15 * 60_000,
    run: slaImminentScan,
  },
  {
    name: "stage_stale_scan",
    intervalMs: 15 * 60_000,
    run: stageStaleScan,
  },
  {
    // T5.1 / G24 — sum each tenant's month-to-date AI spend and email
    // configured recipients once per crossed budget-threshold percent. 60-min
    // cadence: AI spend accrues slowly, so a tighter tick just re-scans the
    // same MTD totals. Alerting only — never blocks an AI call (T5.1b deferred).
    name: "ai_budget_scan",
    intervalMs: 60 * 60_000,
    run: aiBudgetScan,
  },
  {
    // P0.3 — flip past-expiry ACTIVE ownership claims to 'expired'. The
    // partial unique index can't test expires_at itself (no now() in a
    // partial-index predicate), so without this sweep an expired claim
    // blocks that candidate's re-submission forever. 15-min cadence, same
    // as the two scans above.
    name: "ownership_claim_sweep",
    intervalMs: 15 * 60_000,
    run: ownershipClaimSweep,
  },
  {
    // R1.5a — email opted-in tenants the executive board-pack headline numbers
    // for the period that just closed (last ISO week / last calendar month).
    //
    // 30-min tick, which is far coarser than the thing it is watching for (one
    // send per week or per month) and deliberately so: the job's only job is to
    // notice that a period closed and the configured send hour has passed. A
    // tighter tick would re-read the same closed window for nothing.
    //
    // A MISSED TICK SELF-HEALS. The dedup key names the closed PERIOD, not the
    // tick, so a worker that is down through the send hour still sends on its
    // next tick — once, because the outbox's (tenant_id, dedup_key) unique
    // rejects the duplicate. There is no digest table and nothing to reconcile.
    name: "report_digest_scan",
    intervalMs: 30 * 60_000,
    run: reportDigestScan,
  },
  {
    // N3.RET — delete interview audio past its retention window. The client's
    // decision: audio is kept 30 days from interview completion, transcripts
    // and notes are kept indefinitely. A hard 90-day ceiling from the
    // recording's own created_at is the backstop for rounds that never reach a
    // terminal state (no-shows especially — markInterviewNoShow is not stamped
    // and 0115 added no no_show_at), because without it "we keep audio for 30
    // days" would be false for exactly the rounds nobody is watching.
    //
    // DAILY. Purging is not time-critical and the windows are measured in
    // weeks, so a tighter tick would re-scan the same rows to no purpose. A
    // SCHEDULED job rather than a drain loop, like ownership_claim_sweep: this
    // is a time-based sweep with no queue behind it, and the 8th startLoop is
    // not a thing to add while the worker-registry refactor is already owed.
    name: "interview_media_purge",
    intervalMs: 24 * 60 * 60_000,
    run: interviewMediaPurgeSweep,
  },
];

interface RunningLoop {
  timer: NodeJS.Timeout;
  inFlight: Promise<void> | null;
}

function noop(): void {
  // intentional
}

const loops: RunningLoop[] = [];
let shuttingDown = false;

function startLoop(name: string, intervalMs: number, work: () => Promise<void>): RunningLoop {
  // Placeholder timer overwritten by setInterval below — keeps the
  // shape happy without a separate nullable field.
  const loop: RunningLoop = { timer: setInterval(noop, 1 << 30), inFlight: null };
  clearInterval(loop.timer);
  const tick = async () => {
    if (shuttingDown) return;
    if (loop.inFlight) return;
    loop.inFlight = work().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ loop: name, err: msg }, "worker.loop_error");
    });
    try {
      await loop.inFlight;
    } finally {
      loop.inFlight = null;
    }
  };
  loop.timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Fire once immediately so the worker doesn't sit idle for intervalMs on boot.
  void tick();
  return loop;
}

async function main() {
  log.info("worker.starting");

  loops.push(
    startLoop("drain", DRAIN_INTERVAL_MS, async () => {
      const r = await drainOutboxOnce({ log });
      if (r.claimed > 0) {
        log.info(r, "worker.drain_pass");
      }
    }),
  );

  loops.push(
    startLoop("scheduler", SCHEDULER_INTERVAL_MS, async () => {
      const r = await runSchedulerTick({ jobs: SCHEDULED_JOBS, log });
      if (r.ran.length > 0) {
        log.info({ ran: r.ran }, "worker.scheduler_tick");
      }
    }),
  );

  loops.push(
    startLoop("orphan-recovery", ORPHAN_INTERVAL_MS, async () => {
      const recovered = await recoverOrphans();
      if (recovered > 0) {
        log.warn({ recovered }, "worker.orphans_recovered");
      }
    }),
  );

  loops.push(
    startLoop("workday-simulation-drain", WORKDAY_DRAIN_INTERVAL_MS, async () => {
      const r = await drainWorkdayOutboxOnce({ log });
      if (r.claimed > 0) {
        log.info(r, "worker.workday_drain_pass");
      }
    }),
  );

  // AI-03 fit-scoring drain. Same SKIP LOCKED + small batch pattern;
  // each row costs a real Anthropic call so the default batch is
  // smaller than the notification drain (5 vs 25).
  loops.push(
    startLoop("ai-score-drain", AI_SCORE_DRAIN_INTERVAL_MS, async () => {
      const r = await drainAiScoreOutboxOnce({ log });
      if (r.claimed > 0) {
        log.info(r, "worker.ai_score_drain_pass");
      }
    }),
  );

  // AGENT-02 agent-run drain. Same SKIP LOCKED pattern; default batch of
  // 1 because each row does N writes (run + run_actions + maybe approval
  // request) and we'd rather have small fast passes than long lock windows.
  // Registered here ad-hoc per the existing convention; worker registry
  // refactor pending per open-questions #26 (triggers at worker #7).
  loops.push(
    startLoop("agent-run-drain", AGENT_RUN_DRAIN_INTERVAL_MS, async () => {
      const r = await drainAgentRunOutboxOnce({ log });
      if (r.claimed > 0) {
        log.info(r, "worker.agent_run_drain_pass");
      }
    }),
  );

  // N3.3a transcript drain — media → transcript, transcription only (note
  // generation is N3.3b). Slow interval + long lease; both are explained at
  // TRANSCRIPT_DRAIN_INTERVAL_MS above and at the constants in
  // transcript-drain.ts. Default batch is 1, so a pass claims exactly the row
  // it is about to work on and the lease clock is the work clock. The orphan
  // sweep runs inside the same pass rather than in the notification drain's
  // 5-minute recovery loop, because its threshold (45 min) has nothing to do
  // with that loop's (5 min).
  //
  // This is the 7th startLoop registration, which is the trigger open-question
  // #26 named for the worker-registry refactor (see the agent-run-drain note
  // above). Registered ad-hoc here to keep N3.3a to one concern; the refactor
  // is now owed.
  loops.push(
    startLoop("transcript-drain", TRANSCRIPT_DRAIN_INTERVAL_MS, async () => {
      const r = await drainTranscriptOutboxOnce({ log });
      if (r.claimed > 0 || r.recovered > 0) {
        log.info(r, "worker.transcript_drain_pass");
      }
    }),
  );

  log.info({ loops: loops.length }, "worker.ready");
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "worker.shutdown_begin");

  for (const loop of loops) clearInterval(loop.timer);
  for (const loop of loops) {
    if (loop.inFlight) await loop.inFlight.catch(() => undefined);
  }

  log.info("worker.shutdown_complete");
  process.exit(0);
}

process.on("SIGINT", (s) => void shutdown(s));
process.on("SIGTERM", (s) => void shutdown(s));

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error({ err: msg }, "worker.fatal");
  process.exit(1);
});
