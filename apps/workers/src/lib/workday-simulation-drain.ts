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
      child.info(
        { wid: (response as { workday_reference?: { wid?: string } }).workday_reference?.wid },
        "workday.simulated",
      );
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
