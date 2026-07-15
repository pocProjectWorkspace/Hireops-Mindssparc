import { randomUUID } from "node:crypto";
import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";

/**
 * Drains pending workday_sync_outbox rows. Wave 1 ALL simulations
 * succeed — we sleep 2-3s to feel like a real network call, then
 * write a deterministic mock response with an explicit
 * `simulation_notes` field so the Integration Health screen advertises
 * "this is not real".
 *
 * Mirrors the notification dispatcher's SKIP LOCKED claim pattern. Per
 * row try/catch so one malformed payload doesn't stall the batch (even
 * though there's no real failure path today — defensive for Phase 3).
 *
 * Status terminal: 'simulated'. The real Phase 3 connector will use
 * 'sent' instead. The Integration Health screen treats both as success.
 */

export interface SimulationDrainOpts {
  batchSize?: number;
  workerId?: string;
  log: Logger;
}

interface ClaimedSync {
  id: string;
  tenant_id: string;
  event_type: string;
  business_key: string;
  payload: Record<string, unknown>;
  attempt_count: number;
}

const DEFAULT_BATCH = 10;

/**
 * ONBOARD-06 — the Day-0 hire event type. Mirrors DAY_ZERO_HIRE_EVENT_TYPE in
 * apps/api/src/lib/onboarding-case.ts (kept as a literal here to avoid a
 * cross-package import). Its payload carries `onboarding_case_id`; after a
 * successful simulation we write the mock Worker ID back onto that case.
 */
const DAY_ZERO_HIRE_EVENT_TYPE = "hire_employee_day_zero";

export async function drainWorkdayOutboxOnce(opts: SimulationDrainOpts): Promise<{
  claimed: number;
  simulated: number;
  failed: number;
}> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const workerId = opts.workerId ?? `workday-sim-${randomUUID().slice(0, 8)}`;
  const log = opts.log;

  const rows = await poolSql<ClaimedSync[]>`
    UPDATE public.workday_sync_outbox
    SET status = 'processing', claimed_by = ${workerId}, claimed_at = now(),
        attempt_count = attempt_count + 1, last_attempt_at = now()
    WHERE id IN (
      SELECT id FROM public.workday_sync_outbox
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, event_type, business_key, payload, attempt_count
  `;

  if (rows.length === 0) return { claimed: 0, simulated: 0, failed: 0 };

  let simulated = 0;
  let failed = 0;

  for (const row of rows) {
    const child = log.child({
      workday_sync_id: row.id,
      tenant_id: row.tenant_id,
      event_type: row.event_type,
      business_key: row.business_key,
    });
    try {
      // Pause to feel like a Workday SOAP round-trip.
      await sleep(2000 + Math.floor(Math.random() * 1000));
      const response = generateMockWorkdayResponse(row.event_type, row.payload);
      await poolSql`
        UPDATE public.workday_sync_outbox
        SET status = 'simulated', simulated_at = now(),
            simulated_response = ${JSON.stringify(response)}::jsonb
        WHERE id = ${row.id}
      `;
      simulated += 1;
      const wid = (response as { workday_reference?: { wid?: string } }).workday_reference?.wid;
      child.info({ wid }, "workday.simulated");

      // ONBOARD-06 write-back: a hire event carrying an onboarding_case_id
      // stamps its mock Worker ID onto the case. Its own try/catch so a
      // write-back miss never un-simulates the (already committed) row.
      const caseId = (row.payload as { onboarding_case_id?: unknown }).onboarding_case_id;
      if (typeof caseId === "string" && caseId.length > 0 && typeof wid === "string") {
        try {
          const { written } = await writeBackWorkerIdForCase({
            tenantId: row.tenant_id,
            caseId,
            wid,
          });
          child.info(
            { onboarding_case_id: caseId, wid, written },
            written ? "workday.worker_id_written_back" : "workday.worker_id_already_linked",
          );
        } catch (wbErr) {
          const wbMsg = wbErr instanceof Error ? wbErr.message : String(wbErr);
          child.error(
            { err: wbMsg, onboarding_case_id: caseId },
            "workday.worker_id_writeback_failed",
          );
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await poolSql`
        UPDATE public.workday_sync_outbox
        SET status = 'failed', last_error = ${errMsg}
        WHERE id = ${row.id}
      `;
      failed += 1;
      child.error({ err: errMsg }, "workday.simulation_failed");
    }
  }
  return { claimed: rows.length, simulated, failed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * ONBOARD-06 — write the simulated Workday Worker ID back onto its onboarding
 * case. **Permanent linkage** (requirements.md §7.2): the tenant-scoped UPDATE
 * only fires while `workday_worker_id IS NULL`, so an already-linked case is
 * never overwritten by a later re-hire simulation. Returns whether a row was
 * written (`false` = already linked, or the case is gone / cross-tenant).
 */
export async function writeBackWorkerIdForCase(opts: {
  tenantId: string;
  caseId: string;
  wid: string;
}): Promise<{ written: boolean }> {
  const linked = await poolSql`
    UPDATE public.onboarding_cases
    SET workday_worker_id = ${opts.wid}, updated_at = now()
    WHERE tenant_id = ${opts.tenantId}
      AND id = ${opts.caseId}
      AND workday_worker_id IS NULL
    RETURNING id
  `;
  return { written: linked.length > 0 };
}

/**
 * Generates a plausibly-shaped Workday response. The honesty mechanism
 * is `simulation_notes` — anyone inspecting via the Integration Health
 * screen sees explicitly that this is a simulation, not real.
 *
 * Real Phase 3 connector REPLACES this with the actual SOAP-deserialised
 * response from Workday's REST/SOAP endpoint.
 */
export function generateMockWorkdayResponse(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (eventType === "hire_employee") {
    const preHire = (payload.pre_hire ?? {}) as { full_name?: string };
    const effectiveDate = payload.effective_date as string | undefined;
    return {
      status: "success",
      workday_reference: {
        type: "Pre-Hire",
        wid: randomUUID(),
        descriptor: `Pre-Hire: ${preHire.full_name ?? "Unknown"}`,
      },
      effective_date: effectiveDate ?? null,
      simulated_at: new Date().toISOString(),
      simulation_notes:
        "This is a simulated response. In production, this would be the actual Workday SOAP response.",
    };
  }
  if (eventType === DAY_ZERO_HIRE_EVENT_TYPE) {
    // Day-0 Hire_Employee: the pre-hire becomes an active Worker with a
    // permanent Worker ID. That `wid` is written back onto the onboarding case.
    const preHire = (payload.pre_hire ?? {}) as { full_name?: string };
    const effectiveDate = payload.effective_date as string | undefined;
    return {
      status: "success",
      workday_reference: {
        type: "Worker",
        wid: randomUUID(),
        descriptor: `Worker: ${preHire.full_name ?? "Unknown"}`,
      },
      effective_date: effectiveDate ?? null,
      simulated_at: new Date().toISOString(),
      simulation_notes:
        "This is a simulated response. In production, this would be the actual Workday SOAP response.",
    };
  }
  return {
    status: "success",
    workday_reference: {
      type: eventType,
      wid: randomUUID(),
      descriptor: `Simulated ${eventType}`,
    },
    simulated_at: new Date().toISOString(),
    simulation_notes:
      "This is a simulated response. In production, this would be the actual Workday SOAP response.",
  };
}
