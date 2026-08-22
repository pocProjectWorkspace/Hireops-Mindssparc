/**
 * N4.2 — the AI first round's QUESTION SET: prompt, generation, validation,
 * and the human approval gate.
 *
 * 0119 shipped `ai_interview_sessions` with `questions` NOT NULL and an
 * approval CHECK, and nothing that could fill either. This is that. It stops
 * at a recruiter having approved a frozen set of questions: the signed link,
 * the disclosure copy, the answer capture and the evidence report are
 * N4.3–N4.5.
 *
 * The whole module is here rather than in `router.ts` for the usual reason —
 * the router is 30k lines and inline SQL there is how a query stops being
 * reviewable — but also because the two things that make this ticket
 * defensible (the honest-inputs prompt and the rubric-key validation) belong
 * next to each other, in a file whose builders a test can call directly.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HONEST INPUTS — the interview-prep.ts discipline, restated
 * ─────────────────────────────────────────────────────────────────────────
 * The prompt is grounded in FIVE things and nothing else:
 *
 *   1. `jd_versions.jd_text`            — the role, in the words that were approved
 *   2. `jd_skills`                      — must-have vs nice-to-have
 *   3. `requisition_knockouts`          — the requirements, TEXT ONLY (see below)
 *   4. `interview_plans.competency_focus` — what this round owns
 *   5. the round's resolved rubric      — what a human panellist is scored on
 *
 * There is no company knowledge, no role folklore, no market data, no
 * candidate record and no seniority the JD did not state. A question the
 * model could only have written by inventing context is a question the
 * recruiter cannot defend, and this is a round nobody watches live.
 *
 * KNOCKOUT THRESHOLDS ARE WITHHELD ON PURPOSE. `requisition_knockouts` stores
 * `question_text` alongside a `threshold_value` (the bar: 5 years, a specific
 * certification, a notice period). The text goes into the prompt; the
 * threshold does not. Handing the model the pass mark produces a leading
 * question — "do you have at least five years of Kafka?" tells the candidate
 * the answer that passes, which makes the response worthless as evidence and
 * makes the round easier to game than the application form it duplicates.
 * The candidate is asked to state their own position; N4.4 compares it to the
 * threshold, on the server, where the candidate cannot see it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE RUBRIC-KEY CHECK IS THE POINT OF THE TICKET
 * ─────────────────────────────────────────────────────────────────────────
 * Every generated question names the rubric criterion it probes, and that key
 * must exist in the round's own rubric (`interviews.scorecard_criteria_snapshot`
 * — the resolved, ordered [{key,label}] frozen at schedule time by 0102).
 * `validateRubricKeys` re-checks that AFTER generation and the caller discards
 * the entire set if any key misses.
 *
 * The failure it prevents is quiet, not loud. N4.4's evidence report maps the
 * candidate's own words back onto the same rubric a human panellist is scored
 * against; a question citing `system_desgin` or a plausible-but-absent
 * `leadership` writes evidence to a criterion that does not exist, so the
 * report shows a rubric line that is never covered and a recruiter reads it
 * as a gap in the CANDIDATE. Nothing throws, nothing is logged, and the
 * artefact is wrong in the direction that costs someone a job. Discarding the
 * set costs one regeneration.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * GOVERNANCE — product stance, not preference (build plan §5)
 * ─────────────────────────────────────────────────────────────────────────
 *  - NO protected-characteristic questions. Recruitment sits in EU AI Act
 *    Annex III, and the Kyndryl pitch targets GCC clients in France and
 *    Germany. A question that INVITES disclosure of age, marital or family
 *    status, pregnancy, religion, ethnicity, disability, or nationality
 *    beyond work authorisation is a defect, not a matter of taste — the
 *    candidate cannot un-say it and the recruiter cannot un-hear it.
 *  - NO score, rating, ranking, pass/fail, or "ideal answer". The response
 *    schema is `.strict()` and has nowhere to put one, so a model that
 *    produced an answer key fails the parse rather than landing it in jsonb
 *    for a later ticket to grade against. The AI round produces evidence; a
 *    human advances or rejects.
 *  - NO inference beyond the words. Extends interview-prep.ts's existing ban
 *    on sentiment, confidence, fluency, personality and demographic
 *    inference to the asking side: a question designed to elicit a
 *    personality read is the same defect one step earlier.
 *
 * Pure builders (`buildAiInterviewQuestionsPrompt`, `targetQuestionCount`,
 * `validateRubricKeys`) are exported separately from the db-touching entry
 * points so the N4.2 test can reconstruct the exact prompt — and therefore
 * the LocalAIClient fixture hash — the procedure will send. panel-02 /
 * hrops-02 / N3.3b use the same technique.
 *
 * Client shape follows interview-media-upload.ts / interview-notes-read.ts: a
 * postgres.js tagged-template client (ctx.sql, the service-role pool) with an
 * EXPLICIT tenant_id predicate on every statement, because that client
 * BYPASSES RLS.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { getAIClient, resolveTenantAiSettingsDb } from "@hireops/ai-client";
import {
  AI_INTERVIEW_QUESTION_COUNT_MAX,
  AI_INTERVIEW_QUESTION_COUNT_MIN,
  AI_INTERVIEW_QUESTION_PROMPT_MAX,
  aiInterviewQuestionsSchema,
  aiInterviewSessionStatusSchema,
  coerceAiInterviewQuestions,
  coerceScorecardCriteria,
  resolveScorecardCriteria,
  type AiInterviewQuestion,
  type AiInterviewSessionCard,
  type ScorecardCriterion,
} from "@hireops/api-types";

/** postgres.js tagged-template client (same shape as ctx.sql / poolSql). */
type PgSqlClient = typeof poolSql;

