import { createRequire } from "node:module";
import { recordAIUsage } from "./usage-log";
import { computeCostMicros } from "./pricing";
import type {
  AIClient,
  AICompleteOptions,
  AICompleteResult,
  AIStructuredCompleteOptions,
  AIMessage,
} from "./types";

/**
 * Anthropic-backed AI client.
 *
 * Default model: claude-sonnet-4-6 — current canonical Sonnet at build
 * time, right cost/quality balance for resume parsing and JD scoring.
 * Callers needing more capability (e.g. interview synthesis) can pass
 * `model: 'claude-opus-4-7'` via AICompleteOptions.
 *
 * Structured output: forced-tool-use pattern. Define a single tool whose
 * input_schema is the requested JSON schema, set
 * tool_choice: { type: 'tool', name: <schemaName> }, and return the
 * first tool_use block's input. This is the documented Anthropic pattern
 * for guaranteed structured output and is stable across SDK versions.
 *
 * SDK: @anthropic-ai/sdk, lazy-loaded via createRequire so apps that
 * don't enable Anthropic never have to install it. Same pattern as
 * RealSentryClient.
 */

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

interface AnthropicCreateBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  tools?: { name: string; description?: string; input_schema: unknown }[];
  tool_choice?: { type: "tool"; name: string } | { type: "auto" };
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: AnthropicBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicSDKInstance {
  messages: { create(body: AnthropicCreateBody): Promise<AnthropicResponse> };
}

interface AnthropicSDKModule {
  default: new (opts: { apiKey: string }) => AnthropicSDKInstance;
}

const requireFromHere = createRequire(import.meta.url);

function loadSDK(): AnthropicSDKModule {
  try {
    return requireFromHere("@anthropic-ai/sdk") as AnthropicSDKModule;
  } catch (err) {
    throw new Error(
      "@anthropic-ai/sdk is not installed. Install it (`pnpm add @anthropic-ai/sdk`) " +
        "in the consuming app to enable AnthropicAIClient, or configure the tenant " +
        "to use a different provider. " +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface AnthropicAIClientOpts {
  tenantId: string;
  apiKey: string;
}

export class AnthropicAIClient implements AIClient {
  readonly provider = "anthropic" as const;
  private readonly tenantId: string;
  private readonly client: AnthropicSDKInstance;

  constructor(opts: AnthropicAIClientOpts) {
    if (!opts.apiKey) {
      throw new Error("AnthropicAIClient requires a non-empty apiKey.");
    }
    this.tenantId = opts.tenantId;
    const sdk = loadSDK();
    this.client = new sdk.default({ apiKey: opts.apiKey });
  }

  async complete(opts: AICompleteOptions): Promise<AICompleteResult> {
    const model = opts.model ?? DEFAULT_MODEL;
    const start = Date.now();
    try {
      const res = await this.client.messages.create({
        model,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: this.toMessages(opts.prompt),
        ...(opts.system ? { system: opts.system } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
      const latencyMs = Date.now() - start;
      const text = extractText(res.content);
      const inputTokens = res.usage.input_tokens;
      const outputTokens = res.usage.output_tokens;
      const costMicros = computeCostMicros("anthropic", res.model, inputTokens, outputTokens);
      await recordAIUsage({
        tenantId: this.tenantId,
        provider: this.provider,
        model: res.model,
        feature: opts.feature,
        actorMembershipId: opts.actorMembershipId ?? null,
        inputTokens,
        outputTokens,
        costMicros,
        latencyMs,
        requestId: opts.requestId ?? null,
        succeeded: true,
        metadata: { stop_reason: res.stop_reason },
      });
      return { text, model: res.model, inputTokens, outputTokens, costMicros, latencyMs };
    } catch (err) {
      await this.logFailure(opts, model, err, Date.now() - start);
      throw err;
    }
  }

  async completeStructured<T>(opts: AIStructuredCompleteOptions<T>): Promise<T> {
    const model = opts.model ?? DEFAULT_MODEL;
    const schemaName = opts.schemaName ?? "structured_output";
    const start = Date.now();
    try {
      const res = await this.client.messages.create({
        model,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: this.toMessages(opts.prompt),
        ...(opts.system ? { system: opts.system } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        tools: [{ name: schemaName, input_schema: opts.schema }],
        tool_choice: { type: "tool", name: schemaName },
      });
      const latencyMs = Date.now() - start;
      const toolUse = res.content.find(
        (b): b is AnthropicToolUseBlock =>
          b.type === "tool_use" && (b as AnthropicToolUseBlock).name === schemaName,
      );
      if (!toolUse) {
        throw new Error(
          `AnthropicAIClient: response had no tool_use block matching ${schemaName}. ` +
            `stop_reason=${res.stop_reason}`,
        );
      }
      const inputTokens = res.usage.input_tokens;
      const outputTokens = res.usage.output_tokens;
      const costMicros = computeCostMicros("anthropic", res.model, inputTokens, outputTokens);
      await recordAIUsage({
        tenantId: this.tenantId,
        provider: this.provider,
        model: res.model,
        feature: opts.feature,
        actorMembershipId: opts.actorMembershipId ?? null,
        inputTokens,
        outputTokens,
        costMicros,
        latencyMs,
        requestId: opts.requestId ?? null,
        succeeded: true,
        metadata: { stop_reason: res.stop_reason, schema_name: schemaName },
      });
      return toolUse.input as T;
    } catch (err) {
      await this.logFailure(opts, model, err, Date.now() - start);
      throw err;
    }
  }

  private toMessages(prompt: AICompleteOptions["prompt"]): AnthropicMessage[] {
    if (typeof prompt === "string") {
      return [{ role: "user", content: prompt }];
    }
    return prompt.map((m: AIMessage) => ({ role: m.role, content: m.content }));
  }

  private async logFailure(
    opts: AICompleteOptions,
    model: string,
    err: unknown,
    latencyMs: number,
  ): Promise<void> {
    const errorCode = extractErrorCode(err);
    await recordAIUsage({
      tenantId: this.tenantId,
      provider: this.provider,
      model,
      feature: opts.feature,
      actorMembershipId: opts.actorMembershipId ?? null,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0n,
      latencyMs,
      requestId: opts.requestId ?? null,
      succeeded: false,
      errorCode,
    });
  }
}

function extractText(content: AnthropicBlock[]): string {
  return content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function extractErrorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { status?: number; error?: { type?: string }; code?: string };
    if (e.error?.type) return e.error.type;
    if (e.code) return e.code;
    if (typeof e.status === "number") return `http_${e.status}`;
  }
  return "unknown";
}
