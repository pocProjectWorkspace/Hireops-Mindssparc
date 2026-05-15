/**
 * Public types for @hireops/ai-client.
 *
 * Adding a new provider is one new literal in AIProvider and a new client
 * class. The interface is provider-agnostic; structured output is a
 * first-class operation rather than a tool-use convention so feature code
 * doesn't have to know which provider it's talking to.
 */

export type AIProvider = "anthropic" | "openai";

/**
 * JSON Schema (draft 2020-12-compatible) describing the expected shape of
 * structured output. Kept as a structural type rather than pulling in
 * @types/json-schema so consumers don't take that as a transitive dep.
 * Both Anthropic (tool input_schema) and OpenAI (response_format
 * json_schema) accept this shape verbatim.
 */
export type AIJsonSchema = Record<string, unknown>;

/**
 * A single message in a multi-turn prompt. Mirrors the common shape used
 * by both Anthropic and OpenAI. The `role` is "user" or "assistant"; the
 * "system" role is hoisted to AICompleteOptions.system rather than
 * inlined here, since Anthropic treats system messages as a separate
 * top-level field.
 */
export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AICompleteOptions {
  /** Either a plain user prompt string or a multi-turn messages array. */
  prompt: string | AIMessage[];
  /** Optional system prompt. */
  system?: string;
  /**
   * Provider-specific model id. Defaults to a sensible per-provider
   * choice (see AnthropicAIClient / OpenAIAIClient docs). Pass through
   * unchanged to the SDK.
   */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Caller-supplied context for ai_usage_logs.feature. Free-text in
   * Wave 1 ("resume_parse", "jd_score", "screening_summary", …). Required
   * because every call writes a log row; making it explicit forces the
   * caller to think about cost attribution.
   */
  feature: string;
  /**
   * Optional correlation id forwarded to ai_usage_logs.request_id.
   * HTTP request handlers should pass c.var.requestId.
   */
  requestId?: string | null;
  /**
   * Optional actor membership for ai_usage_logs.actor_membership_id.
   * HTTP request handlers should pass c.var.membershipId when known.
   */
  actorMembershipId?: string | null;
}

export interface AIStructuredCompleteOptions<T> extends AICompleteOptions {
  /**
   * JSON schema the response must conform to. Both providers are
   * configured for strict schema conformance — Anthropic via forced
   * tool-use with input_schema, OpenAI via response_format
   * json_schema { strict: true }.
   */
  schema: AIJsonSchema;
  /**
   * Optional logical name for the structured output. Anthropic surfaces
   * this as the tool name; OpenAI as the json_schema name. Defaults to
   * `"structured_output"`.
   */
  schemaName?: string;
  /** Marker for the TypeScript return type. Not used at runtime. */
  _typeHint?: T;
}

export interface AICompleteResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Cost in integer micros. 1 USD = 1,000,000 micros. Stored as bigint
   * because some long-running batch calls can produce values > 2^31.
   */
  costMicros: bigint;
  latencyMs: number;
}

/**
 * Shape of an ai_usage_logs row, exported so consumers (e.g. a future
 * usage dashboard) can read rows with a typed handle without taking a
 * direct @hireops/db dep on the schema module.
 */
export interface AIUsageLogEntry {
  id: string;
  tenantId: string;
  provider: AIProvider | "local";
  model: string;
  feature: string;
  actorMembershipId: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: bigint;
  latencyMs: number;
  requestId: string | null;
  succeeded: boolean;
  errorCode: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AIClient {
  /**
   * Returns the underlying provider name for logging / debugging.
   * "local" indicates LocalAIClient (test/dev fixture-based mode).
   */
  readonly provider: AIProvider | "local";

  /**
   * Free-form text completion. Writes a row to ai_usage_logs on every
   * call (success or failure).
   */
  complete(opts: AICompleteOptions): Promise<AICompleteResult>;

  /**
   * Structured completion with a JSON schema. Returns parsed JSON
   * matching the schema. Throws if the model fails to produce valid
   * JSON conforming to the schema after the SDK's built-in retries.
   * Also writes ai_usage_logs.
   */
  completeStructured<T>(opts: AIStructuredCompleteOptions<T>): Promise<T>;
}