/**
 * Stamped onto every session this prompt produces.
 *
 * BUMP IT WHENEVER THE PROMPT TEXT OR THE RESPONSE SCHEMA CHANGES. A stored
 * question set references the version that wrote it, so a corpus generated
 * across a change stays legible — and, here, so a recruiter asked to justify
 * a question a year later can find the instructions that produced it. Same
 * convention as INTERVIEW_PREP_PROMPT_VERSION ("panel-02-v1") and
 * INTERVIEW_NOTES_PROMPT_VERSION ("n33b-v1") — the ticket, then the revision.
 */
export const AI_INTERVIEW_QUESTIONS_PROMPT_VERSION = "n42-v1";

/** Structured-output tool name for the forced-tool-use path. */
export const AI_INTERVIEW_QUESTIONS_SCHEMA_NAME = "ai_interview_questions";

/**
 * The feature label on every ai_usage_logs row this path writes, and the
 * AI_FEATURE_KEYS entry whose `enabled` flag gates it. Separate from
 * `interview_notes` and from the ASR minute line: a tenant may run AI rounds
 * without buying notes on human ones, and the two are billed on different
 * units.
 */
export const AI_INTERVIEW_QUESTIONS_FEATURE = "ai_interview_questions";

/** Bounds so the prompt input can't balloon regardless of tenant config. */
const JD_TEXT_CAP = 4000;
const SKILL_CAP = 40;
const KNOCKOUT_CAP = 20;
const CRITERIA_CAP = 24;
const COMPETENCY_CAP = 16;

/**
 * The model's output — and, as much, the shape of what it CANNOT say.
 *
 * Two fields per question: the text, and the rubric criterion it probes.
 * `.strict()` at both levels is load-bearing rather than tidy. There is no
 * `idealAnswer`, no `lookFor`, no `difficulty`, no `weight` and no `score`,
 * and a model that returns one fails the parse, the generation is discarded,
 * and nothing is written — which is the correct outcome for output the
 * product has no lawful place to put. See the module header.
 *
 * The array bounds are the stored bounds (`AI_INTERVIEW_QUESTION_COUNT_*`),
 * not the per-call target: the prompt asks for exactly `questionCount`, and a
 * provider that returns one more or one fewer has produced a usable round
 * rather than a defect. Anything outside the product bounds has not.
 */
export const aiInterviewQuestionsAiSchema = z
  .object({
    questions: z
      .array(
        z
          .object({
            /** The question as the candidate will read/hear it, verbatim. */
            prompt: z.string().min(1).max(AI_INTERVIEW_QUESTION_PROMPT_MAX),
            /** MUST be a key from the round's rubric — validated after parsing. */
            rubricKey: z.string().min(1).max(64),
          })
          .strict(),
      )
      .min(AI_INTERVIEW_QUESTION_COUNT_MIN)
      .max(AI_INTERVIEW_QUESTION_COUNT_MAX),
  })
  .strict();
export type AiInterviewQuestionsAiResponse = z.infer<typeof aiInterviewQuestionsAiSchema>;

/** JSON-schema form handed to the AI client's structured-output call. */
export const aiInterviewQuestionsAiJsonSchema = z.toJSONSchema(aiInterviewQuestionsAiSchema, {
  target: "draft-2020-12",
});

