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
  neutral: "Write in a plain, neutral register. Direct and clear, neither stiff nor effusive.",
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

/**
 * candidate_qa_v1 — drafts a reply to a candidate's inbound question.
 *
 * T0.1 (D2 fix): `createCandidateQaAgent` seeds this
 * `template_prompt_id` but it was never registered, so a created
 * Candidate-Q&A agent threw `UnknownPromptTemplateError` at draft time.
 *
 * Grounding is the whole point here. The draft_message executor hands
 * the template the same flat `ApplicationContext` the follow-up agent
 * gets — the candidate's REAL role, company, current stage and time-in-
 * stage, plus the JD summary when one exists. It does NOT carry the
 * literal text of the candidate's inbound question, so the prompt is
 * written to reply honestly from the known facts and to defer — never
 * invent — anything those facts don't cover. The send that follows is
 * gated `human_required` (owning_recruiter), so a person reads and may
 * edit every reply before it reaches the candidate.
 */
const candidateQaV1: PromptTemplate = {
  id: "candidate_qa_v1",
  version: "candidateqa-v1",
  system: (tone) =>
    [
      "You draft a reply to a job candidate who has emailed a question about their application.",
      "",
      "You are given only the candidate's real application facts: the role, the company, their current pipeline stage, how long they have been at that stage, and a role summary when one exists. You are NOT given the literal text of their question. Do not guess what they asked, and do not answer a specific question you cannot support from these facts.",
      "",
      SHARED_GUARDRAILS,
      "",
      "Additional grounding rules for a candidate reply:",
      "- Answer only from the facts provided. Where the candidate is likely asking about status, timing, or next steps, respond with what the facts actually show — their current stage and that their application is active — and nothing more.",
      "- If a proper answer needs information not in these facts (a specific interview date, a decision, a salary figure, or any role detail you were not given), do NOT invent it. Say plainly that a recruiter will follow up with those details personally.",
      "- Never state or imply an outcome, a ranking, a score, or any probability of success.",
      "- Do not commit the company to a decision date or a next step you were not given.",
      "",
      TONE_GUIDANCE[tone],
      "",
      "Aim for 60-120 words. Thank them for getting in touch, confirm their application is active and where it currently stands, and set an honest expectation for the next point of contact. A recruiter reviews this draft and may edit it before it is sent.",
    ].join("\n"),
  user: (ctx) =>
    [
      `Candidate first name: ${firstName(ctx.candidateName)}`,
      `Role applied for: ${ctx.positionTitle}`,
      `Company: ${ctx.companyName}`,
      `Current stage: ${humaniseStage(ctx.stage)}`,
      `Days at this stage: ${ctx.daysInStage}`,
      ctx.jdSummary ? `Role summary: ${ctx.jdSummary}` : "Role summary: (not available)",
      "",
      "Draft the reply to the candidate, grounded only in the facts above.",
    ].join("\n"),
};

export const PROMPT_REGISTRY: Record<string, PromptTemplate> = {
  [followUpV1.id]: followUpV1,
  [candidateQaV1.id]: candidateQaV1,
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
