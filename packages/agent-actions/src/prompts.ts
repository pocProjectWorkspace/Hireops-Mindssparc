import type { ApplicationContext } from "./types";

/**
 * Prompt registry for `draft_message`.
 *
 * `agent_actions.action_config.template_prompt_id` is a free-text column;
 * the curated procedures seed known ids (`follow_up_v1`, `candidate_qa_v1`).
 * There is deliberately NO prompt-template table yet — a DB-backed,
 * tenant-editable prompt library is real product surface (versioning,
 * approval, rollback) and belongs in its own ticket. Until then the
 * registry is code, which means prompt changes are reviewed in PRs and
 * versioned by git.
 *
 * `version` is stamped onto the executor's output as `prompt_version` so
 * historical drafts can be partitioned by the prompt that produced them
 * — same discipline as AI_SCORING_PROMPT_VERSION (HANDOVER #97).
 *
 * An unknown `template_prompt_id` throws `UnknownPromptTemplateError`,
 * which the drain treats as terminal. Failing loud beats drafting a
 * candidate-facing email from a silently-substituted fallback prompt.
 */

export type MessageTone = "formal" | "friendly" | "neutral";

export interface PromptTemplate {
  id: string;
  version: string;
  system: (tone: MessageTone) => string;
  user: (ctx: ApplicationContext) => string;
}

export class UnknownPromptTemplateError extends Error {
  constructor(id: string) {
    super(
      `No prompt template registered for template_prompt_id='${id}'. ` +
        `Known ids: ${Object.keys(PROMPT_REGISTRY).join(", ")}`,
    );
    this.name = "UnknownPromptTemplateError";
  }
}

const TONE_GUIDANCE: Record<MessageTone, string> = {
  formal:
    "Write in a formal, professional register. Use complete sentences and avoid contractions, exclamation marks, and casual idiom.",
  friendly:
    "Write in a warm, conversational register. Contractions are fine. Stay professional — friendly, not chatty.",
  neutral:
    "Write in a plain, neutral register. Direct and clear, neither stiff nor effusive.",
};

/**
 * Constraints shared by every candidate-facing draft. These exist because
 * the draft is sent to a real candidate after a recruiter approves it,
 * and the recruiter is reviewing under time pressure — the model must not
 * invent commitments the recruiter then has to honour.
 */
const SHARED_GUARDRAILS = [
  "You are drafting on behalf of a recruiter. The recruiter reviews and may edit your draft before it is sent.",
  "Never invent facts. Do not state or imply a salary figure, a start date, an interview date, or an outcome unless it appears verbatim in the context provided.",
  "Never promise a decision timeline you were not given.",
  "Do not apologise for the delay in a way that admits fault or implies the candidate was mishandled.",
  "Output ONLY the message body. No subject line, no 'Subject:' prefix, no greeting placeholders like [Name], no sign-off placeholders like [Recruiter]. Address the candidate by their real first name and sign off as the recruiting team.",
  "Plain text only. No markdown, no HTML.",
].join("\n");

const followUpV1: PromptTemplate = {
  id: "follow_up_v1",
  version: "followup-v1",
  system: (tone) =>
    [
      "You draft short check-in emails to job candidates whose application has been sitting at the same stage for a while.",
      "",
      SHARED_GUARDRAILS,
      "",
      TONE_GUIDANCE[tone],
      "",
      "Aim for 60-110 words. Acknowledge the wait briefly, confirm the application is still active, and say the team will follow up with next steps. If there is genuinely nothing new to report, say so plainly rather than padding.",
    ].join("\n"),
  user: (ctx) =>
    [
      `Candidate first name: ${firstName(ctx.candidateName)}`,
      `Role applied for: ${ctx.positionTitle}`,
      `Company: ${ctx.companyName}`,
      `Current stage: ${humaniseStage(ctx.stage)}`,
      `Days waiting at this stage: ${ctx.daysInStage}`,
      ctx.jdSummary ? `Role summary: ${ctx.jdSummary}` : "Role summary: (not available)",
      "",
      "Draft the check-in email body.",
    ].join("\n"),
};

export const PROMPT_REGISTRY: Record<string, PromptTemplate> = {
  [followUpV1.id]: followUpV1,
};

export function resolvePromptTemplate(id: string): PromptTemplate {
  const template = PROMPT_REGISTRY[id];
  if (!template) throw new UnknownPromptTemplateError(id);
  return template;
}

/**
 * Best-effort first name. persons.full_name is free text and may be a
 * single token, so fall back to the whole string rather than an empty
 * greeting.
 */
export function firstName(fullName: string): string {
  const head = fullName.trim().split(/\s+/)[0];
  return head && head.length > 0 ? head : fullName.trim();
}

/**
 * `application_stage` enum values are snake_case; the model produces
 * better copy from a human label. Unknown values degrade to a
 * de-underscored form rather than throwing — a new enum value should
 * not break a draft.
 */
export function humaniseStage(stage: string): string {
  const known: Record<string, string> = {
    application_received: "application received",
    ai_screening: "automated screening",
    recruiter_review: "recruiter review",
    shortlisted: "shortlisted",
    tech_interview: "technical interview",
    hr_round: "HR round",
    offer_drafted: "offer being prepared",
  };
  return known[stage] ?? stage.replace(/_/g, " ");
}
