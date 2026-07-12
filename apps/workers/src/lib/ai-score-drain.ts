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
 */

import { randomUUID } from "node:crypto";
import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import { z } from "zod";
import {
  AI_SCORING_PROMPT_VERSION,
  aiScoringResponseSchema,
  buildAIScoringPrompt,
  type AIScoringResponse,
} from "@hireops/ai-scoring";
import { getAIClient, parserOutputSchema, type ParserOutput } from "@hireops/ai-client";

export interface DrainOpts {
  batchSize?: number;
  workerId?: string;
  log: Logger;
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
  parsedCv: ParserOutput;
}

const DEFAULT_BATCH = 5;

export async function drainAiScoreOutboxOnce(opts: DrainOpts): Promise<{
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
}> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const workerId = opts.workerId ?? `ai-score-${randomUUID().slice(0, 8)}`;
  const log = opts.log;

  const rows = await poolSql<ClaimedRow[]>`
    UPDATE public.ai_score_outbox
    SET status = 'processing', claimed_by = ${workerId}, claimed_at = now(),
        attempt_count = attempt_count + 1, last_attempt_at = now()
    WHERE id IN (
      SELECT id FROM public.ai_score_outbox
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, application_id, attempt_count, attempt_cap
  `;

  if (rows.length === 0) return { claimed: 0, completed: 0, retried: 0, failed: 0 };

  let completed = 0;
  let retried = 0;
  let failed = 0;

  for (const row of rows) {
    const child = log.child({
      ai_score_outbox_id: row.id,
      tenant_id: row.tenant_id,
      application_id: row.application_id,
      attempt: row.attempt_count,
    });
    try {
      const ctxRow = await loadContext(row.tenant_id, row.application_id);
      const { system, user } = buildAIScoringPrompt({
        positionTitle: ctxRow.positionTitle,
        jdDescription: ctxRow.jdSummary ?? ctxRow.jdText,
        jdSkills: ctxRow.jdSkills,
        parsedCv: ctxRow.parsedCv,
      });
      const client = await getAIClient(row.tenant_id);
      const response: AIScoringResponse = await client.completeStructured<AIScoringResponse>({
        system,
        prompt: user,
        schema: z.toJSONSchema(aiScoringResponseSchema, { target: "draft-2020-12" }),
        schemaName: "candidate_fit_score",
        feature: "ai_scoring",
      });

      const validated = aiScoringResponseSchema.parse(response);

      const scoredAt = new Date();
      // model lives on the most-recent ai_usage_logs row for this
      // tenant — completeStructured doesn't return it directly. The
      // log row is authoritative for cost attribution; for the
      // explanation we read it back so the recruiter drawer can show
      // exactly which model produced the score.
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
      await poolSql`
        UPDATE public.applications
        SET ai_score = ${validated.score},
            ai_score_explanation = ${JSON.stringify({
              scored_by: provider,
              model,
              scored_at: scoredAtIso,
              top_factors: validated.top_factors,
              caveats: validated.caveats,
              prompt_version: AI_SCORING_PROMPT_VERSION,
            })}::jsonb,
            ai_scored_at = ${scoredAtIso}::timestamptz
        WHERE tenant_id = ${row.tenant_id} AND id = ${row.application_id}
      `;

      await poolSql`
        UPDATE public.ai_score_outbox
        SET status = 'completed', completed_at = now()
        WHERE id = ${row.id}
      `;
      completed += 1;
      child.info({ score: validated.score, provider, model }, "ai_score.completed");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Schema-parse failures aren't worth retrying — the data won't
      // fix itself. Anything else (network blip, rate limit) we let
      // retry up to attempt_cap.
      const terminal = err instanceof z.ZodError || row.attempt_count >= row.attempt_cap;
      if (terminal) {
        await poolSql`
          UPDATE public.ai_score_outbox
          SET status = 'failed', last_error = ${errMsg}
          WHERE id = ${row.id}
        `;
        failed += 1;
        child.error({ err: errMsg, terminal: true }, "ai_score.failed");
      } else {
        await poolSql`
          UPDATE public.ai_score_outbox
          SET status = 'pending', last_error = ${errMsg}
          WHERE id = ${row.id}
        `;
        retried += 1;
        child.warn({ err: errMsg, attempt: row.attempt_count }, "ai_score.retry");
      }
    }
  }
  return { claimed: rows.length, completed, retried, failed };
}

async function loadContext(tenantId: string, applicationId: string): Promise<LoadedContext> {
  const [appRow] = await poolSql<
    {
      requisition_id: string;
      candidate_id: string;
      position_title: string;
      jd_text: string;
      jd_summary: string | null;
      parsed_skills: unknown;
    }[]
  >`
    SELECT
      a.requisition_id,
      a.candidate_id,
      p.title AS position_title,
      jd.jd_text,
      jd.summary AS jd_summary,
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
    parsedCv,
  };
}
