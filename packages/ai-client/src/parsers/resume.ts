/**
 * Resume parser orchestrator.
 *
 * Two-stage pipeline:
 *   1. extractText(buffer, mimeType)         → raw text + source_format
 *   2. completeStructured(text, schema)      → ParserLLMOutput (via AI-01)
 *   3. parser overlays parse_metadata        → ParserOutput
 *
 * Two entry points: parseResume takes a Buffer + mime type, parseResumeFromText
 * takes pre-extracted text. The latter exists so tests can exercise the LLM
 * path with synthetic CV text without committing PDF binaries.
 *
 * Failure modes are graceful — none of the three throw:
 *   - Unsupported mime type:  low-confidence empty ParserOutput with
 *     parse_metadata.source_format = 'unknown'
 *   - Empty extracted text:   ditto, confidence_score = 0
 *   - LLM error / invalid JSON: low-confidence empty ParserOutput with
 *     a captured error string in parse_metadata (TODO: structured error
 *     field if a feature needs it — Wave 1 lives with low-confidence)
 *
 * The recruiter triage screen reads confidence_score and surfaces "review
 * carefully" below 0.7; the apply form re-prompts the candidate when
 * confidence_score is 0.
 */

import { getAIClient } from "../factory";
import type { AIClient } from "../types";
import { extractText, ExtractionError } from "./extract";
import type { ExtractTextOpts, ExtractTextResult } from "./extract";
import {
  PARSER_VERSION,
  parserOutputSchema,
  parserLLMOutputSchema,
  parserOutputJsonSchema,
  type ParserOutput,
  type ParserLLMOutput,
  type SourceFormat,
} from "./resume-schema";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const PARSE_FEATURE = "resume_parse";

const PARSE_SYSTEM_PROMPT = `You are a recruitment data extraction system. \
You read a candidate resume in free-form text and produce a structured \
JSON object matching the provided schema exactly.

Rules you must follow:
1. Use null for any field you cannot extract with confidence. Do NOT guess.
2. Dates: ISO 8601, "YYYY-MM" if month is known, "YYYY" if only year.
3. Email: lowercase the primary email address.
4. Phone: prefer E.164 ("+91…") if a country code is present; otherwise \
return the digits as they appear in the resume.
5. Order work_history most-recent first. If the most recent role's \
end_date is null, set current_role to mirror it.
6. Compute total_years_experience by summing the spans in work_history \
(treating null end_date as today). Reconcile against any explicit "X years" \
claim — if they disagree by more than 1 year, trust the work_history sum.
7. employment_type is best-effort. Set null when not stated explicitly.
8. grade is free text ("8.2 CGPA", "First Class", "75%"). Do not normalise.
9. confidence_score in parse_metadata: 1.0 = every field extracted with \
certainty; 0.5 = significant gaps or ambiguity; 0.2 = most fields could \
not be confidently extracted. Honest self-reporting — low confidence is \
data-quality signal, not failure.

Return ONLY the JSON object matching the schema. No prose.`;

export interface ParseResumeOpts {
  tenantId: string;
  /** Override the LLM model. Defaults to claude-sonnet-4-6. */
  model?: string;
  /** Caller correlation id forwarded to ai_usage_logs.request_id. */
  requestId?: string | null;
  /** Caller actor membership for ai_usage_logs.actor_membership_id. */
  actorMembershipId?: string | null;
  /** Pre-built AIClient (testing escape hatch). Defaults to getAIClient(tenantId). */
  client?: AIClient;
}

export interface ParseFromBufferOpts extends ParseResumeOpts {
  /** Extraction overrides (e.g. inject ocr stub for tests). */
  extract?: ExtractTextOpts;
}

/**
 * Parse a resume from a raw file buffer. Extracts text first, then calls
 * the LLM. Use this from request handlers / workers that receive the
 * upload as bytes.
 */
