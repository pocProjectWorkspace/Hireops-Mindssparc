import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";

/**
 * Tiny scheduled-job framework. Each job has a name + interval. The
 * scheduler ticks every checkIntervalMs and runs jobs whose
 * last_run_at is older than their interval (UPSERTed into
 * scheduled_job_runs after each run).
 *
 * Why not node-cron / bullmq: at Wave-1 scale (single worker, three
 * jobs) a polling tick with last-run bookkeeping is enough, and it
 * stays correct across worker restarts (the row in
 * scheduled_job_runs survives). Replace with a real scheduler when
 * we add more jobs or need cron-level expressiveness.
 *
 * Concurrency: we hold a NO-OP advisory lock per job-name during the
 * run so two workers can't pile up. Wave 1 runs one worker; the lock
 * is cheap insurance.
 */

export interface ScheduledJob {
  name: string;
  intervalMs: number;
  run: (log: Logger) => Promise<void>;
}

export interface RunSchedulerTickOpts {
  jobs: ScheduledJob[];
  log: Logger;
  /**
   * Optional override of `now`. Used by tests to advance time.
   */
  now?: () => Date;
}

interface LastRunRow {
  job_name: string;
  last_run_at: Date;
}

export async function runSchedulerTick(opts: RunSchedulerTickOpts): Promise<{ ran: string[] }> {
  const now = opts.now?.() ?? new Date();
  const ran: string[] = [];

  const lastRuns = await poolSql<LastRunRow[]>`
    SELECT job_name, last_run_at FROM public.scheduled_job_runs
  `;
  // postgres-js returns timestamps as Date sometimes and strings other times
  // depending on parser config; coerce defensively.
  const lastRunMap = new Map<string, Date>(
    lastRuns.map((r) => [r.job_name, r.last_run_at instanceof Date ? r.last_run_at : new Date(r.last_run_at as unknown as string)]),
  );

  for (const job of opts.jobs) {
    const lastRun = lastRunMap.get(job.name);
    if (lastRun && now.getTime() - lastRun.getTime() < job.intervalMs) continue;

    // Advisory lock — hash the job name so it fits in a bigint.
    const lockKey = hashJobName(job.name);
    const lockRows = await poolSql<{ obtained: boolean }[]>`
      SELECT pg_try_advisory_lock(${lockKey}) AS obtained
    `;
    const obtained = lockRows[0]?.obtained ?? false;
    if (!obtained) {
      opts.log.debug({ job: job.name }, "scheduler.skip_locked");
      continue;
    }

    const jobLog = opts.log.child({ job: job.name });
    const t0 = Date.now();
    let status: "ok" | "error" = "ok";
    let errorMsg: string | null = null;
    try {
      await job.run(jobLog);
    } catch (err) {
      status = "error";
      errorMsg = err instanceof Error ? err.message : String(err);
      jobLog.error({ err: errorMsg }, "scheduler.job_error");
    } finally {
      const duration = Date.now() - t0;
      await poolSql`
        INSERT INTO public.scheduled_job_runs
          (job_name, last_run_at, last_run_duration_ms, last_run_status, last_run_error)
        VALUES (${job.name}, ${now.toISOString()}, ${duration}, ${status}, ${errorMsg})
        ON CONFLICT (job_name) DO UPDATE
          SET last_run_at = EXCLUDED.last_run_at,
              last_run_duration_ms = EXCLUDED.last_run_duration_ms,
              last_run_status = EXCLUDED.last_run_status,
              last_run_error = EXCLUDED.last_run_error
      `;
      await poolSql`SELECT pg_advisory_unlock(${lockKey})`;
      ran.push(job.name);
    }
  }
  return { ran };
}

function hashJobName(name: string): number {
  // 32-bit FNV-1a, mapped to a positive int. Plenty of space for
  // Wave 1's handful of jobs; collisions just mean the two would
  // serialise, which is harmless.
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
