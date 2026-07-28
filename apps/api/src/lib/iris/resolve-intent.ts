/**
 * Iris natural-language intent resolver (IRIS-A3).
 *
 * Maps a caller's free text to a PROPOSED whitelisted Iris action + extracted
 * DRAFT params, which flow into the SAME irisPreview → confirm → irisExecute
 * pipeline the menu path uses. Mirrors the jd-generation reference
 * (apps/api/src/lib/jd-generation.ts): a pure prompt builder + a structured
 * `getAIClient(tenantId).completeStructured(...)` call with a `feature` label
 * ("iris_intent"), so the ai-client AUTO-LOGS cost to ai_usage_logs on every
 * call.
 *
 * HONESTY — this resolver PROPOSES only. It never executes, and it never
 * resolves a concrete entity id:
 *   - `actionId` is validated against the CALLER's role-eligible whitelist
 *     (the exact set irisListActions returns for this caller); anything else the
 *     model returns is nulled (`validateResolvedActionId`).
 *   - `params` are DRAFT SCALARS only. Any uuid-looking value, or any known
 *     id-typed field, is stripped (`sanitizeDraftParams`) — the resolver must
 *     not invent uuids. Application / requisition targets come back as free-text
 *     `candidateQuery` / `requisitionQuery` HINTS that seed the drawer's picker;
 *     the human selects + confirms the concrete entity.
 *   - When the tenant's AI is unconfigured / disabled or the provider errors, we
 *     DEGRADE to a calm "use the menu" message rather than throwing a 500. The
 *     menu path always works.
 */

import { z } from "zod";
import { applicationStageSchema } from "@hireops/api-types";
import type { IrisResolveIntentHints, IrisResolveIntentOutput } from "@hireops/api-types";
// NOTE: `getAIClient` is imported DYNAMICALLY inside `resolveIrisIntent` (below)
// rather than at module scope. @hireops/ai-client transitively pulls in the DB
// pool at import time, so a static import would force the pure prompt/validator
// units (and their tests) to require a live DATABASE_URL. The deferred import
// keeps this module's pure helpers dependency-light while the runtime call still
// resolves the tenant's real AI client.

/** The ai_usage_logs.feature label every intent-resolution call records. */
export const IRIS_INTENT_FEATURE = "iris_intent";

/** Structured-output tool/schema name for the provider call. */
export const IRIS_INTENT_SCHEMA_NAME = "iris_intent";

/** Bump when the prompt text or response shape changes meaningfully. */
export const IRIS_INTENT_PROMPT_VERSION = "iris-a3-v1";

/** The calm degrade message shown when NL resolution isn't available. */
export const IRIS_INTENT_DEGRADED_MESSAGE =
  "Natural language isn't available right now — pick an action from the menu.";

/** Shown when the caller has NO role-eligible actions to propose. */
export const IRIS_INTENT_NO_ACTIONS_MESSAGE =
  "You don't have any Iris actions available for your role. Pick one from the menu if that changes.";

/**
 * Concise, hand-written per-action descriptions for the prompt. Clearer (and
 * cheaper) than reflecting each action's zod schema. Keyed by the registry
 * action id; only the CALLER's role-eligible ids are ever shown to the model.
 * `fields` lists the DRAFT SCALARS the model may extract — never an entity id
 * (targets come back as candidateQuery / requisitionQuery hints instead).
 */
export interface IrisActionPromptHint {
  describe: string;
  fields: string;
}

