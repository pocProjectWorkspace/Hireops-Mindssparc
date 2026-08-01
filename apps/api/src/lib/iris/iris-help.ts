/**
 * Iris help mode (IRIS-HELP) — the natural-language HELP/GUIDE resolver.
 *
 * Mirrors resolve-intent.ts: a pure prompt builder + a structured
 * `getAIClient(tenantId).completeStructured(...)` call with a `feature` label
 * ("iris_help"), so the ai-client AUTO-LOGS cost to ai_usage_logs (and the AI
 * budget applies) on every call.
 *
 * HONESTY — this resolver ANSWERS, it never executes:
 *   - The model is given ONLY the caller's role-eligible capability entries and
 *     is instructed to answer STRICTLY from them. It must not invent a route, a
 *     menu path, or a capability. When the question isn't covered, it returns an
 *     honest "I can't help with that yet" answer.
 *   - Any `suggestedActionId` is re-validated against the caller's role+policy
 *     eligible actions (`validateSuggestedAction`); anything else is dropped. The
 *     suggestion only ever hands off into the UNCHANGED preview → confirm →
 *     execute pipeline — it never runs anything here.
 *   - When the tenant's AI is off / erroring we DEGRADE to a calm deterministic
 *     answer (a short "here's what I can help with"), never a 500.
 */

import { z } from "zod";
import type { IrisHelpOutput } from "@hireops/api-types";
import type { CapabilityEntry } from "./capability-map";
// NOTE: `getAIClient` is imported DYNAMICALLY inside `answerIrisHelp` (below) for
// the same reason as resolve-intent.ts — @hireops/ai-client transitively pulls in
// the DB pool at import time, so a static import would force the pure prompt/
// validator units (and their tests) to require a live DATABASE_URL.

/** The ai_usage_logs.feature label every help call records. */
export const IRIS_HELP_FEATURE = "iris_help";

/** Structured-output tool/schema name for the provider call. */
export const IRIS_HELP_SCHEMA_NAME = "iris_help";

/** Bump when the prompt text or response shape changes meaningfully. */
export const IRIS_HELP_PROMPT_VERSION = "iris-help-v1";

/** Shown when help isn't available (AI off / provider error / no eligible entries). */
export const IRIS_HELP_DEGRADED_MESSAGE =
  "I can't answer questions right now. You can still pick an action from the menu, or explore the left navigation.";

/** A minimal eligible-action descriptor the resolver may hand off to. */
export interface IrisHelpEligibleAction {
  id: string;
  label: string;
}

/**
 * The provider response shape. All fields optional so a provider that omits an
 * irrelevant field still parses. `suggestedActionId` empty means "no handoff".
 */
export const irisHelpResponseSchema = z.object({
  answer: z.string().optional(),
  suggestedActionId: z.string().optional(),
  citedEntryIds: z.array(z.string()).optional(),
});
export type IrisHelpResponse = z.infer<typeof irisHelpResponseSchema>;

/** JSON-schema form handed to the structured-output call. */
export const irisHelpResponseJsonSchema = z.toJSONSchema(irisHelpResponseSchema, {
  target: "draft-2020-12",
});

export interface BuiltIrisHelpPrompt {
  system: string;
  user: string;
}

export interface BuildIrisHelpPromptInput {
  /** The caller's role-eligible capability entries (the ONLY ground truth). */
  entries: readonly CapabilityEntry[];
  /** The caller's role+policy eligible actions (for an optional handoff). */
  eligibleActions: readonly IrisHelpEligibleAction[];
  question: string;
  context?: { route?: string; entityType?: string; entityId?: string };
}

/**
 * Build the system + user prompt for a help answer. PURE. The model sees ONLY
 * the caller's eligible entries + eligible action ids, so it can never steer a
 * user toward a feature or action they can't reach.
 */
