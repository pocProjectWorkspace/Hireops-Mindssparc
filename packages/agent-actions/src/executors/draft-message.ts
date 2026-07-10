import { resolvePromptTemplate } from "../prompts";
import {
  ActionConfigMismatchError,
  MissingTriggerContextError,
  type ActionExecutor,
} from "../types";

/**
 * draft_message — REAL (FOLLOWUP-01). Supersedes the AGENT-02 stub.
 *
 * Loads the application context, resolves the prompt template named by
 * `template_prompt_id`, calls the tenant's configured LLM through the
 * injected `deps.draftWithAI` port, and returns the draft body.
 *
 * ── Why this action carries the approval gate ────────────────────────
 * The drain executes an action and THEN consults the gate; on approval
 * it marks the run-action `completed` and resumes WITHOUT re-executing
 * (see agent-run-drain.ts and approveApprovalWithEdit's "skips
 * re-execution" note). That ordering is only safe for a PURE action.
 *
 * draft_message is pure — it computes text and writes nothing outside
 * ai_usage_logs. So the gate belongs here: the recruiter approves (or
 * edits) the draft, and the effectful `send_message` that follows has
 * not run yet. On resume it executes for the first time and reads the
 * approved-or-edited `draft_text` out of previousActionOutputs.
 *
 * Gating `send_message` instead would either send before the human
 * approved, or never send after. FOLLOWUP-01 moved the gate here and
 * flipped `requiresApprovalCapable` accordingly (see registry.ts).
 *
 * `requiresApproval: true` is the per-invocation signal only; the rule's
 * approval_mode still owns the runtime decision, and mode 'auto' means
 * an autonomous drafting agent bypasses the gate entirely.
 *
 * Output shape is the approval payload the recruiter sees and edits, so
 * every field here is either rendered in the approval queue or consumed
 * by send_message. Keep it flat and human-legible.
 */
export const draftMessageExecutor: ActionExecutor = async ({
  config,
  tenantId,
  triggerContext,
  deps,
}) => {
  if (config.type !== "draft_message") {
    throw new ActionConfigMismatchError("draft_message", config.type);
  }

  const applicationId = triggerContext.application_id;
  if (typeof applicationId !== "string" || applicationId.length === 0) {
    throw new MissingTriggerContextError("draft_message", "application_id");
  }

  // Throws UnknownPromptTemplateError before any LLM spend if the id is bad.
  const template = resolvePromptTemplate(config.template_prompt_id);
  const ctx = await deps.loadApplicationContext(tenantId, applicationId);

  const { text, costMicros } = await deps.draftWithAI(tenantId, {
    system: template.system(config.tone),
    prompt: template.user(ctx),
    maxTokens: config.max_tokens,
    feature: "agent_draft_message",
  });

  const draftText = text.trim();

  return {
    output: {
      draft_text: draftText,
      // Subject is registry-owned for every other template; agent drafts
      // are free-form, so the executor owns it here. Kept out of the LLM's
      // hands deliberately — a hallucinated subject is the most likely
      // thing a rushed recruiter approves without reading.
      subject: `Update on your application — ${ctx.positionTitle}`,
      application_id: ctx.applicationId,
      candidate_id: ctx.candidateId,
      candidate_name: ctx.candidateName,
      candidate_email: ctx.candidateEmail,
      position_title: ctx.positionTitle,
      company_name: ctx.companyName,
      stage: ctx.stage,
      days_in_stage: ctx.daysInStage,
      template_prompt_id: config.template_prompt_id,
      prompt_version: template.version,
      tone: config.tone,
    },
    costMicros,
    requiresApproval: true,
  };
};