export const IRIS_ACTION_PROMPT_HINTS: Record<string, IrisActionPromptHint> = {
  create_requisition_jd: {
    describe: "Create a new requisition (open role) and generate its job description.",
    fields:
      "title (the role title), locationType (one of remote|hybrid|onsite|multi), seniority, numberOfOpenings (integer). Target: none (it creates a new requisition).",
  },
  advance_application: {
    describe: "Move ONE candidate's application forward to a later pipeline stage.",
    fields:
      "targetStage (the stage to advance to), reason (optional). Target: the candidate — return a candidateQuery search phrase, never an id.",
  },
  reject_application: {
    describe: "End ONE candidate's application (reject them).",
    fields:
      "reason (why they're rejected). Target: the candidate — return a candidateQuery search phrase, never an id.",
  },
  open_onboarding_case: {
    describe: "Open an onboarding case for ONE candidate's application.",
    fields:
      "none besides the target. Target: the candidate — return a candidateQuery search phrase, never an id.",
  },
  bulk_advance_applications: {
    describe:
      "Advance EVERY candidate on a requisition who is currently at a given stage, in bulk.",
    fields:
      "fromStage (the current stage to act on), targetStage (the stage to advance to), reason (optional). Target: the requisition — return a requisitionQuery search phrase, never an id.",
  },
  bulk_reject_applications: {
    describe: "Reject EVERY candidate on a requisition who is currently at a given stage, in bulk.",
    fields:
      "fromStage (the current stage to act on), reason (optional). Target: the requisition — return a requisitionQuery search phrase, never an id.",
  },
};

/**
 * The DRAFT scalar fields the drawer's forms actually read, per action. Only
 * these are threaded into `params` from the model's output — anything else the
 * model emits is dropped. Deliberately excludes every entity-id field (targets
 * come back as picker hints).
 */
export const ACTION_DRAFT_FIELDS: Record<string, readonly string[]> = {
  create_requisition_jd: ["title", "locationType", "seniority", "numberOfOpenings"],
  advance_application: ["targetStage", "reason"],
  reject_application: ["reason"],
  open_onboarding_case: [],
  bulk_advance_applications: ["fromStage", "targetStage", "reason"],
  bulk_reject_applications: ["fromStage", "reason"],
};

/** Location types the create action accepts (mirrors the wizard). */
const LOCATION_TYPES = ["remote", "hybrid", "onsite", "multi"] as const;

/** Every id-typed key we refuse to carry into params (defence in depth). */
const ID_PARAM_KEYS = new Set([
  "applicationId",
  "requisitionId",
  "businessUnitId",
  "compBandId",
  "candidateId",
  "personId",
  "positionId",
  "jdVersionId",
  "transitionId",
  "id",
]);

/** Canonical uuid shape — any string value matching this is stripped from params. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The provider response shape. All fields optional so a provider that omits an
 * irrelevant field still parses; `actionId` empty-string means "no action".
 * `params` are the flat draft scalars across the six actions (no id fields).
 */
export const irisIntentResponseSchema = z.object({
  actionId: z.string().optional(),
  candidateQuery: z.string().optional(),
  requisitionQuery: z.string().optional(),
  clarifyingQuestion: z.string().optional(),
  message: z.string().optional(),
  // Draft scalars (never an entity id):
  title: z.string().optional(),
  locationType: z.string().optional(),
  seniority: z.string().optional(),
  numberOfOpenings: z.number().optional(),
  targetStage: z.string().optional(),
  fromStage: z.string().optional(),
  reason: z.string().optional(),
});
export type IrisIntentResponse = z.infer<typeof irisIntentResponseSchema>;

/** JSON-schema form handed to the structured-output call. */
export const irisIntentResponseJsonSchema = z.toJSONSchema(irisIntentResponseSchema, {
  target: "draft-2020-12",
});

export interface BuiltIrisIntentPrompt {
  system: string;
  user: string;
}

export interface BuildIrisIntentPromptInput {
  /** The CALLER's role-eligible whitelisted action ids (irisListActions order). */
  eligibleActionIds: readonly string[];
  text: string;
  context?: { route?: string; entityType?: string; entityId?: string };
}

