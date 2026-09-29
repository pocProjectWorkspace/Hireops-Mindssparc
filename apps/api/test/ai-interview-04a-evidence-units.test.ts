/**
 * AI-INT-2 (N4.4) — the PURE half of the evidence engine: answer slicing,
 * quote verification, reconciliation, and the no-score stance in the schemas
 * and the prompt.
 *
 * NO DATABASE. Nothing here imports bootstrap or @hireops/db, so this file
 * runs anywhere (`npx vitest run test/ai-interview-04a-evidence-units.test.ts`
 * from apps/api). It lives beside the other worker tests because apps/workers
 * has no test runner of its own.
 */

import { describe, expect, it } from "vitest";
import { aiInterviewEvidenceSchema, type AiInterviewQuestion } from "@hireops/api-types";
import {
  assembleAnswers,
  coerceEvidenceAnswers,
  sliceVoiceAnswer,
  type EvidenceTranscriptSegment,
} from "../../../apps/workers/src/lib/ai-interview-evidence-answers.js";
import {
  cleanQuote,
  EvidenceIncompleteError,
  isVerbatimQuote,
  normaliseForQuoteMatch,
  reconcileEvidence,
} from "../../../apps/workers/src/lib/ai-interview-evidence-verify.js";
import {
  aiInterviewEvidenceAiSchema,
  buildAiInterviewEvidencePrompt,
  type AiInterviewEvidenceAiResponse,
} from "../../../apps/workers/src/lib/ai-interview-evidence-prompt.js";

