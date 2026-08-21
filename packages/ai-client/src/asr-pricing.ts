/**
 * Per-audio-minute ASR pricing, in micros-per-minute.
 *
 * WHY THIS IS A SECOND TABLE AND NOT A ROW IN pricing.ts
 * -----------------------------------------------------
 * Every AI call the platform made before the notetaker was token-priced,
 * so `pricing.ts` models cost as (input_tokens, output_tokens) × a
 * micros-per-token rate. ASR is the first line that is not: it bills per
 * minute of audio, its volume driver is interviews rather than
 * applications, and — the part that matters commercially — it bills
 * whether or not the tenant brings their own LLM key. BYO does not protect
 * this line (COMMERCIAL-sizing-and-hosting-cost-model.md §5.3).
 *
 * Forcing a per-minute rate into a per-token table would mean inventing a
 * fake token count, which is exactly the kind of thing that later reads as
 * real data. Two units, two tables, one shared output: integer
 * `cost_micros` on an `ai_usage_logs` row.
 *
 * The tables also differ in precision, in opposite directions. Per-token
 * rates round to integer micros and therefore *under*-report (Haiku input
 * at $0.80/M logs as $1.00/M — AI-usage-inventory-and-cost-model.md §9.2).
 * Per-minute rates are three orders of magnitude larger, so integer micros
 * are exact here: $0.0043/min is 4,300 micros/min with nothing lost.
 *
 * RATES CAPTURED 2026-08-21 from each vendor's published pay-as-you-go
 * pre-recorded list price. VERIFY BEFORE QUOTING. Rates drift, committed-
 * volume contracts price below list, and AssemblyAI is now the selected
 * vendor (N3.1b) while Deepgram stays reachable behind ASR_PROVIDER. Same
 * caveat as pricing.ts, with more force: this is a COGS line someone will
 * put in front of a client.
 *   - Deepgram pricing:   https://deepgram.com/pricing
 *   - AssemblyAI pricing: https://www.assemblyai.com/pricing
 *
 * DIARISATION — BUNDLED OR AN ADD-ON? Both tables below assume BUNDLED, and
 * both adapters request diarisation on EVERY call because
 * `interview_transcripts.segments` requires a speaker label. On Deepgram it
 * is included in the Nova base rate (on legacy model tiers it was a separate
 * per-minute add-on). On AssemblyAI speaker labels are understood to be
 * included in the core async rate, with only the Audio Intelligence models
 * (summarisation, sentiment, entity detection) priced as add-ons — none of
 * which we enable.
 *
 * That assumption is commercially material and MUST be confirmed against a
 * real invoice or an order form before it reaches a client quote: at the
 * ~45,000 interview-minutes/month the sizing model uses, a $0.002/min
 * diarisation add-on is ~$90/month — enough to move the per-hire COGS number
 * on its own. Check the invoice, not this comment.
 */

/** micros-per-minute. 1 USD = 1,000,000 micros, as everywhere else. */
export interface ASRRate {
  microsPerMinute: number;
}

/**
 * Deepgram pre-recorded, pay-as-you-go. Keys are the model ids we actually
 * send in the `model` query parameter.
 */
const DEEPGRAM_ASR_RATES: Record<string, ASRRate> = {
  // Nova-3 English — $0.0043 / min
  "nova-3": { microsPerMinute: 4300 },
  "nova-3-general": { microsPerMinute: 4300 },
  // Nova-3 multilingual — $0.0052 / min. Costs more; relevant because GCC
  // interviews are not reliably monolingual.
  "nova-3-multilingual": { microsPerMinute: 5200 },
  // Nova-2 — $0.0043 / min. Kept because it is the fallback if a Nova-3
  // regression shows up on non-native English.
  "nova-2": { microsPerMinute: 4300 },
  "nova-2-general": { microsPerMinute: 4300 },
};