export function buildIrisHelpPrompt(input: BuildIrisHelpPromptInput): BuiltIrisHelpPrompt {
  const system = [
    "You are Iris, a friendly in-product help guide for a recruiting platform.",
    "Answer the user's question about how to use the platform, using ONLY the",
    "reference entries provided below. Each entry is a real feature with a real",
    "location and steps.",
    "",
    "Hard rules:",
    "- Answer STRICTLY from the reference entries. NEVER invent a page, menu path,",
    "  button, or capability that is not in them. Keep the answer short and concrete.",
    "- Cite the entries you used by their id in citedEntryIds.",
    "- If the question is NOT covered by any entry, do not guess: say you can't help",
    "  with that yet, and point to one or two things you CAN help with (by title).",
    "- If (and only if) an entry has a matching action AND that action id is in the",
    "  eligible-actions list, set suggestedActionId to it so the user can have Iris do",
    "  it now. Never suggest an id that is not in the eligible-actions list.",
    "- You explain and propose; you never claim to have done anything.",
    "Return JSON only, no prose outside the JSON.",
  ].join("\n");

  const entryLines =
    input.entries.length > 0
      ? input.entries
          .map((e) => {
            const parts = [
              `- id: ${e.id}`,
              `  title: ${e.title}`,
              e.route ? `  location: ${e.route}` : null,
              `  summary: ${e.summary}`,
              `  steps: ${e.steps.join(" ")}`,
              e.relatedActionId ? `  action: ${e.relatedActionId}` : null,
            ].filter((l): l is string => l !== null);
            return parts.join("\n");
          })
          .join("\n")
      : "(no reference entries available for this user)";

  const eligibleActionLine =
    input.eligibleActions.length > 0
      ? input.eligibleActions.map((a) => `${a.id} (${a.label})`).join(", ")
      : "(none)";

  const contextLines: string[] = [];
  if (input.context?.route) contextLines.push(`- Current page: ${input.context.route}`);
  if (input.context?.entityType) {
    contextLines.push(`- The page is about a ${input.context.entityType}`);
  }

  const user = [
    "Reference entries:",
    entryLines,
    "",
    "Eligible actions (only these ids may be suggested):",
    eligibleActionLine,
    "",
    contextLines.length > 0 ? "Page context:" : "Page context: (none)",
    ...contextLines,
    "",
    "User question:",
    input.question,
    "",
    "Return JSON with: answer (short, from the entries only), citedEntryIds, and",
    "suggestedActionId ONLY when an eligible action fits.",
  ].join("\n");

  return { system, user };
}

/**
 * Validate the model's suggestedActionId against the caller's eligible actions.
 * Returns the matching action (id + label) or null — the defence against a
 * hallucinated or ineligible handoff.
 */
export function validateSuggestedAction(
  rawActionId: string | undefined | null,
  eligibleActions: readonly IrisHelpEligibleAction[],
): IrisHelpEligibleAction | null {
  if (!rawActionId) return null;
  return eligibleActions.find((a) => a.id === rawActionId) ?? null;
}

/** Map cited entry ids back to their human titles (dropping unknown ids). */
export function citedTitlesFor(
  citedEntryIds: readonly string[] | undefined,
  entries: readonly CapabilityEntry[],
): string[] {
  if (!citedEntryIds || citedEntryIds.length === 0) return [];
  const byId = new Map(entries.map((e) => [e.id, e.title] as const));
  const titles: string[] = [];
  for (const id of citedEntryIds) {
    const title = byId.get(id);
    if (title && !titles.includes(title)) titles.push(title);
  }
  return titles;
}

/** The graceful-degrade result — a calm answer, never a thrown 500. */
export function degradedHelp(message: string = IRIS_HELP_DEGRADED_MESSAGE): IrisHelpOutput {
  return { answer: message, suggestedActionId: null, suggestedActionLabel: null, citedTitles: [] };
}

export interface AnswerIrisHelpDeps {
  tenantId: string;
  question: string;
  entries: readonly CapabilityEntry[];
  eligibleActions: readonly IrisHelpEligibleAction[];
  context?: { route?: string; entityType?: string; entityId?: string };
  requestId?: string | null;
  actorMembershipId?: string | null;
}

/**
 * Answer a help question from the curated map. Owns the getAIClient +
 * completeStructured call (cost auto-logged, feature "iris_help") and the
 * graceful degrade. Never throws at the caller.
 */
export async function answerIrisHelp(deps: AnswerIrisHelpDeps): Promise<IrisHelpOutput> {
  // No eligible entries → nothing to answer from; skip the model call entirely.
  if (deps.entries.length === 0) {
    return degradedHelp();
  }

  const { system, user } = buildIrisHelpPrompt({
    entries: deps.entries,
    eligibleActions: deps.eligibleActions,
    question: deps.question,
    context: deps.context,
  });

  let raw: IrisHelpResponse;
  try {
    // Deferred import — keeps the pure helpers above free of the ai-client's
    // load-time DB dependency (see the import note at the top of this file).
    const { getAIClient } = await import("@hireops/ai-client");
    const client = await getAIClient(deps.tenantId);
    const completion = await client.completeStructured<IrisHelpResponse>({
      prompt: user,
      system,
      schema: irisHelpResponseJsonSchema,
      schemaName: IRIS_HELP_SCHEMA_NAME,
      feature: IRIS_HELP_FEATURE,
      requestId: deps.requestId ?? null,
      actorMembershipId: deps.actorMembershipId ?? null,
    });
    raw = irisHelpResponseSchema.parse(completion);
  } catch {
    return degradedHelp();
  }

  const answer = raw.answer?.trim();
  const suggested = validateSuggestedAction(raw.suggestedActionId, deps.eligibleActions);
  const citedTitles = citedTitlesFor(raw.citedEntryIds, deps.entries);

  // An empty model answer degrades to the calm fallback (never a blank bubble).
  if (!answer) return degradedHelp();

  return {
    answer,
    suggestedActionId: suggested?.id ?? null,
    suggestedActionLabel: suggested?.label ?? null,
    citedTitles,
  };
}
