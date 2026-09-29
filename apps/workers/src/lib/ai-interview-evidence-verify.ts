/**
 * AI-INT-2 (build plan N4.4) — THE TRUST LAYER between the model's output and
 * the stored evidence report.
 *
 * Pure: no db, no io, no client. Two jobs, both deterministic:
 *
 * 1. QUOTE VERIFICATION. A quote in the evidence report is presented to a
 *    recruiter as the candidate's own words. A model paraphrase presented that
 *    way is a fabrication about a real person in front of a hiring decision —
 *    so every quote is checked against the answer it claims to come from, and
 *    any that is not a verbatim substring (under the normalisation below) is
 *    DROPPED and counted, never repaired. The count is stored
 *    (`meta.quotesDropped`) so a reviewer, and ops, can see how often it
 *    happens.
 *
 *    Normalisation is deliberately narrow — case, whitespace runs, typographic
 *    quotes / apostrophes / dashes / ellipsis — i.e. only differences a human
 *    would not call a different quote. Nothing that changes a WORD is
 *    forgiven: no stemming, no punctuation stripping, no fuzzy match. Wrapping
 *    quote marks and leading/trailing ellipses the model adds around a quote
 *    are trimmed first (the span inside is still exact); an ellipsis in the
 *    MIDDLE joins two spans, is not verbatim, and is dropped.
 *
 * 2. RECONCILIATION against what is actually on record. The model's
 *    `questionKey` / `rubricKey` / knockout `question` are free strings; the
 *    stored report is keyed to the REAL question set, the REAL rubric and the
 *    REAL knockout list, in their order:
 *      - unknown question keys and rubric keys are discarded (their quotes
 *        counted as dropped);
 *      - a question with no answer text is forced to `no_answer` / every
 *        criterion `not_covered` with no quotes, whatever the model said —
 *        evidence cannot exist for words nobody has;
 *      - every question carries at least its OWN rubric key;
 *      - every knockout on record appears exactly once (`not_mentioned` when
 *        the model skipped it).
 *    A model that skipped an ANSWERED question entirely has not produced a
 *    report; that throws EvidenceIncompleteError and the drain retries.
 */

import type {
  AiInterviewCoverage,
  AiInterviewKnockoutEvidence,
  AiInterviewQuestionEvidence,
  AiInterviewRubricEvidence,
  ScorecardCriterion,
} from "@hireops/api-types";
import type { AssembledAnswer } from "./ai-interview-evidence-answers";
import type { AiInterviewEvidenceAiResponse } from "./ai-interview-evidence-prompt";

const QUOTES_PER_RUBRIC_MAX = 3;

/* ─────────────────────────── quote verification ─────────────────────────── */

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

/* ─────────────────────────────── reconciliation ─────────────────────────── */

/** The model skipped an answered question — no report, retry. */
export class EvidenceIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceIncompleteError";
  }
}

export interface ReconciledEvidence {
  questions: AiInterviewQuestionEvidence[];
  knockouts: AiInterviewKnockoutEvidence[];
  summary: string;
  quotesDropped: number;
  answeredCount: number;
}

/** Why an unanswered question has no evidence — a fact about the round, not the candidate. */
export function noAnswerNote(a: AssembledAnswer): string {
  if (a.transcriptUnavailable) {
    return "The candidate answered aloud, but the transcript of this answer is unavailable, so its content could not be reviewed.";
  }
  if (a.answerMode === null) return "This question was not answered.";
  return "No answer text was captured for this question.";
}

/** A question with no answer text: deterministic, no model content. */
export function emptyQuestionEvidence(a: AssembledAnswer): AiInterviewQuestionEvidence {
  const note = noAnswerNote(a);
  return {
    questionKey: a.questionKey,
    answerMode: a.answerMode,
    answerStartMs: a.answerStartMs,
    transcriptUnavailable: a.transcriptUnavailable,
    relevance: "no_answer",
    relevanceNote: note,
    rubric: [{ rubricKey: a.rubricKey, coverage: "not_covered", note, quotes: [] }],
  };
}

/** A knockout nobody spoke to. */
function notMentioned(question: string): AiInterviewKnockoutEvidence {
  return { question, status: "not_mentioned", quote: null, questionKey: null };
}

/**
 * The model's raw response → the stored evidence body (minus `version` /
 * `meta`, which the drain adds). See the module header for every rule.
 *
 * `answers` must carry the SAME text the prompt was built from (i.e. after any
 * PII masking), because that is the text the model could have quoted.
 */
