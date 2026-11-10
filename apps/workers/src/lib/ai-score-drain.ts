/**
 * Drains pending ai_score_outbox rows (AI-03).
 *
 * Mirrors notification dispatcher / workday-simulation-drain SKIP LOCKED
 * pattern. Per row:
 *
 *   1. Claim → status='processing', increment attempt_count.
 *   2. Load application + candidate.parsed_skills + requisition +
 *      position + jd_versions (text/summary) + jd_skills.
 *   3. Build the AI scoring prompt via @hireops/ai-scoring.
 *   4. Get the tenant's AI client (getAIClient). NODE_ENV=test or
 *      AI_CLIENT_MODE=local short-circuits to LocalAIClient with
 *      fixtures.
 *   5. Call completeStructured with the strict response schema.
 *   6. Write ai_score / ai_score_explanation / ai_scored_at on the
 *      application row. Mark outbox row 'completed'.
 *
 * On any throw inside the drain logic:
 *   - status='pending' with last_error set if attempt_count < attempt_cap
 *     (retry on next tick).
 *   - status='failed' if attempt_count >= attempt_cap (terminal —
 *     surfaces on the ops dashboard, open-question #10).
 *
 * The candidate.parsed_skills jsonb is cast to ParserOutput at the
 * boundary; a Zod parse failure flips the row straight to 'failed'
 * (no retry — the data isn't going to fix itself).
 *
 * PC-6 — EVIDENCE. The same model call now also returns per-criterion
 * screening evidence (verdict + reason + CV quotes) for the requisition's
 * criteria (must-have jd_skills + the JD's requirements section). Quotes are
 * verified verbatim against the CV text the model was shown; unverifiable
 * quotes are dropped and a positive verdict left without one becomes
 * "unclear" (@hireops/ai-scoring reconcileScreeningEvidence). The result is
 * upserted into application_screening_evidence in the SAME transaction as the
 * score write and the outbox completion. The prompt now carries the full JD
 * (PP6). When the requisition's criteria change, `requeueStaleScreeningEvidence`
 * (run from the drain at most once a minute) flips the evidence to 'stale' and
 * re-queues the outbox row.
 *
 * PC-4 — THROUGHPUT. A pass claims max(batchSize, concurrency) rows and works
 * them `concurrency` at a time (default 8, env AI_SCORE_DRAIN_CONCURRENCY).
 * The claim stays an idempotent SKIP LOCKED UPDATE, and the worker loop's
 * in-flight guard still prevents two passes overlapping in one process.
 */

import { randomUUID } from "node:crypto";
import { resolveAiScoreConcurrency, runWithConcurrency } from "./concurrency";
import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import { z } from "zod";
import {
  AI_SCORING_PROMPT_VERSION,
  aiScoringResponseSchema,
  buildAIScoringPrompt,
  buildScreeningCriteria,
  composeScreeningJd,
  extractCvBlock,
  jdRequirementsFromMetadata,
  reconcileScreeningEvidence,
  type AIScoringResponse,
} from "@hireops/ai-scoring";
import {
  getAIClient,
  parserOutputSchema,
  resolveTenantAiSettings,
  resolveTenantScoringWeights,
  isDefaultScoringWeights,
  scoringWeightsEmphasis,
  maskPiiIf,
  type ParserOutput,
} from "@hireops/ai-client";

export interface DrainOpts {
  /** Rows claimed per pass. Raised to `concurrency` if smaller. */
  batchSize?: number;
  /** Rows worked in parallel. Default resolveAiScoreConcurrency(). */
  concurrency?: number;
  workerId?: string;
  log: Logger;
  /**
   * Run the stale-evidence sweep this pass (subject to its once-a-minute
   * throttle). Default true; tests that want a deterministic claim pass false.
   */
  staleSweep?: boolean;
  /**
   * Claim only this tenant's rows. TEST HOOK: the drain is global, and the
   * shared test DB carries other tenants' pending rows that a test must not
   * claim (and burn attempts on). Production never sets it.
   */
  onlyTenantId?: string;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  application_id: string;
  attempt_count: number;
  attempt_cap: number;
}

