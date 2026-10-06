/**
 * "Ask your data" — the request ORCHESTRATOR (ASK-DATA).
 *
 * interpret (chip | matched | ai) → applyIntentParams → validateParams →
 * role scoping → execute. The router supplies the tenant-bound pieces; this
 * module only sequences them, so the whole flow reads in one place.
 */

import {
  askDataCatalogEntry,
  type AskDataInput,
  type AskDataIntentId,
  type AskDataOutput,
  type AskDataParamKey,
  type AskDataParams,
} from "@hireops/api-types";

import {
  ASK_DATA_UNSUPPORTED_MESSAGE,
  HIRING_MANAGER_SCOPE,
  applyIntentParams,
  buildChips,
  interpretQuestion,
  suggestQuestions,
  validateParams,
  type AskDataAiComplete,
  type AskDataLookups,
} from "./interpret";
import { executeAskDataIntent, type AskDataExecDeps } from "./execute";

const PARAM_NAMES: Record<AskDataParamKey, string> = {
  period: "A time period",
  businessUnit: "A business unit filter",
  requisition: "A requisition filter",
  months: "A number of months",
};

export interface RunAskDataDeps {
  input: AskDataInput;
  lookups: AskDataLookups;
  exec: AskDataExecDeps;
  aiEnabled: boolean;
  complete: AskDataAiComplete;
  now?: Date;
}

export const ASK_DATA_ROLE_UNAVAILABLE_MESSAGE =
  "That question isn't available for your role yet — it would need data beyond the requisitions you manage.";
export const ASK_DATA_HM_PICK_REQUISITION_MESSAGE =
  'For your role this answer is scoped to one of your requisitions. Ask again naming one of your open requisitions (for example: "time to fill for <requisition>").';

export async function runAskData(deps: RunAskDataDeps): Promise<AskDataOutput> {
  const { input, lookups } = deps;
  let intent: AskDataIntentId;
  let source: "chip" | "matched" | "ai";
  let rawParams: AskDataParams;
  let explicit: AskDataParamKey[];

  if (input.intent) {
    // Chip click / chip edit: no interpretation, no model.
    intent = input.intent;
    source = "chip";
    rawParams = input.params ?? {};
    explicit = Object.keys(rawParams) as AskDataParamKey[];
  } else {
    const outcome = await interpretQuestion({
      question: input.question ?? "",
      previous: input.previous,
      lookups,
      aiEnabled: deps.aiEnabled,
      complete: deps.complete,
      now: deps.now,
    });
    if (outcome.status === "ai_unavailable") {
      return {
        status: "ai_unavailable",
        message: outcome.message,
        suggestions: suggestQuestions(input.question),
      };
    }
    if (outcome.status === "unsupported") {
      const suggestions = suggestQuestions(input.question);
      // A low-confidence best guess leads the suggestions, never runs.
      if (outcome.bestGuess && !suggestions.some((s) => s.intent === outcome.bestGuess)) {
        suggestions.unshift({
          intent: outcome.bestGuess,
          question: askDataCatalogEntry(outcome.bestGuess).question,
        });
        suggestions.length = 3;
      }
      return {
        status: "unsupported",
        message: outcome.message ?? ASK_DATA_UNSUPPORTED_MESSAGE,
        suggestions,
      };
    }
    intent = outcome.intent;
    source = outcome.source;
    rawParams = outcome.params;
    explicit = outcome.explicit;
  }

  const entry = askDataCatalogEntry(intent);
  const applied = applyIntentParams(intent, rawParams);
  const notes: string[] = applied.dropped
    .filter((k) => explicit.includes(k))
    .map((k) => `${PARAM_NAMES[k]} doesn't apply to "${entry.label}", so it was ignored.`);
  const validated = validateParams(applied.params, lookups, deps.now);
  notes.push(...validated.notes);
  const params = validated.params;
  const filters = validated.filters;

  // Hiring-manager scoping — never fall back to tenant-wide data.
  if (deps.exec.hmMembershipId) {
    const scope = HIRING_MANAGER_SCOPE[intent];
    const unavailable = (message: string): AskDataOutput => ({
      status: "unavailable",
      message,
      interpretation: {
        intent,
        intentLabel: entry.label,
        source,
        params,
        chips: buildChips(intent, params),
        notes,
      },
      suggestions: suggestQuestions(input.question),
    });
    if (scope === "none") return unavailable(ASK_DATA_ROLE_UNAVAILABLE_MESSAGE);
    if (scope === "requisition" && !filters.requisitionId) {
      const own = lookups.requisitions;
      if (own.length === 1 && own[0]) {
        filters.requisitionId = own[0].id;
        filters.requisitionTitle = own[0].name;
        params.requisition = own[0].name;
        notes.push(`Scoped to your requisition ${own[0].name}.`);
      } else {
        return unavailable(ASK_DATA_HM_PICK_REQUISITION_MESSAGE);
      }
    }
  }

  const result = await executeAskDataIntent(intent, deps.exec, filters);
  return {
    status: "answered",
    interpretation: {
      intent,
      intentLabel: entry.label,
      source,
      params,
      chips: buildChips(intent, params),
      notes,
    },
    result,
    suggestions: [],
  };
}
