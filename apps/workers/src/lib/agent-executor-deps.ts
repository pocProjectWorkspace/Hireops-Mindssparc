import { sql as poolSql } from "@hireops/db";
import { getAIClient, resolveTenantAiSettings, maskPiiIf } from "@hireops/ai-client";
import type {
  AIDraftRequest,
  AIDraftResult,
  ApplicationContext,
  EnqueueEmailRequest,
  ExecutorDeps,
} from "@hireops/agent-actions";

/**
 * Real `ExecutorDeps` for the agent run drain.
 *
 * `packages/agent-actions` is deliberately DB-free and AI-free (HANDOVER
 * #101) — the executors declare what they need as ports and the worker
 * supplies the implementations here. Tests inject fakes instead.
 *
 * All queries run on `poolSql` (service_role, RLS-bypassing) because the
 * drain is a background process with no JWT. Every query is explicitly
 * scoped by `tenant_id` from the outbox row; there is no RLS backstop on
 * this path, so the tenant predicate is load-bearing, not decorative.
 */

export class ApplicationNotFoundError extends Error {
  constructor(tenantId: string, applicationId: string) {
    super(`No application ${applicationId} in tenant ${tenantId}`);
    this.name = "ApplicationNotFoundError";
  }
}

interface ContextRow {
  application_id: string;
  candidate_id: string;
  candidate_name: string;
  candidate_email: string;
  position_title: string;
  company_name: string;
  stage: string;
  stage_entered_at: Date | string;
  jd_summary: string | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * postgres-js returns timestamptz as Date or string depending on driver
 * mode (HANDOVER #79 / #96 / #103). Coerce defensively.
 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function createExecutorDeps(): ExecutorDeps {
  return {
    async loadApplicationContext(
      tenantId: string,
      applicationId: string,
    ): Promise<ApplicationContext> {
      const rows = await poolSql<ContextRow[]>`
        SELECT
          a.id                AS application_id,
          c.id                AS candidate_id,
          p.full_name         AS candidate_name,
          p.email_primary     AS candidate_email,
          pos.title           AS position_title,
          t.display_name      AS company_name,
          a.current_stage     AS stage,
          a.stage_entered_at  AS stage_entered_at,
          jd.summary          AS jd_summary
        FROM public.applications a
        JOIN public.candidates    c   ON c.tenant_id   = a.tenant_id AND c.id   = a.candidate_id
        JOIN public.persons       p   ON p.tenant_id   = c.tenant_id AND p.id   = c.person_id
        JOIN public.requisitions  r   ON r.tenant_id   = a.tenant_id AND r.id   = a.requisition_id
        JOIN public.positions     pos ON pos.tenant_id = r.tenant_id AND pos.id = r.position_id
        JOIN public.tenants       t   ON t.id          = a.tenant_id
        LEFT JOIN public.jd_versions jd
               ON jd.tenant_id = r.tenant_id AND jd.id = r.jd_version_id
        WHERE a.tenant_id = ${tenantId} AND a.id = ${applicationId}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) throw new ApplicationNotFoundError(tenantId, applicationId);

      const enteredAt = toDate(row.stage_entered_at).getTime();
      const daysInStage = Math.max(0, Math.floor((Date.now() - enteredAt) / MS_PER_DAY));

      return {
        applicationId: row.application_id,
        candidateId: row.candidate_id,
        candidateName: row.candidate_name,
        candidateEmail: row.candidate_email,
        positionTitle: row.position_title,
        companyName: row.company_name,
        stage: row.stage,
        daysInStage,
        jdSummary: row.jd_summary,
      };
    },

    async draftWithAI(tenantId: string, req: AIDraftRequest): Promise<AIDraftResult> {
      // CONF-01: honour the per-tenant agent_drafts switch. Disabled →
      // refuse with a clear error; the agent run drain marks the run failed
      // with this message (its existing failure path), no model call made.
      const aiSettings = await resolveTenantAiSettings(poolSql, tenantId);
      const draftSettings = aiSettings.agent_drafts;
      if (!draftSettings.enabled) {
        throw new Error(
          "agent_drafts disabled in tenant AI settings — an admin can re-enable it in Admin → AI settings",
        );
      }
      const client = await getAIClient(tenantId);
      const result = await client.complete({
        // PII masking (when enabled) redacts emails / phones / URLs in the
        // candidate-derived prompt before it leaves the process.
        prompt: maskPiiIf(aiSettings.piiMasking, req.prompt),
        system: req.system,
        model: draftSettings.model,
        temperature: draftSettings.temperature,
        // The tenant's maxTokens is a ceiling; never inflate the executor's
        // per-invocation request above it.
        maxTokens: Math.min(req.maxTokens, draftSettings.maxTokens),
        feature: req.feature,
      });
      // ai_usage_logs already carries the authoritative per-call cost row
      // (written inside the client). We surface costMicros so the drain
      // can roll it onto agent_runs.cost_micros for the cost dashboard.
      return { text: result.text, costMicros: result.costMicros };
    },

    async enqueueEmail(tenantId: string, req: EnqueueEmailRequest): Promise<{ outboxId: string }> {
      // ON CONFLICT DO NOTHING against the partial UNIQUE on
      // (tenant_id, dedup_key) — HANDOVER #102's canonical pattern.
      // An empty result means the row already exists, which is the
      // idempotency guarantee send_message relies on when a drain pass
      // is retried after a crash mid-action. Re-select to return the id.
      const inserted = await poolSql<{ id: string }[]>`
        INSERT INTO public.notification_outbox (
          tenant_id, recipient_type, recipient_email, recipient_candidate_id,
          template_key, template_data, subject, dedup_key, status
        ) VALUES (
          ${tenantId}, 'candidate', ${req.recipientEmail}, ${req.recipientCandidateId},
          ${req.templateKey}, ${JSON.stringify(req.templateData)}::jsonb,
          ${req.subject}, ${req.dedupKey}, 'pending'
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      const insertedRow = inserted[0];
      if (insertedRow) return { outboxId: insertedRow.id };

      if (!req.dedupKey) {
        // No dedup key means the conflict cannot have come from the
        // dedup index — something else rejected the insert silently.
        throw new Error("notification_outbox insert returned no row and no dedup_key was supplied");
      }
      const existing = await poolSql<{ id: string }[]>`
        SELECT id FROM public.notification_outbox
        WHERE tenant_id = ${tenantId} AND dedup_key = ${req.dedupKey}
        LIMIT 1
      `;
      const existingRow = existing[0];
      if (!existingRow) {
        throw new Error(
          `notification_outbox insert conflicted but no row matches dedup_key=${req.dedupKey}`,
        );
      }
      return { outboxId: existingRow.id };
    },
  };
}
