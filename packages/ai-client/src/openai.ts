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
 * OpenAI-backed AI client.
 *
 * Default model: gpt-5 — current canonical OpenAI flagship at build time.
 * Callers needing cheaper inference can pass `model: 'gpt-5-mini'` or
 * `'gpt-5-nano'`.
 *
 * Structured output: `response_format: { type: 'json_schema',
 * json_schema: { name, schema, strict: true } }` — the OpenAI Structured
 * Outputs feature, which guarantees schema conformance. Stricter than
 * tools/function-calling, which is best-effort. If the API has evolved
 * to a newer canonical structured-output mode by deploy time, swap
 * here.
 *
 * SDK: openai, lazy-loaded via createRequire so apps that don't enable
 * OpenAI never have to install it.
 */

const DEFAULT_MODEL = "gpt-5";
const DEFAULT_MAX_TOKENS = 4096;

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIChatCompletionBody {
  model: string;
  messages: OpenAIChatMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: {
    type: "json_schema";
    json_schema: { name: string; schema: unknown; strict: true };
  };
}

interface OpenAIChatCompletionResponse {
  id: string;
  model: string;
  choices: {
    message: { role: string; content: string | null };
    finish_reason: string | null;
  }[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

interface OpenAISDKInstance {
  chat: {
    completions: {
      create(body: OpenAIChatCompletionBody): Promise<OpenAIChatCompletionResponse>;
    };
  };
}

interface OpenAISDKModule {
  default: new (opts: { apiKey: string }) => OpenAISDKInstance;
}

const requireFromHere = createRequire(import.meta.url);

function loadSDK(): OpenAISDKModule {
  try {
    return requireFromHere("openai") as OpenAISDKModule;
  } catch (err) {
    throw new Error(
      "openai is not installed. Install it (`pnpm add openai`) in the consuming " +
        "app to enable OpenAIAIClient, or configure the tenant to use a different " +
        "provider. " +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface OpenAIAIClientOpts {
  tenantId: string;
  apiKey: string;
}

export class OpenAIAIClient implements AIClient {
  readonly provider = "openai" as const;
  private readonly tenantId: string;
  private readonly client: OpenAISDKInstance;

  constructor(opts: OpenAIAIClientOpts) {
    if (!opts.apiKey) {
      throw new Error("OpenAIAIClient requires a non-empty apiKey.");
    }
    this.tenantId = opts.tenantId;
    const sdk = loadSDK();
    this.client = new sdk.default({ apiKey: opts.apiKey });
  }

  async complete(opts: AICompleteOptions): Promise<AICompleteResult> {
    const model = opts.model ?? DEFAULT_MODEL;
    const start = Date.now();
    try {
      const res = await this.client.chat.completions.create({
        model,
        messages: this.toMessages(opts),
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
      const latencyMs = Date.now() - start;
      const text = res.choices[0]?.message.content ?? "";
      const inputTokens = res.usage.prompt_tokens;
      const outputTokens = res.usage.completion_tokens;
      const costMicros = computeCostMicros("openai", res.model, inputTokens, outputTokens);
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
        metadata: { finish_reason: res.choices[0]?.finish_reason ?? null },
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
      const res = await this.client.chat.completions.create({
        model,
        messages: this.toMessages(opts),
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, schema: opts.schema, strict: true },
        },
      });
      const latencyMs = Date.now() - start;
      const raw = res.choices[0]?.message.content ?? "";
      const inputTokens = res.usage.prompt_tokens;
      const outputTokens = res.usage.completion_tokens;
      const costMicros = computeCostMicros("openai", res.model, inputTokens, outputTokens);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        await this.logFailure(opts, model, parseErr, latencyMs);
        throw new Error(
          `OpenAIAIClient: structured output returned non-JSON content. raw=${raw.slice(0, 120)}...`,
        );
      }
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
        metadata: {
          finish_reason: res.choices[0]?.finish_reason ?? null,
          schema_name: schemaName,
        },
      });
      return parsed as T;
    } catch (err) {
      await this.logFailure(opts, model, err, Date.now() - start);
      throw err;
    }
  }

  private toMessages(opts: AICompleteOptions): OpenAIChatMessage[] {
    const out: OpenAIChatMessage[] = [];
    if (opts.system) out.push({ role: "system", content: opts.system });
    if (typeof opts.prompt === "string") {
      out.push({ role: "user", content: opts.prompt });
    } else {
      for (const m of opts.prompt as AIMessage[]) {
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
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

function extractErrorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { status?: number; code?: string; type?: string };
    if (e.code) return e.code;
    if (e.type) return e.type;
    if (typeof e.status === "number") return `http_${e.status}`;
  }
  return "unknown";
}
