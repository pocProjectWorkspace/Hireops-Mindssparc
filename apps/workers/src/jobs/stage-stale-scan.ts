import { sql as poolSql, StageStaleTriggerConfigSchema } from "@hireops/db";
import type { Logger } from "@hireops/observability";

/**
 * Scan every tenant for applications that have sat in a stage past the
 * per-agent days_threshold and enqueue one follow-up agent run per
 * matching (agent, application). This is what fires the follow-ups
 * wedge automatically — before this job, tests hand-fed
 * agent_run_outbox (see agent-vertical-smoke step 2). The existing
 * agent-run drain picks the row up, creates the run, executes actions,
 * and halts at the draft_message approval gate.
 *
 * Why the worker, not the api: this is cross-tenant batch work; the api
 * is request-scoped + tenant-scoped via RLS. Uses poolSql (service_role)
 * for the cross-tenant join, exactly like sla-imminent-scan.ts — see its
 * header for the why.
 *
 * Enqueue contract: one INSERT into agent_run_outbox
 *   (tenant_id, agent_id, trigger_context jsonb, status 'pending').
 * trigger_context MUST carry application_id (string) — draft-message.ts
 * throws MissingTriggerContextError without it.
 *
 * Dedup (critical — this scan runs every 15 min): skip any application
 * that already has ANY agent_run_outbox row for the same agent whose
 * trigger_context->>'application_id' matches — one follow-up run per
 * (agent, application), ever. The NOT EXISTS lives inside the same
 * INSERT..SELECT statement, so it is race-safe against the scan
 * re-running (a prior tick's rows are visible to the next tick's probe).
 *
 * Config: the stored trigger_config jsonb omits the `type` field (the
 * trigger_type column is the discriminator source of truth — same
 * convention as bridgeActionConfig). We prepend `type: 'stage_stale'`
 * before validating with StageStaleTriggerConfigSchema. A malformed
 * config log.warns and skips — one bad agent never breaks the scan.
 */

interface TriggerPairRow {
  agent_id: string;
  tenant_id: string;
  trigger_config: Record<string, unknown>;
}

export async function stageStaleScan(log: Logger): Promise<void> {
  // Eligible (agent, trigger) pairs: stage_stale triggers on
  // enabled, non-retired agents. Cross-tenant, service-role.
  const pairs = await poolSql<TriggerPairRow[]>`
    SELECT
      t.agent_id::text AS agent_id,
      t.tenant_id::text AS tenant_id,
      t.trigger_config AS trigger_config
    FROM public.agent_triggers t
    JOIN public.automation_agents aa
      ON aa.id = t.agent_id AND aa.tenant_id = t.tenant_id
    WHERE t.trigger_type = 'stage_stale'
      AND aa.enabled = true
      AND aa.retired_at IS NULL
  `;

  let agentsScanned = 0;
  let applicationsMatched = 0;
  let runsEnqueued = 0;

  for (const pair of pairs) {
    const parsed = StageStaleTriggerConfigSchema.safeParse({
      type: "stage_stale",
      ...pair.trigger_config,
    });
    if (!parsed.success) {
      log.warn(
        { agent_id: pair.agent_id, err: parsed.error.message },
        "stage_stale_scan.invalid_config",
      );
      continue;
    }
    agentsScanned += 1;
    const { stage, days_threshold } = parsed.data;

    // Match stale applications in the agent's tenant and enqueue in a
    // single statement. The CTE surfaces the matched count (pre-dedup)
    // alongside the enqueued count (post-dedup) without a second query.
    try {
      const [counts] = await poolSql<{ matched: number; enqueued: number }[]>`
        WITH matched AS (
          SELECT app.id
          FROM public.applications app
          WHERE app.tenant_id = ${pair.tenant_id}::uuid
            -- ::text compare, not enum: current_stage is the
            -- application_stage enum, but the configured stage is a free
            -- string. A stage that is not a valid enum label must match
            -- zero rows, not throw (else a misconfigured agent errors the
            -- whole tenant's scan every tick).
            AND app.current_stage::text = ${stage}
            AND app.stage_entered_at < now() - make_interval(days => ${days_threshold})
        ),
        inserted AS (
          INSERT INTO public.agent_run_outbox
            (tenant_id, agent_id, trigger_context, status)
          SELECT
            ${pair.tenant_id}::uuid,
            ${pair.agent_id}::uuid,
            jsonb_build_object(
              'application_id', m.id::text,
              'trigger', 'stage_stale',
              'stage', ${stage}::text
            ),
            'pending'
          FROM matched m
          WHERE NOT EXISTS (
            SELECT 1 FROM public.agent_run_outbox o
            WHERE o.tenant_id = ${pair.tenant_id}::uuid
              AND o.agent_id = ${pair.agent_id}::uuid
              AND o.trigger_context->>'application_id' = m.id::text
          )
          RETURNING id
        )
        SELECT
          (SELECT count(*) FROM matched)::int AS matched,
          (SELECT count(*) FROM inserted)::int AS enqueued
      `;
      applicationsMatched += counts?.matched ?? 0;
      runsEnqueued += counts?.enqueued ?? 0;
    } catch (err) {
      // One bad tenant's query must not break the whole scan. The next
      // tick re-tries because the match predicate stays true.
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, agent_id: pair.agent_id, tenant_id: pair.tenant_id },
        "stage_stale_scan.enqueue_error",
      );
    }
  }

  log.info({ agentsScanned, applicationsMatched, runsEnqueued }, "stage_stale_scan.complete");
}