/**
 * How many questions to ask this round.
 *
 * ONE PER RUBRIC CRITERION IS THE FLOOR, and it is the whole reasoning: N4.4
 * reports coverage per rubric line, so a set smaller than the rubric
 * guarantees at least one line that reads "not covered" no matter what the
 * candidate says. That is a defect in the question set presented as a fact
 * about the person.
 *
 * PLUS ONE, so the round's `competency_focus` — the competencies the plan
 * says THIS round owns — can get a second, deeper probe instead of the whole
 * set being uniformly shallow. Where the focus list is longer than the rubric
 * (a round declaring more ground than its rubric scores) the focus count
 * drives instead, because that is the honest measure of how much this round
 * is being asked to cover.
 *
 * Clamped to [5, 10] by `AI_INTERVIEW_QUESTION_COUNT_*`: five is the size of
 * every code-default rubric, ten is ~30 minutes of recorded answers, which is
 * the first-round duration the build plan costs and about as much unattended
 * recording as it is fair to ask for.
 */
export function targetQuestionCount(rubricSize: number, competencyFocusSize: number): number {
  const base = Math.max(rubricSize, competencyFocusSize) + 1;
  return Math.min(Math.max(base, AI_INTERVIEW_QUESTION_COUNT_MIN), AI_INTERVIEW_QUESTION_COUNT_MAX);
}

export interface AiInterviewSkillContext {
  skillName: string;
  isRequired: boolean;
}

/**
 * A knockout requirement, TEXT AND TYPE ONLY. `threshold_value` is
 * deliberately absent from this interface so a future caller cannot pass the
 * pass mark in by accident — see the module header.
 */
export interface AiInterviewKnockoutContext {
  questionText: string;
  /** boolean | numeric_min | numeric_max | enum — shapes how to ask, not what passes. */
  type: string;
}

export interface BuildAiInterviewQuestionsPromptInput {
  roleTitle: string;
  roundName: string;
  /** interview_plans.competency_focus for this round. Often empty. */
  competencyFocus: string[];
  /** The round's resolved rubric — the ONLY legal values for rubricKey. */
  rubric: ScorecardCriterion[];
  jdText: string | null;
  skills: AiInterviewSkillContext[];
  knockouts: AiInterviewKnockoutContext[];
  /** From `targetQuestionCount`. Passed in so the test can pin it. */
  questionCount: number;
}

export interface BuiltAiInterviewQuestionsPrompt {
  system: string;
  user: string;
}

/**
 * Build the system + user messages for the question-generation call. Pure —
 * returns plain strings; the AI client wrapper owns the provider envelope.
 * The caller passes `aiInterviewQuestionsAiJsonSchema` as the structured-output
 * schema and `AI_INTERVIEW_QUESTIONS_SCHEMA_NAME` as the schema name.
 */
