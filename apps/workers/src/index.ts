// Load .env BEFORE any import that touches process.env at module init.
// Same dotenv-first discipline as the seed scripts.
import "./lib/env";

import { createLogger } from "@hireops/observability";
import { drainOutboxOnce, recoverOrphans } from "./lib/dispatcher";
import { runSchedulerTick, type ScheduledJob } from "./lib/scheduler";
import { slaImminentScan } from "./jobs/sla-imminent-scan";
import { drainWorkdayOutboxOnce } from "./lib/workday-simulation-drain";

/**
 * Worker entrypoint — three concurrent loops:
 *
 *   1. Outbox drain (5s) — primary path for queued notifications.
 *   2. Scheduler tick (60s) — kicks scheduled jobs based on their
 *      individual intervals (sla-imminent-scan: every 15 min).
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

const log = createLogger({ base: { service: "workers" } });

const SCHEDULED_JOBS: ScheduledJob[] = [
  {
    name: "sla_imminent_scan",
    intervalMs: 15 * 60_000,
    run: slaImminentScan,
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
