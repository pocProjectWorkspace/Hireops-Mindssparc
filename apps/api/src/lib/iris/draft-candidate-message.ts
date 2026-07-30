/**
 * Iris candidate-message drafter (message_candidate).
 *
 * Mirrors the jd-generation / resolve-intent reference: a PURE prompt builder +
 * deterministic fallback, plus the impure `draftCandidateMessage` that runs the
 * tenant's LLM through `getAIClient(tenantId).completeStructured(...)` with a
 * `feature` label ("iris_message_draft"), so the ai-client AUTO-LOGS cost to
 * ai_usage_logs (ties into the T5.1 budget).
 *
 * HONESTY — this drafter PROPOSES only. It composes a `{ subject, body }` the
 * drawer PREFILLS into EDITABLE fields; nothing is ever sent here (the human
 * edits + Confirms, which runs the real gated `messageCandidate` send). Two
 * further rails:
 *   - The prompt is grounded ONLY in the real application context (candidate
 *     name, role, company) + the recruiter's intent. The candidate's EMAIL is
 *     never placed in the prompt or the draft body — it is a routing field, not
 *     content the model may echo.
 *   - When the tenant's AI is unconfigured / disabled or the provider errors, we
 *     DEGRADE to a deterministic templated draft rather than throwing a 500, so
 *     the flow always works.
 */

import { z } from "zod";
import type { IrisDraftCandidateMessageOutput } from "@hireops/api-types";
// NOTE: `getAIClient` is imported DYNAMICALLY inside `draftCandidateMessage`
// (below) — @hireops/ai-client transitively pulls in the DB pool at import time,
// so a static import would force the pure prompt/fallback units (and their tests)
// to require a live DATABASE_URL. The deferred import keeps this module's pure
// helpers dependency-light while the runtime call still resolves the tenant's
// real AI client (mirrors resolve-intent.ts).

/** The ai_usage_logs.feature label every candidate-message draft call records. */
export const IRIS_MESSAGE_DRAFT_FEATURE = "iris_message_draft";

/** Structured-output tool/schema name for the provider call. */
export const IRIS_MESSAGE_DRAFT_SCHEMA_NAME = "candidate_message";

/** Bump when the prompt text or response shape changes meaningfully. */
export const IRIS_MESSAGE_DRAFT_PROMPT_VERSION = "iris-message-v1";

/** Bounds so the draft can never exceed the messageCandidate send contract. */
const SUBJECT_MAX = 200;
const BODY_MAX = 4000;

/**
 * The REAL application context the draft is grounded in. Deliberately EXCLUDES
 * the candidate's email — a routing field, never body content — so the prompt
 * builder cannot leak it into the message.
 */
export interface CandidateMessageContext {
  candidateName: string;
  positionTitle: string;
  companyName: string;
}

export interface BuildCandidateMessagePromptInput extends CandidateMessageContext {
  /** The recruiter's free-text steer (what to say). */
  intent: string;
}

export interface BuiltCandidateMessagePrompt {
  system: string;
  user: string;
}

/**
 * The `{ subject, body }` the model must return. Bounded lengths keep a runaway
 * generation from producing an unusable wall of text and keep the
 * structured-output schema strict.
 */
export const candidateMessageResponseSchema = z.object({
  subject: z.string().min(1).max(SUBJECT_MAX),
  body: z.string().min(1).max(BODY_MAX),
});
export type CandidateMessageResponse = z.infer<typeof candidateMessageResponseSchema>;

/** JSON-schema form handed to the structured-output call. */
export const candidateMessageResponseJsonSchema = z.toJSONSchema(candidateMessageResponseSchema, {
  target: "draft-2020-12",
});

/**
 * Build the system + user prompt for a candidate-message draft. PURE — returns
 * plain strings. Grounded ONLY in the passed context + intent; the candidate's
 * email is never part of the input, so it can never appear in the draft.
 */