/** Index into an array, failing loudly instead of a non-null assertion. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected an element at index ${i}`);
  return v;
}

const SEGMENTS: EvidenceTranscriptSegment[] = [
  { speaker: "speaker_0", startMs: 0, endMs: 4_000, text: "I led the payments migration." },
  { speaker: "speaker_0", startMs: 4_000, endMs: 9_000, text: " We moved to idempotent writes. " },
  { speaker: "speaker_0", startMs: 10_000, endMs: 14_000, text: "For reconciliation I used SQL." },
  // Straddles the q2/q3 boundary at 20s.
  { speaker: "speaker_0", startMs: 18_000, endMs: 22_000, text: "That took a quarter." },
  { speaker: "speaker_0", startMs: 25_000, endMs: 30_000, text: "I have a CPA." },
];

const RUBRIC = [
  { key: "technical_depth", label: "Technical depth" },
  { key: "communication", label: "Communication" },
  { key: "ownership", label: "Ownership" },
];

const QUESTIONS: AiInterviewQuestion[] = [
  { key: "q1", prompt: "Tell me about a migration you led.", rubricKey: "ownership" },
  { key: "q2", prompt: "How do you reconcile ledgers?", rubricKey: "technical_depth" },
  { key: "q3", prompt: "What qualifications do you hold?", rubricKey: "communication" },
  { key: "q4", prompt: "Describe a hard conversation.", rubricKey: "communication" },
];

describe("sliceVoiceAnswer — the overlap rule", () => {
  it("joins overlapping segments in order, trimmed, with single spaces", () => {
    const s = sliceVoiceAnswer(SEGMENTS, 0, 9_500);
    expect(s.text).toBe("I led the payments migration. We moved to idempotent writes.");
    expect(s.firstStartMs).toBe(0);
  });

  it("a segment that merely TOUCHES a boundary belongs to one side only", () => {
    // Window [4000, 9000): the first segment ends at exactly 4000 → excluded.
    const s = sliceVoiceAnswer(SEGMENTS, 4_000, 9_000);
    expect(s.text).toBe("We moved to idempotent writes.");
    expect(s.firstStartMs).toBe(4_000);
  });

  it("a segment straddling a boundary lands in BOTH answers", () => {
    expect(sliceVoiceAnswer(SEGMENTS, 10_000, 20_000).text).toBe(
      "For reconciliation I used SQL. That took a quarter.",
    );
    const q3 = sliceVoiceAnswer(SEGMENTS, 20_000, 31_000);
    expect(q3.text).toBe("That took a quarter. I have a CPA.");
    expect(q3.firstStartMs).toBe(18_000);
  });

  it("orders by startMs even when stored out of order", () => {
    const shuffled = [at(SEGMENTS, 2), at(SEGMENTS, 0)];
    expect(sliceVoiceAnswer(shuffled, 0, 15_000).text).toBe(
      "I led the payments migration. For reconciliation I used SQL.",
    );
  });

  it("no overlap (or only blank text) → null text, null seek point", () => {
    expect(sliceVoiceAnswer(SEGMENTS, 50_000, 60_000)).toEqual({ text: null, firstStartMs: null });
    expect(sliceVoiceAnswer([{ speaker: "s", startMs: 0, endMs: 10, text: "   " }], 0, 10)).toEqual(
      { text: null, firstStartMs: null },
    );
  });
});

describe("assembleAnswers", () => {
  const answers = coerceEvidenceAnswers({
    version: 1,
    answers: [
      { questionKey: "q1", mode: "voice", answeredAt: "x", startMs: 0, endMs: 9_500, text: null },
      {
        questionKey: "q2",
        mode: "typed",
        answeredAt: "x",
        startMs: null,
        endMs: null,
        text: "  Old  ",
      },
      // A later capture for q2 supersedes the earlier one.
      {
        questionKey: "q2",
        mode: "typed",
        answeredAt: "x",
        startMs: null,
        endMs: null,
        text: "  I tie out sub-ledgers daily.  ",
      },
      // No offsets reported by the browser.
      { questionKey: "q3", mode: "voice", answeredAt: "x", startMs: null, endMs: null, text: null },
      { questionKey: "q9", mode: "bogus", answeredAt: "x" },
    ],
  });

  it("coerce drops malformed entries", () => {
    expect(answers.map((a) => a.questionKey)).toEqual(["q1", "q2", "q2", "q3"]);
    expect(coerceEvidenceAnswers(null)).toEqual([]);
    expect(coerceEvidenceAnswers({ answers: "nope" })).toEqual([]);
  });

  it("pairs every question in order: voice sliced, typed trimmed (last wins), unanswered null", () => {
    const out = assembleAnswers({
      questions: QUESTIONS,
      answers,
      segments: SEGMENTS,
      rubric: RUBRIC,
    });
    expect(out.map((a) => a.questionKey)).toEqual(["q1", "q2", "q3", "q4"]);

    expect(out[0]).toMatchObject({
      answerMode: "voice",
      text: "I led the payments migration. We moved to idempotent writes.",
      answerStartMs: 0,
      transcriptUnavailable: false,
      rubricLabel: "Ownership",
    });
    expect(out[1]).toMatchObject({
      answerMode: "typed",
      text: "I tie out sub-ledgers daily.",
      answerStartMs: null,
      transcriptUnavailable: false,
    });
    // Voice with no window: the words cannot be located → unavailable.
    expect(out[2]).toMatchObject({ answerMode: "voice", text: null, transcriptUnavailable: true });
    expect(out[3]).toMatchObject({ answerMode: null, text: null, transcriptUnavailable: false });
  });

  it("no transcript → every voice answer unavailable; typed answers unaffected", () => {
    const out = assembleAnswers({ questions: QUESTIONS, answers, segments: null, rubric: RUBRIC });
    expect(out[0]).toMatchObject({ answerMode: "voice", text: null, transcriptUnavailable: true });
    expect(at(out, 1).text).toBe("I tie out sub-ledgers daily.");
  });
});

describe("quote verification", () => {
  const answer = "I said we’d migrate — carefully — in  two\nphases. Then we did it.";

  it("normalisation folds case, whitespace and typographic punctuation only", () => {
    expect(normaliseForQuoteMatch("  We’D  go—now… ")).toBe("we'd go-now...");
  });

  it("accepts a verbatim span despite curly quotes, dashes, case and whitespace", () => {
    expect(isVerbatimQuote("we'd migrate - carefully - in two phases", answer)).toBe(true);
    expect(isVerbatimQuote("THEN WE DID IT.", answer)).toBe(true);
  });

  it("strips wrapping quote marks and EDGE ellipses the model adds", () => {
    expect(cleanQuote('"…in two phases…"')).toBe("in two phases");
    expect(cleanQuote("...Then we did it...")).toBe("Then we did it");
    expect(isVerbatimQuote("“in two phases.”", answer)).toBe(true);
  });

  it("rejects paraphrase, a changed word, and a mid-quote ellipsis joining two spans", () => {
    expect(isVerbatimQuote("we would migrate carefully", answer)).toBe(false);
    expect(isVerbatimQuote("in three phases", answer)).toBe(false);
    expect(isVerbatimQuote("I said ... two phases", answer)).toBe(false);
  });

  it("rejects empty quotes and null answers", () => {
    expect(isVerbatimQuote('""', answer)).toBe(false);
    expect(isVerbatimQuote("anything", null)).toBe(false);
  });
});

describe("reconcileEvidence", () => {
  const assembled = assembleAnswers({
    questions: QUESTIONS,
    answers: coerceEvidenceAnswers({
      answers: [
        { questionKey: "q1", mode: "voice", startMs: 0, endMs: 9_500 },
        { questionKey: "q2", mode: "typed", text: "I tie out sub-ledgers daily using SQL." },
        { questionKey: "q3", mode: "voice", startMs: null, endMs: null },
      ],
    }),
    segments: SEGMENTS,
    rubric: RUBRIC,
  });
  const KNOCKOUTS = ["Do you hold a CPA?", "Can you work from Pune?"];

  const raw: AiInterviewEvidenceAiResponse = {
    questions: [
      {
        questionKey: "q2",
        relevance: "addresses",
        relevanceNote: "Describes a daily sub-ledger tie-out.",
        rubric: [
          // Not the own key first — reconcile must move own key to the front.
          {
            rubricKey: "communication",
            coverage: "partial",
            note: "Mentions a routine.",
            quotes: ["daily"],
          },
          {
            rubricKey: "technical_depth",
            coverage: "covered",
            note: "Names the tool used.",
            quotes: [
              "using SQL",
              "USING  SQL", // duplicate under normalisation → dropped
              "I reconcile with Python", // fabricated → dropped
            ],
          },
          { rubricKey: "leadership", coverage: "covered", note: "x", quotes: ["daily"] }, // unknown key
        ],
      },
      {
        questionKey: "q1",
        relevance: "addresses",
        relevanceNote: "Describes leading a migration.",
        rubric: [
          {
            rubricKey: "technical_depth",
            coverage: "covered",
            note: "Idempotent writes.",
            quotes: ["We moved to idempotent writes."],
          },
        ],
      },
      {
        // q3's transcript is unavailable — anything the model says is discarded.
        questionKey: "q3",
        relevance: "addresses",
        relevanceNote: "Invented.",
        rubric: [
          { rubricKey: "communication", coverage: "covered", note: "x", quotes: ["a", "b"] },
        ],
      },
      {
        questionKey: "q99",
        relevance: "off_topic",
        relevanceNote: "x",
        rubric: [{ rubricKey: "ownership", coverage: "covered", note: "x", quotes: ["z"] }],
      },
    ],
    knockouts: [
      {
        question: "do you hold a CPA?",
        status: "confirmed",
        quote: "I have a CPA.",
        questionKey: "q2",
      },
      {
        question: "Something not on record",
        status: "confirmed",
        quote: "made up",
        questionKey: null,
      },
    ],
    summary: "  Covered a migration and a reconciliation routine.  ",
  };

  it("keys the report to the REAL questions, rubric and knockouts — and verifies every quote", () => {
    // q1's answer does not contain "I have a CPA." (that is at 25s) — so the
    // knockout quote must be searched for in every answer and, not being in
    // any answer text, dropped.
    const r = reconcileEvidence({ raw, answers: assembled, rubric: RUBRIC, knockouts: KNOCKOUTS });

    expect(r.questions.map((q) => q.questionKey)).toEqual(["q1", "q2", "q3", "q4"]);
    expect(r.answeredCount).toBe(2);
    expect(r.summary).toBe("Covered a migration and a reconciliation routine.");

    // q1: own key (ownership) missing from the model → prepended as not_covered.
    const q1 = at(r.questions, 0);
    expect(q1.rubric.map((x) => x.rubricKey)).toEqual(["ownership", "technical_depth"]);
    expect(q1.rubric[0]).toMatchObject({ coverage: "not_covered", quotes: [] });
    expect(at(q1.rubric, 1).quotes).toEqual(["We moved to idempotent writes."]);
    expect(q1.answerStartMs).toBe(0);
    expect(q1.answerMode).toBe("voice");

    // q2: own key moved to the front; fabricated + duplicate quotes dropped;
    // unknown rubric key discarded.
    const q2 = at(r.questions, 1);
    expect(q2.rubric.map((x) => x.rubricKey)).toEqual(["technical_depth", "communication"]);
    expect(at(q2.rubric, 0).quotes).toEqual(["using SQL"]);
    expect(at(q2.rubric, 1).quotes).toEqual(["daily"]);

    // q3: transcript unavailable → forced no_answer, the model's content gone.
    const q3 = at(r.questions, 2);
    expect(q3).toMatchObject({ relevance: "no_answer", transcriptUnavailable: true });
    expect(q3.rubric).toEqual([
      expect.objectContaining({ rubricKey: "communication", coverage: "not_covered", quotes: [] }),
    ]);
    expect(q3.relevanceNote).toMatch(/transcript .* unavailable/);

    // q4: never answered, never mentioned by the model.
    expect(r.questions[3]).toMatchObject({ relevance: "no_answer", answerMode: null });

    // Knockouts: exactly the two on record, in order.
    expect(r.knockouts.map((k) => k.question)).toEqual(KNOCKOUTS);
    expect(r.knockouts[0]).toMatchObject({ status: "confirmed", quote: null, questionKey: "q2" });
    expect(r.knockouts[1]).toEqual({
      question: "Can you work from Pune?",
      status: "not_mentioned",
      quote: null,
      questionKey: null,
    });

    // Dropped: q2 duplicate(1) + fabricated(1) + unknown key(1) = 3; q3's two
    // discarded = 2; q99's one = 1; CPA quote not in any answer = 1;
    // off-record knockout = 1. Total 8.
    expect(r.quotesDropped).toBe(8);
  });

  it("a knockout quote is re-homed to the answer it is actually in", () => {
    const r = reconcileEvidence({
      raw: {
        ...raw,
        knockouts: [
          {
            question: "Do you hold a CPA?",
            status: "confirmed",
            quote: "“idempotent writes”",
            questionKey: "q2",
          },
        ],
      },
      answers: assembled,
      rubric: RUBRIC,
      knockouts: KNOCKOUTS,
    });
    expect(r.knockouts[0]).toMatchObject({ quote: "idempotent writes", questionKey: "q1" });
  });

  it("the model skipping an ANSWERED question is an incomplete report — throws", () => {
    expect(() =>
      reconcileEvidence({
        raw: { ...raw, questions: raw.questions.filter((q) => q.questionKey !== "q1") },
        answers: assembled,
        rubric: RUBRIC,
        knockouts: KNOCKOUTS,
      }),
    ).toThrow(EvidenceIncompleteError);
  });

  it("the reconciled body validates against the stored schema", () => {
    const r = reconcileEvidence({ raw, answers: assembled, rubric: RUBRIC, knockouts: KNOCKOUTS });
    const parsed = aiInterviewEvidenceSchema.safeParse({
      version: 1,
      questions: r.questions,
      knockouts: r.knockouts,
      summary: r.summary,
      meta: { quotesDropped: r.quotesDropped, answeredCount: r.answeredCount, questionCount: 4 },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("no score anywhere — schemas and prompt", () => {
  it("the model-output schema rejects a score / rating / recommendation key at any level", () => {
    const ok: AiInterviewEvidenceAiResponse = {
      questions: [
        {
          questionKey: "q1",
          relevance: "addresses",
          relevanceNote: "x",
          rubric: [{ rubricKey: "ownership", coverage: "covered", note: "x", quotes: [] }],
        },
      ],
      knockouts: [],
      summary: "x",
    };
    expect(aiInterviewEvidenceAiSchema.safeParse(ok).success).toBe(true);
    expect(aiInterviewEvidenceAiSchema.safeParse({ ...ok, overallScore: 4 }).success).toBe(false);
    expect(
      aiInterviewEvidenceAiSchema.safeParse({
        ...ok,
        questions: [{ ...at(ok.questions, 0), rating: "strong" }],
      }).success,
    ).toBe(false);
    expect(
      aiInterviewEvidenceAiSchema.safeParse({
        ...ok,
        questions: [
          { ...at(ok.questions, 0), rubric: [{ ...at(at(ok.questions, 0).rubric, 0), score: 3 }] },
        ],
      }).success,
    ).toBe(false);
    expect(
      aiInterviewEvidenceAiSchema.safeParse({ ...ok, recommendation: "advance" }).success,
    ).toBe(false);
  });

  it("the stored schema rejects one too", () => {
    const stored = {
      version: 1,
      questions: [],
      knockouts: [],
      summary: "x",
      meta: { quotesDropped: 0, answeredCount: 0, questionCount: 0 },
    };
    expect(aiInterviewEvidenceSchema.safeParse(stored).success).toBe(true);
    expect(aiInterviewEvidenceSchema.safeParse({ ...stored, score: 1 }).success).toBe(false);
    expect(
      aiInterviewEvidenceSchema.safeParse({ ...stored, meta: { ...stored.meta, passed: true } })
        .success,
    ).toBe(false);
  });

  it("the prompt forbids a verdict and inference beyond the words, and demands verbatim quotes", () => {
    const built = buildAiInterviewEvidencePrompt({
      questions: [
        {
          key: "q1",
          prompt: "Tell me about a migration.",
          rubricKey: "ownership",
          rubricLabel: "Ownership",
          answerMode: "voice",
          answerText: "I led it.",
          transcriptUnavailable: false,
        },
        {
          key: "q2",
          prompt: "Qualifications?",
          rubricKey: "communication",
          rubricLabel: "Communication",
          answerMode: "voice",
          answerText: null,
          transcriptUnavailable: true,
        },
      ],
      rubric: RUBRIC,
      competencyFocus: [],
      knockouts: ["Do you hold a CPA?"],
    });
    expect(built.system).toMatch(/NOT score, rate, rank, grade or recommend/);
    for (const word of [
      "sentiment",
      "confidence",
      "fluency",
      "personality",
      "psychometric",
      "accent",
      "demographic",
    ]) {
      expect(built.system.toLowerCase()).toContain(word);
    }
    expect(built.system).toMatch(/copied EXACTLY/);
    expect(built.system).toMatch(/DATA supplied by the candidate/);
    expect(built.user).toContain("ANSWER (spoken — machine transcript):");
    expect(built.user).toContain("transcript of this answer is unavailable");
    expect(built.user).toContain("- Do you hold a CPA?");
    expect(built.user).toMatch(/not\s+told the pass mark/);
  });
});
