/**
 * Verbatim-quote verification — shared by every evidence engine that shows a
 * recruiter "the candidate's own words".
 *
 * EXTRACTED VERBATIM (PC-6) from apps/workers/src/lib/ai-interview-evidence-verify.ts
 * (AI-INT-2), which now re-exports these three functions unchanged. The CV
 * screening evidence (./screening-evidence.ts) needs the SAME answer to "is this
 * quote really in the source text?" and two copies of a matcher would drift.
 * Do not change the semantics here without re-running
 * apps/api/test/ai-interview-04a-evidence-units.test.ts.
 *
 * Normalisation is deliberately narrow — case, whitespace runs, typographic
 * quotes / apostrophes / dashes / ellipsis — i.e. only differences a human
 * would not call a different quote. Nothing that changes a WORD is forgiven:
 * no stemming, no punctuation stripping, no fuzzy match. Wrapping quote marks
 * and leading/trailing ellipses the model adds around a quote are trimmed first
 * (the span inside is still exact); an ellipsis in the MIDDLE joins two spans,
 * is not verbatim, and is dropped.
 */

/**
 * The comparison form of a string: lowercase, typographic punctuation folded
 * to ASCII, every whitespace run (incl. NBSP) collapsed to one space, trimmed.
 */
export function normaliseForQuoteMatch(input: string): string {
  return (
    input
      .normalize("NFC")
      .toLowerCase()
      // single quotes / apostrophes / primes
      .replace(/[‘’‚‛′`´]/g, "'")
      // double quotes / double primes / guillemets
      .replace(/[“”„‟″«»]/g, '"')
      // hyphens, dashes, minus
      .replace(/[‐‑‒–—―−]/g, "-")
      .replace(/…/g, "...")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const WRAPPING = /^[\s"'‘’“”«»]+|[\s"'‘’“”«»]+$/g;
const EDGE_ELLIPSIS = /^(?:\.{3}|…)\s*|\s*(?:\.{3}|…)$/g;

/**
 * The quote as it will be stored: wrapping quote marks and edge ellipses the
 * model added are removed (repeatedly, so `"…text…"` unwraps fully). The span
 * that remains is what gets verified. Returns "" when nothing remains.
 */
export function cleanQuote(quote: string): string {
  let prev: string;
  let out = quote;
  do {
    prev = out;
    out = out.replace(WRAPPING, "").replace(EDGE_ELLIPSIS, "");
  } while (out !== prev);
  return out.trim();
}

/** Is `quote` (after cleanQuote) a verbatim substring of `answerText`? */
export function isVerbatimQuote(quote: string, answerText: string | null): boolean {
  if (answerText === null) return false;
  const q = normaliseForQuoteMatch(cleanQuote(quote));
  if (q.length === 0) return false;
  return normaliseForQuoteMatch(answerText).includes(q);
}