interface LoadedContext {
  tenantId: string;
  applicationId: string;
  positionTitle: string;
  jdText: string | null;
  jdSummary: string | null;
  jdSkills: { skillName: string; weight: number; isRequired: boolean }[];
  jdRequirements: string[];
  /** md5 of the criteria inputs — see criteriaFingerprintSql. */
  criteriaFingerprint: string;
  parsedCv: ParserOutput;
}

/** The stale sweep runs at most this often per process. */
export const STALE_SWEEP_INTERVAL_MS = 60_000;
let lastStaleSweepAt = 0;

/**
 * The criteria fingerprint, as SQL, for a row aliased `jd` (jd_versions):
 * md5 over the JD version id, its REQUIRED skill names (normalised, sorted)
 * and the JD requirements section. Computed by the database both when the
 * evidence is written (loadContext) and when it is checked for staleness
 * (requeueStaleScreeningEvidence), so the two can never disagree.
 */
function criteriaFingerprintSql() {
  return poolSql`md5(
    jd.id::text || chr(30) ||
    coalesce((
      SELECT string_agg(lower(btrim(fs.skill_name)), chr(31) ORDER BY lower(btrim(fs.skill_name)))
      FROM public.jd_skills fs
      WHERE fs.tenant_id = jd.tenant_id AND fs.jd_version_id = jd.id AND fs.is_required
    ), '') || chr(30) ||
    coalesce((jd.ai_metadata -> 'sections' -> 'requirements')::text, '')
  )`;
}

/**
 * The CURRENT criteria fingerprint for an application's requisition (null if
 * the application is unknown). For tools and tests that write evidence rows
 * outside the drain and need them to read as up to date.
 */
export async function currentCriteriaFingerprint(
  tenantId: string,
  applicationId: string,
): Promise<string | null> {
  const [row] = await poolSql<{ fp: string }[]>`
    SELECT ${criteriaFingerprintSql()} AS fp
    FROM public.applications a
    JOIN public.requisitions r ON r.id = a.requisition_id AND r.tenant_id = a.tenant_id
    JOIN public.jd_versions jd ON jd.id = r.jd_version_id AND jd.tenant_id = r.tenant_id
    WHERE a.tenant_id = ${tenantId} AND a.id = ${applicationId}
  `;
  return row?.fp ?? null;
}

/**
 * PC-6 — flip evidence whose requisition criteria changed to 'stale', and
 * re-queue the scoring of those applications. Re-queues only applications in
 * a live stage, of tenants with ai_scoring enabled, whose outbox row is
 * 'completed' (a 'failed' row stays failed for ops — no retry storm). Global
 * (service-role worker), idempotent.
 */
export async function requeueStaleScreeningEvidence(): Promise<{
  markedStale: number;
  requeued: number;
}> {
  const fp = criteriaFingerprintSql();
  const stale = await poolSql<{ id: string }[]>`
    UPDATE public.application_screening_evidence e
    SET status = 'stale', updated_at = now()
    FROM public.applications a
    JOIN public.requisitions r ON r.id = a.requisition_id AND r.tenant_id = a.tenant_id
    JOIN public.jd_versions jd ON jd.id = r.jd_version_id AND jd.tenant_id = r.tenant_id
    WHERE e.status = 'done'
      AND a.tenant_id = e.tenant_id AND a.id = e.application_id
      AND e.criteria_fingerprint <> ${fp}
    RETURNING e.id
  `;
  const requeued = await poolSql<{ id: string }[]>`
    INSERT INTO public.ai_score_outbox (tenant_id, application_id, status)
    SELECT e.tenant_id, e.application_id, 'pending'
    FROM public.application_screening_evidence e
    JOIN public.applications a ON a.tenant_id = e.tenant_id AND a.id = e.application_id
    JOIN public.tenants t ON t.id = e.tenant_id
    WHERE e.status = 'stale'
      AND a.current_stage NOT IN ('offer_declined', 'withdrawn', 'recruiter_rejected')
      AND COALESCE(t.settings #>> '{aiSettings,ai_scoring,enabled}', 'true') <> 'false'
    ON CONFLICT ON CONSTRAINT uniq_ai_score_outbox_per_application DO UPDATE
      SET status = 'pending', attempt_count = 0, last_error = NULL,
          claimed_by = NULL, claimed_at = NULL, completed_at = NULL
      WHERE public.ai_score_outbox.status = 'completed'
    RETURNING id
  `;
  return { markedStale: stale.length, requeued: requeued.length };
}

