/**
 * Per-model token pricing in micros-per-token.
 *
 * 1 USD = 1,000,000 micros. Per-token micros = USD per million tokens.
 * (Example: Sonnet input at $3/M tokens → 3 micros per input token.)
 *
 * These rates are snapshot prices as of build time. Pricing pages:
 *   - Anthropic: https://www.anthropic.com/pricing
 *   - OpenAI:    https://openai.com/api/pricing
 *
 * Pricing changes are not a daily concern but they do drift; a future
 * ticket should plumb these from a config table if cost dashboards
 * become a priority. For Wave 1 the table is fine in source.
 *
 * Unknown models fall back to a "default" rate per provider with a
 * warning via console.warn — better than silently logging $0.
 */

import type { AIProvider } from "./types";

interface Rate {
  inputMicrosPerToken: number;
  outputMicrosPerToken: number;
}

const ANTHROPIC_RATES: Record<string, Rate> = {
  // Sonnet line — $3 / $15 per M
  "claude-sonnet-4-6": { inputMicrosPerToken: 3, outputMicrosPerToken: 15 },
  "claude-sonnet-4-5": { inputMicrosPerToken: 3, outputMicrosPerToken: 15 },
  "claude-sonnet-4": { inputMicrosPerToken: 3, outputMicrosPerToken: 15 },
  // Opus line — $15 / $75 per M
  "claude-opus-4-7": { inputMicrosPerToken: 15, outputMicrosPerToken: 75 },
  "claude-opus-4-6": { inputMicrosPerToken: 15, outputMicrosPerToken: 75 },
  // Haiku line — $0.80 / $4 per M (rounded to integer micros: 1 / 4)
  "claude-haiku-4-5": { inputMicrosPerToken: 1, outputMicrosPerToken: 4 },
};

const OPENAI_RATES: Record<string, Rate> = {
  // gpt-5 family — $1.25 / $10 per M as of pricing pull (use 1 / 10 in
  // integer micros; cents-of-a-cent precision lost here is fine for
  // logging, real billing uses provider invoices)
  "gpt-5": { inputMicrosPerToken: 1, outputMicrosPerToken: 10 },
  "gpt-5-mini": { inputMicrosPerToken: 1, outputMicrosPerToken: 2 },
  "gpt-5-nano": { inputMicrosPerToken: 1, outputMicrosPerToken: 1 },
  // gpt-4.1 fallback — $2 / $8 per M
  "gpt-4.1": { inputMicrosPerToken: 2, outputMicrosPerToken: 8 },
  "gpt-4.1-mini": { inputMicrosPerToken: 1, outputMicrosPerToken: 2 },
};

const DEFAULTS: Record<AIProvider, Rate> = {
  anthropic: { inputMicrosPerToken: 3, outputMicrosPerToken: 15 },
  openai: { inputMicrosPerToken: 2, outputMicrosPerToken: 8 },
};

export function getRate(provider: AIProvider, model: string): Rate {
  const table = provider === "anthropic" ? ANTHROPIC_RATES : OPENAI_RATES;
  const exact = table[model];
  if (exact) return exact;
  // Try a prefix match (e.g. "claude-sonnet-4-6-20260301" → "claude-sonnet-4-6").
  for (const [key, rate] of Object.entries(table)) {
    if (model.startsWith(key)) return rate;
  }
  console.warn(
    `[ai-client] no pricing entry for ${provider}:${model} — using default. ` +
      `Update packages/ai-client/src/pricing.ts.`,
  );
  return DEFAULTS[provider];
}

export function computeCostMicros(
  provider: AIProvider,
  model: string,
  inputTokens: number,
  outputTokens: number,
): bigint {
  const rate = getRate(provider, model);
  return (
    BigInt(inputTokens) * BigInt(rate.inputMicrosPerToken) +
    BigInt(outputTokens) * BigInt(rate.outputMicrosPerToken)
  );
}
