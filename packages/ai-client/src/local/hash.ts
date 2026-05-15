import { createHash } from "node:crypto";
import type { AICompleteOptions, AIStructuredCompleteOptions, AIJsonSchema } from "../types";

/**
 * Deterministic fixture key. Hash inputs that affect the model's output:
 * prompt (string or messages array), system, model, and — for structured
 * calls — the schema. Excludes feature / requestId / actorMembershipId
 * since those don't change what the model would say.
 *
 * SHA-256 hex; full digest (no truncation) so fixture authors don't have
 * to worry about collisions when adding many test cases.
 */
export function hashCompleteOptions(opts: AICompleteOptions, schema?: AIJsonSchema): string {
  const promptRepr = typeof opts.prompt === "string" ? opts.prompt : JSON.stringify(opts.prompt);
  const parts = [
    promptRepr,
    opts.system ?? "",
    opts.model ?? "",
    schema ? JSON.stringify(schema) : "",
  ];
  return createHash("sha256").update(parts.join("␟")).digest("hex");
}

export function hashStructuredOptions(opts: AIStructuredCompleteOptions<unknown>): string {
  return hashCompleteOptions(opts, opts.schema);
}