export { DEFAULT_AI_SCORE_CONCURRENCY, resolveAiScoreConcurrency } from "./concurrency";

type RowOutcome = "completed" | "retried" | "failed" | "skipped";

export async function drainAiScoreOutboxOnce(opts: DrainOpts): Promise<{
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  /**
   * Rows the tenant's AI settings had `ai_scoring` disabled for. These are
   * NOT scored and NOT retried — the outbox row is marked completed and the
   * application is left cleanly unscored (scored_by='skipped'). CONF-01.
   */
  skipped: number;
  /** PC-4 — highest number of rows worked at once this pass. */
  peakConcurrency: number;
  /** PC-6 — stale sweep result, when it ran this pass. */
  staleSweep?: { markedStale: number; requeued: number };
}> {
  const concurrency = Math.max(1, opts.concurrency ?? resolveAiScoreConcurrency());
  // Claim at least `concurrency` rows so every lane has work; default = concurrency.
  const batchSize = Math.max(opts.batchSize ?? concurrency, concurrency);
  const workerId = opts.workerId ?? `ai-score-${randomUUID().slice(0, 8)}`;
  const log = opts.log;

  let staleSweep: { markedStale: number; requeued: number } | undefined;
  if (opts.staleSweep !== false && Date.now() - lastStaleSweepAt >= STALE_SWEEP_INTERVAL_MS) {
    lastStaleSweepAt = Date.now();
    try {
      staleSweep = await requeueStaleScreeningEvidence();
      if (staleSweep.markedStale > 0 || staleSweep.requeued > 0) {
        log.info(staleSweep, "ai_score.stale_evidence_requeued");
      }
    } catch (err) {
      // Never block scoring on the sweep (e.g. 0124 not yet applied).
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "ai_score.stale_sweep_failed",
      );
    }
  }

  const rows = await poolSql<ClaimedRow[]>`
    UPDATE public.ai_score_outbox
    SET status = 'processing', claimed_by = ${workerId}, claimed_at = now(),
        attempt_count = attempt_count + 1, last_attempt_at = now()
    WHERE id IN (
      SELECT id FROM public.ai_score_outbox
      WHERE status = 'pending'
        ${opts.onlyTenantId ? poolSql`AND tenant_id = ${opts.onlyTenantId}` : poolSql``}
      ORDER BY created_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, application_id, attempt_count, attempt_cap
  `;

  if (rows.length === 0) {
    return {
      claimed: 0,
      completed: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
      peakConcurrency: 0,
      ...(staleSweep ? { staleSweep } : {}),
    };
  }

  let peakConcurrency = 0;
  const outcomes = await runWithConcurrency(
    rows,
    concurrency,
    (row) => scoreOneRow(row, log),
    (p) => {
      peakConcurrency = p;
    },
  );
  const count = (o: RowOutcome) => outcomes.filter((x) => x === o).length;
  return {
    claimed: rows.length,
    completed: count("completed"),
    retried: count("retried"),
    failed: count("failed"),
    skipped: count("skipped"),
    peakConcurrency,
    ...(staleSweep ? { staleSweep } : {}),
  };
}