export function buildAiInterviewQuestionsPrompt(
  input: BuildAiInterviewQuestionsPromptInput,
): BuiltAiInterviewQuestionsPrompt {
  const system =
    "You are writing the question set for an ASYNCHRONOUS first-round interview. " +
    "The candidate will answer each question alone, on their own time, recording or " +
    "typing a response with NO interviewer present — so every question must stand on " +
    "its own, need no clarification, and contain no follow-up you are relying on " +
    "someone to ask. " +
    // (a) honest inputs — the interview-prep.ts clause, tightened for a round
    // nobody watches.
    "Work ONLY from the material below: the job description and its skills, the " +
    "role's stated requirements, the round's competency focus, and the round's " +
    "scoring rubric. Do NOT invent facts about the company, the team, the product, " +
    "the market or the seniority of the role, and do NOT assume anything the job " +
    "description does not say. You know nothing about the candidate and must not " +
    "write a question that presumes their background, employer, tenure or level. " +
    // (b) the rubric contract — the reason the whole ticket exists.
    "EVERY question must name, in `rubricKey`, the rubric criterion it probes, and " +
    "that value must be COPIED EXACTLY from the RUBRIC list below. Do not invent a " +
    "criterion, do not reword one, do not use a label where a key belongs, and do " +
    "not use a key that is not in the list — a question naming a criterion this " +
    "round does not score cannot be reported on and the entire set will be " +
    "discarded. Cover every criterion in the list at least once. " +
    // (c) protected characteristics — a floor, not a style note.
    "You must NOT ask anything that elicits, invites or depends on a protected " +
    "characteristic: age or date of birth, marital or family status, children, " +
    "pregnancy or parental leave, religion or observance, ethnicity or race, " +
    "disability or health, sexual orientation, trade-union membership, or " +
    "nationality or origin beyond a plain question about legal authorisation to " +
    "work. That includes indirect routes — graduation years, career gaps, 'tell me " +
    "about your family', availability framed around caring responsibilities, or " +
    "anything that invites a candidate to volunteer one of the above. If a stated " +
    "requirement can only be probed by asking for one of these, SKIP IT. " +
    // (d) no verdict, no answer key, no inference beyond the words.
    "You must NOT score, rate, rank, grade or recommend, and you must NOT write an " +
    "ideal answer, a model answer, a marking scheme, a list of what a good answer " +
    "contains, or any hint of what passes. You are writing questions only: they " +
    "gather evidence, and a human decides. Do NOT write a question aimed at " +
    "reading someone's personality, confidence, fluency, sentiment or character " +
    "— probe only demonstrable experience, reasoning and skill relevant to the " +
    "role. Do NOT state or hint at any threshold, minimum or bar; ask the " +
    "candidate to describe their own position and let a human compare it. " +
    // (e) craft — the difference between a usable async round and a survey.
    "Write open, specific, behavioural or scenario questions that ask for concrete " +
    "examples ('describe a time…', 'walk me through how you…'). Avoid yes/no " +
    "questions, avoid leading questions, avoid double-barrelled questions, avoid " +
    "asking anything already answered by an application form, and do not repeat a " +
    "question in different words. Plain English, no jargon the job description " +
    "does not itself use. " +
    "Return a JSON object only — no prose outside the JSON.";

  const lines: string[] = [
    `Write exactly ${input.questionCount} interview questions for this round.`,
    "",
    "ROUND",
    `- Role: ${input.roleTitle}`,
    `- This round: ${input.roundName}`,
    "",
    "RUBRIC — the ONLY legal values for rubricKey (copy the key in brackets exactly)",
    renderRubric(input.rubric),
    "",
    "COMPETENCY FOCUS FOR THIS ROUND (what the plan says this round owns — weight",
    "the question set towards these, using the rubric keys above)",
    renderCompetencyFocus(input.competencyFocus),
    "",
    "JOB DESCRIPTION — key skills",
    renderSkills(input.skills),
  ];

  if (input.jdText && input.jdText.trim().length > 0) {
    lines.push("", "JOB DESCRIPTION — text", input.jdText.slice(0, JD_TEXT_CAP));
  }

  lines.push(
    "",
    "STATED REQUIREMENTS FOR THIS ROLE",
    "(The bar for each is deliberately NOT shown to you. Ask the candidate to state",
    "their own position in their own words; never quote or imply a minimum, and skip",
    "any requirement that could only be probed by asking for a protected",
    "characteristic.)",
    renderKnockouts(input.knockouts),
    "",
    "Return JSON only matching this shape:",
    "{",
    '  "questions": [',
    '    { "prompt": "<the question, as the candidate will read it>",',
    '      "rubricKey": "<a key copied exactly from the RUBRIC list>" }',
    `  ]  // exactly ${input.questionCount} items, every rubric key covered at least once`,
    "}",
  );

  return { system, user: lines.join("\n") };
}

function renderRubric(rubric: ScorecardCriterion[]): string {
  if (rubric.length === 0) {
    // Unreachable through the procedure — `resolveRoundRubric` always returns
    // at least the code-default rubric — but the builder is public and a
    // caller passing nothing should see the honest statement rather than an
    // invented rubric.
    return "  (no rubric recorded for this round)";
  }
  return rubric
    .slice(0, CRITERIA_CAP)
    .map((c) => `  - ${c.label} [${c.key}]`)
    .join("\n");
}

function renderCompetencyFocus(focus: string[]): string {
  if (focus.length === 0) return "  (not specified)";
  return focus
    .slice(0, COMPETENCY_CAP)
    .map((f) => `  - ${f}`)
    .join("\n");
}

function renderSkills(skills: AiInterviewSkillContext[]): string {
  if (skills.length === 0) return "  (none specified)";
  return skills
    .slice(0, SKILL_CAP)
    .map((s) => `  - ${s.skillName} (${s.isRequired ? "must-have" : "nice-to-have"})`)
    .join("\n");
}

function renderKnockouts(knockouts: AiInterviewKnockoutContext[]): string {
  if (knockouts.length === 0) return "  (none recorded)";
  return knockouts
    .slice(0, KNOCKOUT_CAP)
    .map((k) => `  - ${k.questionText} (${k.type})`)
    .join("\n");
}