export function buildCandidateMessagePrompt(
  input: BuildCandidateMessagePromptInput,
): BuiltCandidateMessagePrompt {
  const system = [
    "You are a recruiter writing a short, professional email to a real job candidate.",
    "Ground the message ONLY in the provided context (the candidate's name, the role,",
    "and the company) plus the recruiter's intent. Do NOT invent facts, dates,",
    "interview times, salary numbers, or any commitment the recruiter did not state.",
    "Write plainly, warmly, and concisely — a few short sentences, no hype. Address the",
    "candidate by their first name and sign off as the company's recruitment team.",
    "Return JSON only — no prose outside the JSON.",
  ].join("\n");

  const user = [
    "Draft an email to this candidate:",
    `- Candidate name: ${input.candidateName}`,
    `- Role they applied for: ${input.positionTitle}`,
    `- Company: ${input.companyName}`,
    `- What the recruiter wants to say (intent): ${input.intent.slice(0, 500)}`,
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "subject": "<a short, specific subject line>",',
    '  "body": "<the email body — a warm, concise message grounded only in the above>"',
    "}",
  ].join("\n");

  return { system, user };
}

/** Clamp a subject/body to the send contract's bounds (defence in depth). */
function clampSubject(s: string): string {
  return s.trim().slice(0, SUBJECT_MAX);
}
function clampBody(s: string): string {
  return s.trim().slice(0, BODY_MAX);
}

/**
 * The deterministic templated draft — the graceful-degrade result when the
 * tenant's AI is off / erroring. Composed PURELY from the real context + the
 * recruiter's intent (never the candidate's email), and always non-empty so the
 * drawer stays usable and the human can edit before sending.
 */
export function deterministicCandidateMessageDraft(
  input: BuildCandidateMessagePromptInput,
): IrisDraftCandidateMessageOutput {
  const subject = clampSubject(`Update on your ${input.positionTitle} application`);
  const body = clampBody(
    `Hi ${input.candidateName},\n\n` +
      `Thank you for your interest in the ${input.positionTitle} role at ${input.companyName}.\n\n` +
      `${input.intent.trim()}\n\n` +
      `Please reply to this email if you have any questions.\n\n` +
      `Best regards,\nThe ${input.companyName} Recruitment Team`,
  );
  return { subject, body };
}

export interface DraftCandidateMessageDeps {
  tenantId: string;
  context: CandidateMessageContext;
  intent: string;
  requestId?: string | null;
  actorMembershipId?: string | null;
}

/**
 * Draft a candidate message. Owns the getAIClient + completeStructured call (cost
 * auto-logged, feature "iris_message_draft") and the graceful degrade. Never
 * throws at the caller — an unconfigured/disabled AI, a provider error, or a
 * malformed response returns the deterministic templated draft so the drawer
 * stays usable. The returned `{ subject, body }` is clamped to the send contract.
 */
export async function draftCandidateMessage(
  deps: DraftCandidateMessageDeps,
): Promise<IrisDraftCandidateMessageOutput> {
  const promptInput: BuildCandidateMessagePromptInput = {
    candidateName: deps.context.candidateName,
    positionTitle: deps.context.positionTitle,
    companyName: deps.context.companyName,
    intent: deps.intent,
  };
  const fallback = deterministicCandidateMessageDraft(promptInput);

  try {
    const { system, user } = buildCandidateMessagePrompt(promptInput);
    // Deferred import — keeps the pure helpers above free of the ai-client's
    // load-time DB dependency (see the import note at the top of this file).
    const { getAIClient } = await import("@hireops/ai-client");
    const client = await getAIClient(deps.tenantId);
    const completion = await client.completeStructured<CandidateMessageResponse>({
      prompt: user,
      system,
      schema: candidateMessageResponseJsonSchema,
      schemaName: IRIS_MESSAGE_DRAFT_SCHEMA_NAME,
      feature: IRIS_MESSAGE_DRAFT_FEATURE,
      requestId: deps.requestId ?? null,
      actorMembershipId: deps.actorMembershipId ?? null,
    });
    // Trust-but-verify: re-parse so a provider quirk can't smuggle a bad shape.
    const raw = candidateMessageResponseSchema.parse(completion);
    const subject = clampSubject(raw.subject);
    const body = clampBody(raw.body);
    // A model that returned all-whitespace collapses to empty after clamping —
    // fall back rather than send the human an unusable blank draft.
    if (!subject || !body) return fallback;
    return { subject, body };
  } catch {
    return fallback;
  }
}