/**
 * Build the system + user prompt for intent resolution. PURE — returns plain
 * strings. Crucially, ONLY the caller's role-eligible actions (intersected with
 * the hint map) are described to the model, so it can never be steered toward an
 * action this caller may not run. `context.entityId` is passed as opaque routing
 * context (never as a param the model should echo into an id).
 */
export function buildIrisIntentPrompt(input: BuildIrisIntentPromptInput): BuiltIrisIntentPrompt {
  const eligible = input.eligibleActionIds.filter((id) => IRIS_ACTION_PROMPT_HINTS[id]);

  const system = [
    "You are Iris, a transactional assistant for a recruiting platform. You map a",
    "user's free-text request to EXACTLY ONE whitelisted action from the list below,",
    "and extract only the draft scalar fields that action needs. You are a PROPOSER,",
    "not an executor: a human reviews and confirms every action before it runs.",
    "",
    "Hard rules:",
    "- Pick actionId from the provided list ONLY. If nothing fits, or the request is",
    "  ambiguous, leave actionId empty and set clarifyingQuestion (to ask for what's",
    "  missing) or message (a short, friendly note).",
    "- NEVER invent or output any id, uuid, or database key. For a target candidate,",
    "  put a short search phrase (their name or role) in candidateQuery. For a target",
    "  requisition, put a short phrase in requisitionQuery. A human selects the exact",
    "  record from those hints.",
    "- Only fill scalar fields that the chosen action actually uses. Leave the rest",
    "  empty. Do not guess a reason or a stage the user did not imply.",
    "- Valid pipeline stages: " + applicationStageSchema.options.join(", ") + ".",
    "- Valid locationType values: " + LOCATION_TYPES.join(", ") + ".",
    "Return JSON only — no prose outside the JSON.",
  ].join("\n");

  const actionLines =
    eligible.length > 0
      ? eligible
          .map((id) => {
            const hint = IRIS_ACTION_PROMPT_HINTS[id];
            if (!hint) return null;
            return `- ${id}: ${hint.describe}\n  Draft fields: ${hint.fields}`;
          })
          .filter((line): line is string => line !== null)
          .join("\n")
      : "(none — the user has no eligible actions)";

  const contextLines: string[] = [];
  if (input.context?.route) contextLines.push(`- Current page: ${input.context.route}`);
  if (input.context?.entityType) {
    contextLines.push(
      `- The page is about a ${input.context.entityType}` +
        (input.context.entityId ? ' (the user may mean "this one")' : ""),
    );
  }

  const user = [
    "Available actions:",
    actionLines,
    "",
    contextLines.length > 0 ? "Page context:" : "Page context: (none)",
    ...contextLines,
    "",
    "User request:",
    input.text,
    "",
    "Return JSON with: actionId (one of the ids above or empty), the relevant draft",
    "scalar fields, candidateQuery / requisitionQuery for any target, and",
    "clarifyingQuestion / message when you propose no action.",
  ].join("\n");

  return { system, user };
}

/**
 * Validate the model's actionId against the caller's role-eligible whitelist.
 * Returns the id when eligible, else null — the defence against a hallucinated
 * or ineligible action leaking through.
 */
export function validateResolvedActionId(
  rawActionId: string | undefined | null,
  eligibleActionIds: readonly string[],
): string | null {
  if (!rawActionId) return null;
  return eligibleActionIds.includes(rawActionId) ? rawActionId : null;
}

/**
 * Strip anything that isn't a safe DRAFT scalar: drop known id-typed keys
 * outright, and drop any string value that LOOKS like a uuid. The resolver must
 * never carry a concrete entity id into params (targets are picker hints).
 */
export function sanitizeDraftParams(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (ID_PARAM_KEYS.has(key)) continue;
    if (typeof value === "string" && UUID_RE.test(value.trim())) continue;
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Assemble the draft `params` for the resolved action from the model output:
 * keep only the fields that action's form reads, then sanitize. Returns {} when
 * no action resolved.
 */
export function assembleDraftParams(
  actionId: string | null,
  raw: IrisIntentResponse,
): Record<string, unknown> {
  if (!actionId) return {};
  const fields = ACTION_DRAFT_FIELDS[actionId] ?? [];
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    const value = (raw as Record<string, unknown>)[field];
    if (value === undefined || value === null || value === "") continue;
    picked[field] = value;
  }
  return sanitizeDraftParams(picked);
}