/**
 * THE VALIDATION. Returns the rubric keys the model cited that this round does
 * not have — empty means the set is safe to store.
 *
 * Pure and exported so the test can drive it from a fixture without a database
 * and so the router never has to re-derive the rule. Duplicates are collapsed:
 * a model that got the same key wrong five times has made one mistake and the
 * error message should say so once.
 */
export function validateRubricKeys(
  questions: { rubricKey: string }[],
  rubric: ScorecardCriterion[],
): string[] {
  const allowed = new Set(rubric.map((c) => c.key));
  const offenders = new Set<string>();
  for (const q of questions) {
    if (!allowed.has(q.rubricKey)) offenders.add(q.rubricKey);
  }
  return [...offenders];
}

/* ───────────────────────── db-touching entry points ───────────────────────── */

interface RoundRow {
  session_id: string | null;
  interview_id: string;
  requisition_id: string;
  round_number: number;
  round_name: string;
  mode: string;
  scorecard_template: string | null;
  scorecard_criteria_snapshot: unknown;
  jd_version_id: string;
  jd_text: string | null;
  position_title: string;
  competency_focus: unknown;
  status: string | null;
  questions: unknown;
  questions_frozen_at: Date | string | null;
  approved_by_membership_id: string | null;
  approved_by_name: string | null;
  approved_at: Date | string | null;
  model: string | null;
  prompt_version: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * The round, its rubric inputs, and its session if one exists — in ONE read.
 *
 * LEFT JOINs on the session and the plan round: a round with no session yet is
 * the normal pre-generation state, and a plan round can legitimately have been
 * removed after the interview was booked (which is exactly why 0055/0102
 * snapshot onto the interview in the first place).
 */
async function loadRound(
  sql: PgSqlClient,
  tenantId: string,
  interviewId: string,
): Promise<RoundRow | null> {
  const [row] = await sql<RoundRow[]>`
    SELECT
      s.id                             AS session_id,
      iv.id                            AS interview_id,
      iv.requisition_id,
      iv.round_number,
      iv.round_name,
      iv.mode,
      iv.scorecard_template,
      iv.scorecard_criteria_snapshot,
      r.jd_version_id,
      jv.jd_text,
      p.title                          AS position_title,
      pl.competency_focus,
      s.status,
      s.questions,
      s.questions_frozen_at,
      s.approved_by_membership_id,
      -- display_name → email-local-part → null, the resolveMembershipNames
      -- fallback chain. public.users is self-only under RLS, which is why
      -- this join is legitimate only on the service-role client.
      COALESCE(approver.display_name, NULLIF(split_part(approver_auth.email, '@', 1), ''))
                                       AS approved_by_name,
      s.approved_at,
      s.model,
      s.prompt_version,
      s.created_at,
      s.updated_at
    FROM public.interviews iv
    JOIN public.requisitions r
      ON r.tenant_id = iv.tenant_id AND r.id = iv.requisition_id
    JOIN public.jd_versions jv
      ON jv.tenant_id = r.tenant_id AND jv.id = r.jd_version_id
    JOIN public.positions p
      ON p.tenant_id = r.tenant_id AND p.id = r.position_id
    LEFT JOIN public.interview_plans pl
      ON pl.tenant_id = iv.tenant_id
     AND pl.requisition_id = iv.requisition_id
     AND pl.round_number = iv.round_number
    LEFT JOIN public.ai_interview_sessions s
      ON s.tenant_id = iv.tenant_id AND s.interview_id = iv.id
    LEFT JOIN public.tenant_user_memberships m
      ON m.tenant_id = s.tenant_id AND m.id = s.approved_by_membership_id
    LEFT JOIN public.users approver
      ON approver.id = m.user_id
    LEFT JOIN auth.users approver_auth
      ON approver_auth.id = m.user_id
    WHERE iv.tenant_id = ${tenantId} AND iv.id = ${interviewId}
    LIMIT 1
  `;
  return row ?? null;
}

/**
 * The round's rubric — the set of keys a question may cite.
 *
 * SNAPSHOT FIRST. `interviews.scorecard_criteria_snapshot` is the rubric this
 * round's HUMAN panellists are validated against (0102), and matching it
 * exactly is the entire point of putting a rubric key on a question.
 *
 * The fallback is not a convenience: it is the SAME resolution
 * `saveInterviewFeedback` performs when the snapshot is empty (tenant custom
 * rubric for the round's scorecard key, else the four code defaults). Rounds
 * booked through `scheduleInterview` after 0102 always carry a snapshot, so
 * this only fires for rows created some other way — seeds, back-fills, or a
 * pre-0102 interview. Resolving it differently from the scorecard path would
 * mean the AI round's questions cite one vocabulary while the panellist on the
 * same round is scored on another, which is the drift 0102 exists to prevent.
 */
async function resolveRoundRubric(
  sql: PgSqlClient,
  tenantId: string,
  row: RoundRow,
): Promise<ScorecardCriterion[]> {
  const snapshot = coerceScorecardCriteria(row.scorecard_criteria_snapshot);
  if (snapshot.length > 0) return snapshot;

  const template = row.scorecard_template ?? "general";
  const custom = await sql<{ scorecard_key: string; criteria: unknown }[]>`
    SELECT scorecard_key, criteria
    FROM public.tenant_scorecard_template
    WHERE tenant_id = ${tenantId}
  `;
  const tenantCriteria = new Map<string, readonly ScorecardCriterion[]>();
  for (const c of custom) {
    const criteria = coerceScorecardCriteria(c.criteria);
    if (criteria.length > 0) tenantCriteria.set(c.scorecard_key, criteria);
  }
  return [...resolveScorecardCriteria(template, tenantCriteria)];
}

function competencyFocusOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/**
 * Which model actually answered.
 *
 * `completeStructured` doesn't return it, so — the transcript-drain / ai-score
 * precedent — read it back off the `ai_usage_logs` row the call just wrote,
 * keyed on the REQUEST id so a concurrent generation on another round cannot
 * hand this session someone else's provenance. Falls back to the model we
 * asked for, which is the honest answer when the log write is what went
 * missing.
 */
async function resolveUsedModel(
  sql: PgSqlClient,
  tenantId: string,
  requestId: string | null,
  requestedModel: string,
): Promise<string> {
  if (!requestId) return requestedModel;
  const [usage] = await sql<{ model: string }[]>`
    SELECT model FROM public.ai_usage_logs
    WHERE tenant_id = ${tenantId}
      AND feature = ${AI_INTERVIEW_QUESTIONS_FEATURE}
      AND request_id = ${requestId}
      AND succeeded = true
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return usage?.model ?? requestedModel;
}

/**
 * Assembles the wire card from a session-bearing row + the resolved rubric.
 *
 * `sessionId` is passed in rather than read off the row: `RoundRow.session_id`
 * is nullable because the LEFT JOIN legitimately misses, and every caller has
 * already had to establish that a session exists before it could call this.
 */
function toSessionCard(
  row: RoundRow,
  sessionId: string,
  rubric: ScorecardCriterion[],
): AiInterviewSessionCard {
  return {
    sessionId,
    interviewId: row.interview_id,
    status: aiInterviewSessionStatusSchema.parse(row.status),
    questions: aiInterviewQuestionsSchema.parse(coerceAiInterviewQuestions(row.questions)),
    rubric: rubric.map((c) => ({ key: c.key, label: c.label })),
    questionsFrozenAt: toIso(row.questions_frozen_at),
    approvedByMembershipId: row.approved_by_membership_id,
    approvedByName: row.approved_by_name,
    approvedAt: toIso(row.approved_at),
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export interface GenerateQuestionsInput {
  tenantId: string;
  interviewId: string;
  /** The caller's membership — cost attribution on the ai_usage_logs row. */
  actorMembershipId: string | null;
  /** ctx.requestId — correlates the usage row back to this call. */
  requestId: string | null;
}

/**
 * Generate (or regenerate) the round's question set.
 *
 * Order of refusals is deliberate:
 *   1. round exists at all                → NOT_FOUND
 *   2. session has LEFT 'draft'           → CONFLICT, before anything is spent
 *   3. tenant kill switch                 → BAD_REQUEST, before any model call
 *   4. …then the grounding reads and the one paid call.
 *
 * (2) before (3) because a frozen set stays frozen whatever the settings say,
 * and telling someone to re-enable a feature they cannot use anyway is a
 * worse answer than telling them the questions are already approved.
 */
export async function generateQuestions(
  sql: PgSqlClient,
  input: GenerateQuestionsInput,
): Promise<AiInterviewSessionCard> {
  const row = await loadRound(sql, input.tenantId, input.interviewId);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });

  // REGENERATION AFTER APPROVAL IS REFUSED. The set froze when a named human
  // approved it and the candidate may already have opened the link — replacing
  // it would mean their answers no longer correspond to the questions on
  // record, and the approval would name someone who never saw what was asked.
  // The DB CHECK guarantees the frozen state; this is what makes the refusal
  // legible instead of a constraint violation.
  if (row.status && row.status !== "draft") {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        row.status === "cancelled"
          ? "This AI interview session was cancelled and its questions can no longer be regenerated."
          : "These questions were approved and are frozen — they can no longer be regenerated. " +
            "Cancel the session and schedule a new round if the questions need to change.",
    });
  }

  // CONF-01 kill switch — disabled → clean refusal, no model call, no usage row.
  const aiSettings = await resolveTenantAiSettingsDb(input.tenantId);
  const featureSettings = aiSettings.ai_interview_questions;
  if (!featureSettings.enabled) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "AI interview questions are disabled for this tenant. An admin can re-enable them in Admin → AI settings.",
    });
  }

  const rubric = await resolveRoundRubric(sql, input.tenantId, row);
  const competencyFocus = competencyFocusOf(row.competency_focus);

  const skills = await sql<{ skill_name: string; is_required: boolean }[]>`
    SELECT skill_name, is_required
    FROM public.jd_skills
    WHERE tenant_id = ${input.tenantId} AND jd_version_id = ${row.jd_version_id}
    ORDER BY is_required DESC, skill_name
  `;
  // question_text + type only — the threshold is withheld on purpose (header).
  const knockouts = await sql<{ question_text: string; type: string }[]>`
    SELECT question_text, type::text AS type
    FROM public.requisition_knockouts
    WHERE tenant_id = ${input.tenantId} AND requisition_id = ${row.requisition_id}
    ORDER BY order_index, question_text
  `;

  const questionCount = targetQuestionCount(rubric.length, competencyFocus.length);
  const { system, user } = buildAiInterviewQuestionsPrompt({
    roleTitle: row.position_title,
    roundName: row.round_name,
    competencyFocus,
    rubric,
    jdText: row.jd_text,
    skills: skills.map((s) => ({ skillName: s.skill_name, isRequired: s.is_required })),
    knockouts: knockouts.map((k) => ({ questionText: k.question_text, type: k.type })),
    questionCount,
  });

  const client = await getAIClient(input.tenantId);
  const raw = await client.completeStructured<AiInterviewQuestionsAiResponse>({
    prompt: user,
    system,
    model: featureSettings.model,
    temperature: featureSettings.temperature,
    maxTokens: featureSettings.maxTokens,
    schema: aiInterviewQuestionsAiJsonSchema,
    schemaName: AI_INTERVIEW_QUESTIONS_SCHEMA_NAME,
    feature: AI_INTERVIEW_QUESTIONS_FEATURE,
    requestId: input.requestId,
    actorMembershipId: input.actorMembershipId,
  });
  // Trust-but-verify: re-parse so a provider quirk can't smuggle a shape (or
  // an extra field) past the strict schema and into a jsonb column.
  const parsed = aiInterviewQuestionsAiSchema.parse(raw);

  // THE RUBRIC-KEY GATE. A hallucinated key is discarded whole — see the
  // module header for why a partial save would be worse than no save. The
  // ai_usage_logs row stays: the call happened and it cost money, and hiding
  // that would make the cost ledger lie.
  const offenders = validateRubricKeys(parsed.questions, rubric);
  if (offenders.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `The generated questions were discarded: ${offenders.length} cited a rubric ` +
        `criterion this round does not have (${offenders.join(", ")}). This round is ` +
        `scored on: ${rubric.map((c) => c.key).join(", ")}. Nothing was saved — try generating again.`,
    });
  }

  // Keys are assigned here, not by the model: q1..qN in the order returned, so
  // N4.3's turn state and N4.4's evidence rows have a stable, collision-free
  // handle to point at.
  const questions: AiInterviewQuestion[] = parsed.questions.map((q, i) => ({
    key: `q${i + 1}`,
    prompt: q.prompt,
    rubricKey: q.rubricKey,
  }));

  const model = await resolveUsedModel(sql, input.tenantId, input.requestId, featureSettings.model);

  // Regenerate REPLACES, on the one-session-per-interview unique. The
  // `WHERE status = 'draft'` on the DO UPDATE is the same refusal as the
  // guard above, held at the statement level so a concurrent approval landing
  // between the read and this write cannot be overwritten.
  const [written] = await sql<{ id: string }[]>`
    INSERT INTO public.ai_interview_sessions
      (tenant_id, interview_id, status, questions, model, prompt_version)
    VALUES (${input.tenantId}, ${input.interviewId}, 'draft',
            ${JSON.stringify(questions)}::jsonb,
            ${model}, ${AI_INTERVIEW_QUESTIONS_PROMPT_VERSION})
    ON CONFLICT (tenant_id, interview_id) DO UPDATE
      SET questions = EXCLUDED.questions,
          model = EXCLUDED.model,
          prompt_version = EXCLUDED.prompt_version,
          updated_at = now()
      WHERE ai_interview_sessions.status = 'draft'
    RETURNING id
  `;
  if (!written) {
    // The DO UPDATE's WHERE excluded the row — it was approved between the
    // read and the write. Same refusal, same wording.
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "These questions were approved while this generation was running — the approved set is frozen and was left untouched.",
    });
  }

  const after = await loadRound(sql, input.tenantId, input.interviewId);
  if (!after?.session_id) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "ai_interview_sessions write returned no row",
    });
  }
  return toSessionCard(after, after.session_id, rubric);
}

export interface ApproveQuestionsInput {
  tenantId: string;
  interviewId: string;
  /** The human whose name goes on the question set. Never optional. */
  approvedByMembershipId: string;
}

/**
 * The human gate, in one statement.
 *
 * `ai_interview_sessions_approval_check` refuses any status outside
 * ('draft','cancelled') unless the approver, the approval time AND the freeze
 * are all set. That makes the gate a database guarantee rather than a
 * convention; this procedure is what makes it USABLE — it sets all three and
 * moves the status together, so there is no window in which a session is
 * approved-but-unfrozen or frozen-but-unattributed.
 *
 * `WHERE status = 'draft'` makes it idempotent in the safe direction: a second
 * approval finds no draft and is refused, rather than re-stamping a different
 * approver over the one who actually reviewed the questions.
 */
export async function approveQuestions(
  sql: PgSqlClient,
  input: ApproveQuestionsInput,
): Promise<AiInterviewSessionCard> {
  const row = await loadRound(sql, input.tenantId, input.interviewId);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
  if (!row.session_id) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No questions have been generated for this round yet.",
    });
  }
  if (row.status !== "draft") {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        row.status === "cancelled"
          ? "This AI interview session was cancelled."
          : "These questions have already been approved.",
    });
  }

  const [updated] = await sql<{ id: string }[]>`
    UPDATE public.ai_interview_sessions
    SET status = 'approved',
        approved_by_membership_id = ${input.approvedByMembershipId},
        approved_at = now(),
        questions_frozen_at = now(),
        updated_at = now()
    WHERE tenant_id = ${input.tenantId}
      AND interview_id = ${input.interviewId}
      AND status = 'draft'
    RETURNING id
  `;
  if (!updated) {
    // Someone else approved or cancelled it between the read and the write.
    throw new TRPCError({
      code: "CONFLICT",
      message: "These questions were approved or cancelled while you were reviewing them.",
    });
  }

  const after = await loadRound(sql, input.tenantId, input.interviewId);
  if (!after?.session_id) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "ai_interview_sessions approval returned no row",
    });
  }
  const sessionId = after.session_id;
  return toSessionCard(after, sessionId, await resolveRoundRubric(sql, input.tenantId, after));
}

export interface GetSessionInput {
  tenantId: string;
  interviewId: string;
}

export interface GetSessionResult {
  interviewId: string;
  session: AiInterviewSessionCard | null;
  rubric: { key: string; label: string }[];
  questionsEnabled: boolean;
}

/**
 * The recruiter's review read.
 *
 * The rubric comes back whether or not a session exists — before generation it
 * is what the surface can show as "what this round is scored on", and after it
 * is what turns each question's `rubricKey` into a label a human can check the
 * question against.
 */
export async function getSession(
  sql: PgSqlClient,
  input: GetSessionInput,
): Promise<GetSessionResult> {
  const row = await loadRound(sql, input.tenantId, input.interviewId);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });

  const rubric = await resolveRoundRubric(sql, input.tenantId, row);
  const aiSettings = await resolveTenantAiSettingsDb(input.tenantId);

  return {
    interviewId: row.interview_id,
    session: row.session_id ? toSessionCard(row, row.session_id, rubric) : null,
    rubric: rubric.map((c) => ({ key: c.key, label: c.label })),
    questionsEnabled: aiSettings.ai_interview_questions.enabled,
  };
}
