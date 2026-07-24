/**
 * Per-stage SLA thresholds in hours — the single source of truth.
 *
 * Consumers (so far):
 *   - apps/api: listCandidates composes a SQL CASE off this map for the
 *     slaBreachOnly filter + sla_breach sort
 *   - apps/workers: sla_imminent_scan flags applications in the
 *     [threshold - windowHours, threshold] window per recruiter
 *
 * `null` = stage has no SLA (terminal states + post-decision waits).
 *
 * Stage names come from the application_stage pgEnum
 * (packages/db/src/schema/application-stage.ts). The original Module 1b
 * ticket used three stage names that don't exist in the enum
 * (`recruiter_shortlist`, `hr_interview`, `offer_extended`); they were
 * mapped to the real values (`recruiter_review`, `hr_round`, no slot
 * for offer_extended because drafted goes directly to accepted/declined).
 *
 * Tenant-configurable thresholds (e.g. a `tenant_sla_configurations`
 * table) are Phase 3 work — when that lands, this constant becomes the
 * fallback for tenants without a custom config.
 */

import type { ApplicationStage } from "@hireops/db";

export const SLA_THRESHOLDS_HOURS: Record<ApplicationStage, number | null> = {
  application_received: 24,
  ai_screening: 1,
  recruiter_review: 48,
  shortlisted: 24,
  tech_interview: 72,
  hr_round: 48,
  offer_drafted: 24,
  offer_accepted: null,
  offer_declined: null,
  withdrawn: null,
  recruiter_rejected: null,
};

/**
 * Stages with a real (non-null) threshold. Useful for SQL WHERE clauses
 * that only consider breach-eligible rows.
 */
export const SLA_BREACH_STAGES: ApplicationStage[] = (
  Object.entries(SLA_THRESHOLDS_HOURS) as [ApplicationStage, number | null][]
)
  .filter(([, hours]) => hours !== null)
  .map(([stage]) => stage);

/**
 * Returns the threshold for a stage, or Infinity when terminal (callers
 * should test `Number.isFinite`).
 */
export function thresholdHoursFor(stage: ApplicationStage): number {
  const t = SLA_THRESHOLDS_HOURS[stage];
  return t === null ? Number.POSITIVE_INFINITY : t;
}

/** Upper bound for a per-stage override (one year of hours). */
const MAX_THRESHOLD_HOURS = 8760;

/**
 * T4.1 — resolve a tenant's stored SLA-threshold overrides over the code
 * defaults, returning a COMPLETE per-stage map. This is the single resolver
 * shared by the api (breach filter/sort, urgency, governance) AND the workers
 * imminent-alert scan, so it is a PLAIN TS merge with NO zod dependency (the
 * worker must be able to import it without pulling api-types).
 *
 * Merge discipline (mirrors resolveSystemSetup / resolveShortlistDefaults):
 *   - Start from SLA_THRESHOLDS_HOURS — the guaranteed fallback its own header
 *     comment predicted this ticket would make it.
 *   - Only NON-terminal stages (those with a real default) are overridable.
 *     Terminal stages stay `null` always; a terminal override is ignored.
 *   - For each overridable stage present in `raw`: a finite number in
 *     (0, 8760] wins; an explicit `null` disables that stage's SLA; anything
 *     else (out of range, wrong type, absent) falls back to the default.
 *   - Unknown keys are ignored.
 *   - Never throws — malformed input (non-object, array, null) yields the full
 *     default map, so an unconfigured or corrupt tenant is byte-identical to
 *     today.
 */
export function resolveSlaThresholds(raw: unknown): Record<ApplicationStage, number | null> {
  const out: Record<ApplicationStage, number | null> = { ...SLA_THRESHOLDS_HOURS };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  for (const [stage, def] of Object.entries(SLA_THRESHOLDS_HOURS) as [
    ApplicationStage,
    number | null,
  ][]) {
    // Terminal stages are never overridable — they stay null.
    if (def === null) continue;
    if (!(stage in obj)) continue;
    const v = obj[stage];
    if (v === null) {
      out[stage] = null;
      continue;
    }
    if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_THRESHOLD_HOURS) {
      out[stage] = v;
    }
    // Anything else: leave the default in place.
  }
  return out;
}