/**
 * AssemblyAI async ("pre-recorded") speech-to-text. Keys are the ids we send
 * as `speech_model` on POST /v2/transcript.
 *
 * Their list price is quoted per HOUR, so each entry carries the conversion
 * explicitly — an hourly figure divided by 60 in someone's head is exactly
 * how a rate table acquires a silent 60× error.
 */
const ASSEMBLYAI_ASR_RATES: Record<string, ASRRate> = {
  // Universal, their general-purpose async model — $0.27/hr = $0.0045/min.
  // This is what DEFAULT_ASSEMBLYAI_MODEL sends.
  universal: { microsPerMinute: 4500 },
  // "best" is the legacy alias that now resolves to Universal, so it is
  // priced identically rather than at the older, dearer tier it once meant.
  best: { microsPerMinute: 4500 },
  // Nano — $0.12/hr = $0.002/min. Cheap and multilingual, materially weaker
  // on accented English, which is the whole risk profile of GCC interviews.
  // Priced here so a cost/quality trade is a config change, not a code one.
  nano: { microsPerMinute: 2000 },
};

/**
 * One lookup across both vendors. getASRRate(model) is called by both
 * adapters and takes no provider argument, which is fine because the model
 * ids do not collide — but they are the reason AssemblyAI's short, generic
 * ids ("best", "nano") must never be given a prefix-matchable sibling in the
 * Deepgram table.
 */
const ASR_RATES: Record<string, ASRRate> = { ...DEEPGRAM_ASR_RATES, ...ASSEMBLYAI_ASR_RATES };

/**
 * Fallback for an unrecognised model — deliberately the HIGHEST rate in
 * the table, not a middle one.
 *
 * pricing.ts falls back to a mid rate, and AI-usage-inventory §9.3 flagged
 * that as a real problem: a newly allowlisted model bills at a stand-in
 * rate with only a console.warn. For a per-minute line that under-report
 * would compound over every recorded interview, so the ASR table errs
 * upward. An over-stated ledger prompts someone to fix the table; an
 * under-stated one is invisible until the invoice arrives.
 *
 * DERIVED, not hard-coded: adding a vendor whose top rate exceeds every
 * existing one must not quietly turn this into a mid-table fallback, which
 * is precisely what a literal would have done when AssemblyAI landed.
 */
const UNKNOWN_MODEL_RATE: ASRRate = {
  microsPerMinute: Math.max(...Object.values(ASR_RATES).map((r) => r.microsPerMinute)),
};

export function getASRRate(model: string): ASRRate {
  const exact = ASR_RATES[model];
  if (exact) return exact;
  // Prefix match, e.g. "nova-3-general-20260101" → "nova-3-general".
  // Longest key first so "nova-3-multilingual" is not swallowed by "nova-3".
  const byLongestKey = Object.entries(ASR_RATES).sort(([a], [b]) => b.length - a.length);
  for (const [key, rate] of byLongestKey) {
    if (model.startsWith(key)) return rate;
  }
  console.warn(
    `[ai-client] no ASR pricing entry for model ${model} — using the ` +
      `highest known rate (${UNKNOWN_MODEL_RATE.microsPerMinute} micros/min). ` +
      `Update packages/ai-client/src/asr-pricing.ts.`,
  );
  return UNKNOWN_MODEL_RATE;
}

/**
 * duration → integer micros.
 *
 * Rounds UP (ceil) to the next whole micro. Sub-micro precision is noise at
 * this scale, and rounding up keeps the ledger's bias in the safe
 * direction, consistent with the unknown-model fallback above.
 *
 * Non-finite or non-positive durations return 0n rather than throwing: a
 * zero-length or unmeasurable recording is a real thing the drain worker
 * will meet, and it should log a row with zero cost rather than fail the
 * whole transcription over an arithmetic edge case.
 */
export function computeASRCostMicros(model: string, durationSeconds: number): bigint {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0n;
  const { microsPerMinute } = getASRRate(model);
  return BigInt(Math.ceil((durationSeconds * microsPerMinute) / 60));
}

/** ai_usage_logs.feature for notetaker/interview transcription. */
export const ASR_USAGE_FEATURE = "asr_transcription";