export function reconcileEvidence(args: {
  raw: AiInterviewEvidenceAiResponse;
  answers: readonly AssembledAnswer[];
  rubric: readonly ScorecardCriterion[];
  knockouts: readonly string[];
}): ReconciledEvidence {
  let quotesDropped = 0;
  const rubricKeys = new Set(args.rubric.map((c) => c.key));
  const answerByKey = new Map(args.answers.map((a) => [a.questionKey, a]));

  // First entry per key wins; entries for unknown keys are discarded whole.
  const rawByKey = new Map<string, AiInterviewEvidenceAiResponse["questions"][number]>();
  for (const q of args.raw.questions) {
    if (!answerByKey.has(q.questionKey) || rawByKey.has(q.questionKey)) {
      quotesDropped += q.rubric.reduce((n, r) => n + r.quotes.length, 0);
      continue;
    }
    rawByKey.set(q.questionKey, q);
  }

  const questions: AiInterviewQuestionEvidence[] = args.answers.map((a) => {
    const raw = rawByKey.get(a.questionKey);

    if (a.text === null) {
      // No words → no evidence, whatever the model said about them.
      if (raw) quotesDropped += raw.rubric.reduce((n, r) => n + r.quotes.length, 0);
      return emptyQuestionEvidence(a);
    }
    if (!raw) {
      throw new EvidenceIncompleteError(
        `model returned no evidence for answered question ${a.questionKey}`,
      );
    }

    const rubric: AiInterviewRubricEvidence[] = [];
    const seen = new Set<string>();
    for (const r of raw.rubric) {
      if (!rubricKeys.has(r.rubricKey) && r.rubricKey !== a.rubricKey) {
        quotesDropped += r.quotes.length;
        continue;
      }
      if (seen.has(r.rubricKey)) {
        quotesDropped += r.quotes.length;
        continue;
      }
      seen.add(r.rubricKey);

      const kept: string[] = [];
      const keptNorm = new Set<string>();
      for (const quote of r.quotes) {
        const cleaned = cleanQuote(quote);
        const norm = normaliseForQuoteMatch(cleaned);
        if (
          !isVerbatimQuote(cleaned, a.text) ||
          keptNorm.has(norm) ||
          kept.length >= QUOTES_PER_RUBRIC_MAX
        ) {
          quotesDropped += 1;
          continue;
        }
        keptNorm.add(norm);
        kept.push(cleaned);
      }
      rubric.push({
        rubricKey: r.rubricKey,
        coverage: r.coverage,
        note: r.note.trim(),
        quotes: kept,
      });
    }

    // The question's own criterion leads, and is always present.
    const ownIdx = rubric.findIndex((r) => r.rubricKey === a.rubricKey);
    if (ownIdx === -1) {
      rubric.unshift({
        rubricKey: a.rubricKey,
        coverage: "not_covered" satisfies AiInterviewCoverage,
        note: "No evidence for this criterion was identified in this answer.",
        quotes: [],
      });
    } else if (ownIdx > 0) {
      rubric.unshift(...rubric.splice(ownIdx, 1));
    }

    return {
      questionKey: a.questionKey,
      answerMode: a.answerMode,
      answerStartMs: a.answerStartMs,
      transcriptUnavailable: a.transcriptUnavailable,
      relevance: raw.relevance,
      relevanceNote: raw.relevanceNote.trim(),
      rubric,
    };
  });

  // ── knockouts: exactly the ones on record, in order ───────────────────
  const rawKnockouts = new Map<string, AiInterviewEvidenceAiResponse["knockouts"][number]>();
  const onRecord = new Set(args.knockouts.map(normaliseForQuoteMatch));
  for (const k of args.raw.knockouts) {
    const norm = normaliseForQuoteMatch(k.question);
    if (!onRecord.has(norm) || rawKnockouts.has(norm)) {
      if (k.quote !== null) quotesDropped += 1;
      continue;
    }
    rawKnockouts.set(norm, k);
  }

  const answered = args.answers.filter((a) => a.text !== null);
  const knockouts: AiInterviewKnockoutEvidence[] = args.knockouts.map((question) => {
    const raw = rawKnockouts.get(normaliseForQuoteMatch(question));
    if (!raw) return notMentioned(question);
    if (raw.status === "not_mentioned") {
      if (raw.quote !== null) quotesDropped += 1;
      return notMentioned(question);
    }

    const claimedKey =
      raw.questionKey !== null && answerByKey.get(raw.questionKey)?.text != null
        ? raw.questionKey
        : null;

    if (raw.quote === null) {
      return { question, status: raw.status, quote: null, questionKey: claimedKey };
    }

    const cleaned = cleanQuote(raw.quote);
    // The claimed answer first, then any answer — the quote is stored against
    // whichever answer it is actually IN.
    const claimed = claimedKey ? answerByKey.get(claimedKey) : undefined;
    const home =
      claimed && isVerbatimQuote(cleaned, claimed.text)
        ? claimed
        : answered.find((a) => isVerbatimQuote(cleaned, a.text));
    if (!home) {
      quotesDropped += 1;
      return { question, status: raw.status, quote: null, questionKey: claimedKey };
    }
    return { question, status: raw.status, quote: cleaned, questionKey: home.questionKey };
  });

  return {
    questions,
    knockouts,
    summary: args.raw.summary.trim(),
    quotesDropped,
    answeredCount: answered.length,
  };
}
