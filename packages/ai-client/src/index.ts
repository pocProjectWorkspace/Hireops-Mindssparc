/**
 * Public surface of @hireops/ai-client.
 *
 * Pluggable LLM client: AnthropicAIClient + OpenAIAIClient backed by
 * vendor SDKs (lazy-loaded peer deps), plus LocalAIClient which serves
 * deterministic fixtures by sha256 hash of prompt+system+model+schema.
 *
 * Per-tenant routing: getAIClient(tenant_id) reads
 * tenants.settings.ai_provider (default 'anthropic') and fetches the
 * 'ai_anthropic' / 'ai_openai' credential via the existing
 * integration_credentials envelope-decryption pathway.
 *
 * Every complete() / completeStructured() call writes an ai_usage_logs
 * row — success or failure — for per-tenant cost attribution. Writes go
 * through the unscoped pool (service_role) the same way
 * storeIntegrationCredential does; reads are RLS-scoped via the
 * tenant_isolation_select policy.
 *
 * Tests + NODE_ENV=test force LocalAIClient regardless of tenant config,
 * so CI never burns real tokens. AI_CLIENT_MODE=local has the same effect.
 */

export { LocalAIClient } from "./local";
export type { LocalAIClientOpts } from "./local";

export { AnthropicAIClient } from "./anthropic";
export type { AnthropicAIClientOpts } from "./anthropic";

export { OpenAIAIClient } from "./openai";
export type { OpenAIAIClientOpts } from "./openai";

export { getAIClient, resetAIClientCache, resolveProvider } from "./factory";
export type { GetAIClientOpts } from "./factory";

export {
  resolveTenantAiSettings,
  resolveTenantAiSettingsDb,
  resolveTenantBiasLexiconDb,
  resolveTenantScoringWeights,
  resolveTenantScoringWeightsDb,
  resolveTenantScreeningPrivacyDb,
  resolveTenantFeedbackSharingDb,
  isDefaultScoringWeights,
  scoringWeightsEmphasis,
} from "./tenant-settings";
export type {
  AiSettings,
  BiasLexicon,
  ScoringWeights,
  ScreeningPrivacy,
  FeedbackSharing,
  ScoringWeightEmphasisEntry,
} from "./tenant-settings";

export { maskPii, maskPiiIf, REDACTED_EMAIL, REDACTED_PHONE, REDACTED_URL } from "./pii-mask";

export { recordAIUsage } from "./usage-log";
export type { UsageLogInput } from "./usage-log";

export { computeCostMicros, getRate } from "./pricing";

// ASR (speech-to-text) — N3.1. Per-audio-minute pricing, hence a second
// rate table alongside the per-token one; see asr-pricing.ts.
export { computeASRCostMicros, getASRRate, ASR_USAGE_FEATURE } from "./asr-pricing";
export type { ASRRate } from "./asr-pricing";

export {
  getASRClient,
  resetASRClient,
  LocalASRClient,
  DeepgramASRClient,
  AssemblyAIASRClient,
  hashTranscribeInput,
  LOCAL_ASR_MODEL,
  DEFAULT_DEEPGRAM_MODEL,
  DEFAULT_ASSEMBLYAI_MODEL,
  ASSEMBLYAI_US_BASE_URL,
  ASSEMBLYAI_EU_BASE_URL,
  resolveAssemblyAIBaseUrl,
  ASRError,
  ASRUnsupportedMediaError,
} from "./asr";
export type {
  ASRClient,
  ASRProvider,
  ASRResult,
  ASRSegment,
  ASRTranscribeOptions,
  LocalASRClientOpts,
  DeepgramASRClientOpts,
  AssemblyAIASRClientOpts,
} from "./asr";

export { hashCompleteOptions, hashStructuredOptions } from "./local/hash";

export type {
  AIClient,
  AIProvider,
  AIMessage,
  AIJsonSchema,
  AICompleteOptions,
  AIStructuredCompleteOptions,
  AICompleteResult,
  AIUsageLogEntry,
} from "./types";

// Resume parser (AI-02).
export { parseResume, parseResumeFromText } from "./parsers/resume";
export type { ParseResumeOpts, ParseFromBufferOpts } from "./parsers/resume";
export { extractText, ExtractionError } from "./parsers/extract";
export type { ExtractTextOpts, ExtractTextResult } from "./parsers/extract";
export {
  PARSER_VERSION,
  parserOutputSchema,
  parserLLMOutputSchema,
  parserOutputJsonSchema,
} from "./parsers/resume-schema";
export type {
  ParserOutput,
  ParserLLMOutput,
  ParseMetadata,
  SourceFormat,
} from "./parsers/resume-schema";