/** Score ONE claimed row. Never throws — every failure is recorded on the outbox row. */
async function scoreOneRow(row: ClaimedRow, log: Logger): Promise<RowOutcome> {
  const child = log.child({
    ai_score_outbox_id: row.id,
    tenant_id: row.tenant_id,
    application_id: row.application_id,
    attempt: row.attempt_count,
  });
  try {
    // CONF-01: honour the per-tenant ai_scoring switch. Disabled → the
    // graceful no-AI path: mark the application skipped (reusing the
    // existing scored_by='skipped' vocabulary the apply flow already
    // writes on knockout failure) and complete the outbox row. No model
    // call, no retries, no churn — the application simply stays unscored.
    const aiSettings = await resolveTenantAiSettings(poolSql, row.tenant_id);
    if (!aiSettings.ai_scoring.enabled) {
      const skippedAtIso = new Date().toISOString();
      await poolSql`
        UPDATE public.applications
        SET ai_score_explanation = ${JSON.stringify({
          scored_by: "skipped",
          reason: "ai_scoring_disabled",
          skipped_at: skippedAtIso,
        })}::jsonb
        WHERE tenant_id = ${row.tenant_id} AND id = ${row.application_id}
      `;
      await poolSql`
        UPDATE public.ai_score_outbox
        SET status = 'completed', completed_at = now(),
            last_error = 'ai_scoring disabled in tenant AI settings — application left unscored'
        WHERE id = ${row.id}
      `;
      child.info({}, "ai_score.skipped_disabled");
      return "skipped";
    }

    // CONF-03: resolve the per-tenant scoring weight profile. Render the
    // grading-emphasis block ONLY when the profile is non-default. The
    // emphasis (when non-default) is also recorded on the score explanation
    // so recruiters see it.
    const scoringWeights = await resolveTenantScoringWeights(poolSql, row.tenant_id);
    const emphasis = isDefaultScoringWeights(scoringWeights)
      ? null
      : scoringWeightsEmphasis(scoringWeights);

    const ctxRow = await loadContext(row.tenant_id, row.application_id);
    // PC-6: the requisition's screening criteria (must-haves + JD requirements).
    const criteria = buildScreeningCriteria({
      jdSkills: ctxRow.jdSkills,
      jdRequirements: ctxRow.jdRequirements,
    });
    const built = buildAIScoringPrompt({
      positionTitle: ctxRow.positionTitle,
      // PP6: the FULL JD (capped), not a 500-char summary slice.
      jdDescription: composeScreeningJd(ctxRow.jdText, ctxRow.jdSummary),
      jdSkills: ctxRow.jdSkills,
      parsedCv: ctxRow.parsedCv,
      criteria,
      ...(emphasis
        ? {
            scoringWeights: emphasis.map((e) => ({
              key: e.key,
              label: e.label,
              weight: e.weight,
            })),
          }
        : {}),
    });
    const system = built.system;
    // PII masking (when enabled) redacts emails / phones / URLs in the
    // candidate-derived user prompt before it leaves the process.
    const user = maskPiiIf(aiSettings.piiMasking, built.user);
    // Quotes are verified against EXACTLY the CV text the model was shown
    // (post-masking), never the unmasked original.
    const cvText = extractCvBlock(user) ?? "";
    const client = await getAIClient(row.tenant_id);
    const response: AIScoringResponse = await client.completeStructured<AIScoringResponse>({
      system,
      prompt: user,
      model: aiSettings.ai_scoring.model,
      temperature: aiSettings.ai_scoring.temperature,
      maxTokens: aiSettings.ai_scoring.maxTokens,
      schema: z.toJSONSchema(aiScoringResponseSchema, { target: "draft-2020-12" }),
      schemaName: "candidate_fit_score",
      feature: "ai_scoring",
    });

    const validated = aiScoringResponseSchema.parse(response);
    const evidence = reconcileScreeningEvidence({
      raw: validated.criteria,
      criteria,
      cvText,
    });

    const scoredAt = new Date();
    // model lives on the most-recent ai_usage_logs row for this
    // tenant — completeStructured doesn't return it directly. The
    // log row is authoritative for cost attribution; for the
    // explanation we read it back so the recruiter drawer can show
    // exactly which model produced the score. (Under PC-4 concurrency
    // another row of the same tenant may have logged last — same
    // tenant, same configured model, so the answer is unchanged.)
    const [usage] = await poolSql<{ model: string; provider: string }[]>`
      SELECT model, provider FROM public.ai_usage_logs
      WHERE tenant_id = ${row.tenant_id}
        AND feature = 'ai_scoring'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const model = usage?.model ?? "unknown";
    const provider = usage?.provider ?? client.provider;

    // postgres-js template binding doesn't auto-convert Date to a
    // wire-format timestamp string — pass the ISO string explicitly
    // (HANDOVER §4.5/#79 documents the same coercion gotcha on the
    // read side). Cast as timestamptz so postgres parses it back.
    const scoredAtIso = scoredAt.toISOString();
    const c = evidence.counts;
    await poolSql.begin(async (tx) => {
      await tx`
        UPDATE public.applications
        SET ai_score = ${validated.score},
            ai_score_explanation = ${JSON.stringify({
              scored_by: provider,
              model,
              scored_at: scoredAtIso,
              top_factors: validated.top_factors,
              caveats: validated.caveats,
              prompt_version: AI_SCORING_PROMPT_VERSION,
              // CONF-03: present ONLY when the tenant runs a non-default
              // weight profile — the emphasis the model was instructed with,
              // surfaced to recruiters in the score drawer. Honest framing:
              // it is grading guidance, not a computed weighted sum.
              ...(emphasis ? { scoring_emphasis: emphasis } : {}),
            })}::jsonb,
            ai_scored_at = ${scoredAtIso}::timestamptz
        WHERE tenant_id = ${row.tenant_id} AND id = ${row.application_id}
      `;
      // PC-6: the verified evidence, one row per application (upsert — a
      // stale re-run overwrites it and flips it back to 'done').
      await tx`
        INSERT INTO public.application_screening_evidence (
          tenant_id, application_id, status, criteria,
          criteria_count, met_count, partially_met_count, not_met_count, unclear_count,
          quotes_dropped, criteria_fingerprint, model, prompt_version, generated_at
        ) VALUES (
          ${row.tenant_id}, ${row.application_id}, 'done', ${JSON.stringify(evidence.criteria)}::jsonb,
          ${c.criteriaCount}, ${c.met}, ${c.partiallyMet}, ${c.notMet}, ${c.unclear},
          ${evidence.quotesDropped}, ${ctxRow.criteriaFingerprint}, ${model},
          ${AI_SCORING_PROMPT_VERSION}, ${scoredAtIso}::timestamptz
        )
        ON CONFLICT ON CONSTRAINT uniq_application_screening_evidence_per_application
        DO UPDATE SET
          status = 'done',
          criteria = EXCLUDED.criteria,
          criteria_count = EXCLUDED.criteria_count,
          met_count = EXCLUDED.met_count,
          partially_met_count = EXCLUDED.partially_met_count,
          not_met_count = EXCLUDED.not_met_count,
          unclear_count = EXCLUDED.unclear_count,
          quotes_dropped = EXCLUDED.quotes_dropped,
          criteria_fingerprint = EXCLUDED.criteria_fingerprint,
          model = EXCLUDED.model,
          prompt_version = EXCLUDED.prompt_version,
          generated_at = EXCLUDED.generated_at,
          updated_at = now()
      `;
      await tx`
        UPDATE public.ai_score_outbox
        SET status = 'completed', completed_at = now()
        WHERE id = ${row.id}
      `;
    });
    child.info(
      {
        score: validated.score,
        provider,
        model,
        criteria: c.criteriaCount,
        met: c.met,
        quotes_dropped: evidence.quotesDropped,
        downgraded: evidence.downgraded,
      },
      "ai_score.completed",
    );
    return "completed";
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Schema-parse failures aren't worth retrying — the data won't
    // fix itself. Anything else (network blip, rate limit) we let
    // retry up to attempt_cap.
    const terminal = err instanceof z.ZodError || row.attempt_count >= row.attempt_cap;
    try {
      if (terminal) {
        await poolSql`
          UPDATE public.ai_score_outbox
          SET status = 'failed', last_error = ${errMsg}
          WHERE id = ${row.id}
        `;
        child.error({ err: errMsg, terminal: true }, "ai_score.failed");
        return "failed";
      }
      await poolSql`
        UPDATE public.ai_score_outbox
        SET status = 'pending', last_error = ${errMsg}
        WHERE id = ${row.id}
      `;
      child.warn({ err: errMsg, attempt: row.attempt_count }, "ai_score.retry");
      return "retried";
    } catch (writeErr) {
      // The row stays 'processing'; nothing else in this pass is affected.
      child.error(
        { err: errMsg, writeErr: writeErr instanceof Error ? writeErr.message : String(writeErr) },
        "ai_score.outcome_write_failed",
      );
      return terminal ? "failed" : "retried";
    }
  }
}

async function loadContext(tenantId: string, applicationId: string): Promise<LoadedContext> {
  const [appRow] = await poolSql<
    {
      requisition_id: string;
      candidate_id: string;
      position_title: string;
      jd_text: string;
      jd_summary: string | null;
      jd_ai_metadata: unknown;
      criteria_fingerprint: string;
      parsed_skills: unknown;
    }[]
  >`
    SELECT
      a.requisition_id,
      a.candidate_id,
      p.title AS position_title,
      jd.jd_text,
      jd.summary AS jd_summary,
      jd.ai_metadata AS jd_ai_metadata,
      ${criteriaFingerprintSql()} AS criteria_fingerprint,
      c.parsed_skills
    FROM public.applications a
    JOIN public.requisitions r ON r.id = a.requisition_id AND r.tenant_id = a.tenant_id
    JOIN public.positions p ON p.id = r.position_id AND p.tenant_id = r.tenant_id
    JOIN public.jd_versions jd ON jd.id = r.jd_version_id AND jd.tenant_id = r.tenant_id
    JOIN public.candidates c ON c.id = a.candidate_id AND c.tenant_id = a.tenant_id
    WHERE a.tenant_id = ${tenantId} AND a.id = ${applicationId}
  `;
  if (!appRow) {
    throw new Error(`application ${applicationId} not found for tenant ${tenantId}`);
  }
  const parsedCv = parserOutputSchema.parse(appRow.parsed_skills);

  const skillRows = await poolSql<{ skill_name: string; weight: string; is_required: boolean }[]>`
    SELECT s.skill_name, s.weight::text AS weight, s.is_required
    FROM public.jd_skills s
    JOIN public.requisitions r ON r.jd_version_id = s.jd_version_id AND r.tenant_id = s.tenant_id
    WHERE r.tenant_id = ${tenantId} AND r.id = ${appRow.requisition_id}
    ORDER BY s.weight DESC, s.skill_name
  `;
  const jdSkills = skillRows.map((s) => ({
    skillName: s.skill_name,
    weight: Number(s.weight),
    isRequired: s.is_required,
  }));

  return {
    tenantId,
    applicationId,
    positionTitle: appRow.position_title,
    jdText: appRow.jd_text,
    jdSummary: appRow.jd_summary,
    jdSkills,
    jdRequirements: jdRequirementsFromMetadata(appRow.jd_ai_metadata),
    criteriaFingerprint: appRow.criteria_fingerprint,
    parsedCv,
  };
}