/** Pull the free-text picker seeds (trimmed, capped, never ids) from the output. */
export function extractHints(raw: IrisIntentResponse): IrisResolveIntentHints {
  const hints: IrisResolveIntentHints = {};
  const cand = raw.candidateQuery?.trim();
  const req = raw.requisitionQuery?.trim();
  if (cand) hints.candidateQuery = cand.slice(0, 200);
  if (req) hints.requisitionQuery = req.slice(0, 200);
  return hints;
}

/** The graceful-degrade result — a calm message, never a thrown 500. */
export function degradedResolution(
  message: string = IRIS_INTENT_DEGRADED_MESSAGE,
): IrisResolveIntentOutput {
  return { actionId: null, params: {}, hints: {}, message };
}

export interface ResolveIrisIntentDeps {
  tenantId: string;
  text: string;
  eligibleActionIds: readonly string[];
  context?: { route?: string; entityType?: string; entityId?: string };
  requestId?: string | null;
  actorMembershipId?: string | null;
}

/**
 * Resolve free text to a PROPOSED action + draft params. Owns the getAIClient +
 * completeStructured call (cost auto-logged, feature "iris_intent") and the
 * graceful degrade. Never throws at the caller — an unconfigured/disabled AI or
 * a provider error returns the degrade shape so the drawer stays usable.
 */
export async function resolveIrisIntent(
  deps: ResolveIrisIntentDeps,
): Promise<IrisResolveIntentOutput> {
  const eligible = deps.eligibleActionIds.filter((id) => IRIS_ACTION_PROMPT_HINTS[id]);
  // No eligible actions → nothing to propose; skip the model call entirely.
  if (eligible.length === 0) {
    return { actionId: null, params: {}, hints: {}, message: IRIS_INTENT_NO_ACTIONS_MESSAGE };
  }

  const { system, user } = buildIrisIntentPrompt({
    eligibleActionIds: eligible,
    text: deps.text,
    context: deps.context,
  });

  let raw: IrisIntentResponse;
  try {
    // Deferred import — keeps the pure helpers above free of the ai-client's
    // load-time DB dependency (see the import note at the top of this file).
    const { getAIClient } = await import("@hireops/ai-client");
    const client = await getAIClient(deps.tenantId);
    const completion = await client.completeStructured<IrisIntentResponse>({
      prompt: user,
      system,
      schema: irisIntentResponseJsonSchema,
      schemaName: IRIS_INTENT_SCHEMA_NAME,
      feature: IRIS_INTENT_FEATURE,
      requestId: deps.requestId ?? null,
      actorMembershipId: deps.actorMembershipId ?? null,
    });
    // Trust-but-verify: re-parse so a provider quirk can't smuggle a bad shape.
    raw = irisIntentResponseSchema.parse(completion);
  } catch {
    // Unconfigured / disabled AI, provider error, or a malformed response — all
    // degrade to the calm "use the menu" path. The menu always works.
    return degradedResolution();
  }

  const actionId = validateResolvedActionId(raw.actionId, eligible);
  const params = assembleDraftParams(actionId, raw);
  const hints = extractHints(raw);
  const clarifyingQuestion = raw.clarifyingQuestion?.trim() || null;
  const message = raw.message?.trim() || null;

  return {
    actionId,
    params,
    hints,
    ...(clarifyingQuestion ? { clarifyingQuestion } : {}),
    // Only surface a message when there's no action to run (avoids a confusing
    // note alongside a resolved form).
    ...(!actionId && message ? { message } : {}),
  };
}