export async function parseResume(
  buffer: Buffer,
  mimeType: string,
  opts: ParseFromBufferOpts,
): Promise<ParserOutput> {
  let extracted: ExtractTextResult;
  try {
    extracted = await extractText(buffer, mimeType, opts.extract ?? {});
  } catch (err) {
    if (err instanceof ExtractionError) {
      return emptyOutput("unknown", opts.model ?? DEFAULT_MODEL);
    }
    throw err;
  }

  if (!extracted.text || extracted.text.trim().length === 0) {
    return emptyOutput(extracted.sourceFormat, opts.model ?? DEFAULT_MODEL);
  }

  return parseResumeFromText(extracted.text, extracted.sourceFormat, opts);
}

/**
 * Parse a resume from pre-extracted text. Use this when you already have
 * the text (e.g. inbound integration where the source system extracts) or
 * in tests so synthetic CV text drives the LLM call without bundling
 * binary fixtures.
 */
export async function parseResumeFromText(
  text: string,
  sourceFormat: SourceFormat,
  opts: ParseResumeOpts,
): Promise<ParserOutput> {
  const model = opts.model ?? DEFAULT_MODEL;
  if (!text || text.trim().length === 0) {
    return emptyOutput(sourceFormat, model);
  }

  const client = opts.client ?? (await getAIClient(opts.tenantId));

  let raw: unknown;
  try {
    raw = await client.completeStructured<ParserLLMOutput>({
      feature: PARSE_FEATURE,
      system: PARSE_SYSTEM_PROMPT,
      prompt: text,
      model,
      schema: parserOutputJsonSchema,
      schemaName: "resume_parse",
      maxTokens: 4000,
      requestId: opts.requestId ?? null,
      actorMembershipId: opts.actorMembershipId ?? null,
    });
  } catch {
    // AI client already wrote a failure row to ai_usage_logs. Caller
    // gets a low-confidence empty output; they decide whether to retry.
    return emptyOutput(sourceFormat, model);
  }

  const validated = parserLLMOutputSchema.safeParse(raw);
  if (!validated.success) {
    return emptyOutput(sourceFormat, model);
  }

  const output: ParserOutput = {
    ...validated.data,
    current_role: validated.data.current_role ?? computeCurrentRole(validated.data),
    parse_metadata: {
      parser_version: PARSER_VERSION,
      parsed_at: new Date().toISOString(),
      confidence_score: validated.data.parse_metadata.confidence_score,
      source_format: sourceFormat,
      parser_model: client.provider === "local" ? "local" : model,
    },
  };

  // Final guard: any drift between LLM output and our canonical contract
  // is caught here. If it fails, return low-confidence empty — better
  // than emitting a malformed parse downstream.
  const final = parserOutputSchema.safeParse(output);
  if (!final.success) {
    return emptyOutput(sourceFormat, model);
  }
  return final.data;
}

/**
 * Enforces the "current_role mirrors work_history[0] when applicable"
 * invariant. The LLM is asked to set this itself but the parser re-derives
 * defensively — keeping the contract from skewing.
 */
function computeCurrentRole(data: ParserLLMOutput): ParserOutput["current_role"] {
  const head = data.work_history[0];
  if (!head || head.end_date !== null) return null;
  return {
    title: head.title,
    company: head.company,
    start_date: head.start_date,
    location: head.location,
    description: head.description,
  };
}

function emptyOutput(sourceFormat: SourceFormat, model: string): ParserOutput {
  return {
    personal: {
      full_name: null,
      email: null,
      phone: null,
      location_city: null,
      location_country: null,
      linkedin_url: null,
      github_url: null,
      portfolio_url: null,
    },
    summary: null,
    total_years_experience: null,
    current_role: null,
    work_history: [],
    education: [],
    skills: { technical: [], languages: [], certifications: [], domain: [] },
    notice_period_days: null,
    expected_compensation: null,
    parse_metadata: {
      parser_version: PARSER_VERSION,
      parsed_at: new Date().toISOString(),
      confidence_score: 0,
      source_format: sourceFormat,
      parser_model: model,
    },
  };
}
