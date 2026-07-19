/**
 * Requisition health + difficulty rule engine (RO-01). PURE + DETERMINISTIC —
 * no DB, no AI, no clock. This is the "deterministic rule engine" leg of the
 * persona-pass trio (real AI / curated reference / deterministic rules): the
 * requirement-owner dashboard, the requisitions list health bars, and the
 * action-required list all read verdicts computed here.
 *
 * `computeReqHealth` is a COMPLETENESS composite: how ready-to-run a
 * requisition is, scored 0–100 over seven weighted components (weights are
 * documented constants below, sum = 100). It is NOT a quality judgement and
 * NOT a prediction — every point maps to a concrete, checkable fact about the
 * req (JD present, skills weighted, budget set, …). The component breakdown is
 * returned alongside the score so the UI can render per-facet bars and the
 * action-required list can point at exactly what is missing.
 *
 * `computeReqDifficulty` is a coarse low|medium|high fill-difficulty verdict
 * over three deterministic signals: how many must-have skills are demanded, how
 * many niche skills (absent from the curated benchmark's common skills) appear,
 * and how far the budget sits below the benchmark median. It never invents a
 * market claim — every input is either the req's own data or a curated
 * benchmark row supplied by the caller.
 *
 * The unit suite (test/ro-01-req-health.test.ts) reconstructs every component
 * and boundary here; keep the weights + thresholds as named constants so the
 * test asserts against the same source of truth.
 */

// ─────────────────────────────── health ───────────────────────────────

/**
 * Component weights (sum = 100). Ordered by how load-bearing each facet is for
 * a req that can actually run. Documented here so the UI copy and the unit test
 * cite one source.
 */
export const REQ_HEALTH_WEIGHTS = {
  /** JD content exists (text + summary + structured sections). */
  jd: 20,
  /** Skills are listed and carry weights. */
  skills: 15,
  /** At least one must-have (required) skill is marked. */
  mustHaves: 10,
  /** An interview / panel plan is configured. */
  interviewPlan: 15,
  /** A budget (comp band) is set on the position. */
  budget: 15,
  /** The requisition has moved through the approval spine. */
  approval: 15,
  /** Candidates are in flight against the req. */
  pipeline: 10,
} as const;

export type ReqHealthComponentKey = keyof typeof REQ_HEALTH_WEIGHTS;

export interface ReqHealthComponent {
  key: ReqHealthComponentKey;
  label: string;
  earned: number;
  max: number;
}

export interface ReqHealthResult {
  score: number;
  components: ReqHealthComponent[];
}

const REQ_HEALTH_LABELS: Record<ReqHealthComponentKey, string> = {
  jd: "Job description",
  skills: "Skills & weights",
  mustHaves: "Must-have skills",
  interviewPlan: "Interview plan",
  budget: "Budget band",
  approval: "Approval",
  pipeline: "Pipeline",
};

export interface ReqHealthInput {
  jd: {
    hasText: boolean;
    hasSummary: boolean;
    /** Count of structured JD sections present (from jd_versions.ai_metadata). */
    sectionCount: number;
  };
  skills: {
    /** Total skills listed on the JD version. */
    count: number;
    /** Of those, how many carry a positive weight. */
    weightedCount: number;
    /** Of those, how many are marked required (must-have). */
    mustHaveCount: number;
  };
  interviewPlan: {
    configured: boolean;
    roundCount: number;
  };
  budget: {
    hasBand: boolean;
  };
  /**
   * Current requisition status (draft | pending_approval | approved | on_hold |
   * posted | filled | cancelled | closed), or null when no approval has ever
   * been requested.
   */
  approvalStatus: string | null;
  pipeline: {
    /** Applications not in a terminal (rejected/withdrawn/declined) state. */
    candidatesInFlight: number;
  };
}

/** How much approval credit each requisition status earns (of the 15-pt max). */
export const REQ_APPROVAL_STATUS_POINTS: Record<string, number> = {
  draft: 0,
  pending_approval: 8,
  approved: 15,
  posted: 15,
  filled: 15,
  closed: 15,
  on_hold: 6,
  cancelled: 0,
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Pipeline-strength bands → earned points (of the 10-pt max). */
function pipelinePoints(candidatesInFlight: number): number {
  if (candidatesInFlight <= 0) return 0;
  if (candidatesInFlight <= 2) return 5;
  if (candidatesInFlight <= 5) return 8;
  return REQ_HEALTH_WEIGHTS.pipeline;
}

/**
 * Compute the requisition health composite. Deterministic — same input always
 * yields the same score + component breakdown. Every component's `earned` is in
 * [0, max]; the score is the integer sum, in [0, 100].
 */
export function computeReqHealth(input: ReqHealthInput): ReqHealthResult {
  const W = REQ_HEALTH_WEIGHTS;

  // JD (20): text is the bulk (10), a summary (4), structured sections up to 3 (6).
  const jdEarned =
    (input.jd.hasText ? 10 : 0) +
    (input.jd.hasSummary ? 4 : 0) +
    Math.round((clamp(input.jd.sectionCount, 0, 3) / 3) * 6);

  // Skills (15): presence up to 3 skills (8) + share of skills that are weighted (7).
  const skillPresence = Math.round((clamp(input.skills.count, 0, 3) / 3) * 8);
  const weightedShare =
    input.skills.count > 0
      ? Math.round(
          (clamp(input.skills.weightedCount, 0, input.skills.count) / input.skills.count) * 7,
        )
      : 0;
  const skillsEarned = skillPresence + weightedShare;

  // Must-haves (10): binary — at least one required skill marked.
  const mustHavesEarned = input.skills.mustHaveCount > 0 ? W.mustHaves : 0;

  // Interview plan (15): configured AND at least one round.
  const interviewEarned =
    input.interviewPlan.configured && input.interviewPlan.roundCount > 0 ? W.interviewPlan : 0;

  // Budget (15): binary — a comp band is set.
  const budgetEarned = input.budget.hasBand ? W.budget : 0;

  // Approval (15): status-mapped.
  const approvalEarned =
    input.approvalStatus == null ? 0 : (REQ_APPROVAL_STATUS_POINTS[input.approvalStatus] ?? 0);

  // Pipeline (10): banded by candidates in flight.
  const pipelineEarned = pipelinePoints(input.pipeline.candidatesInFlight);

  const components: ReqHealthComponent[] = [
    { key: "jd", label: REQ_HEALTH_LABELS.jd, earned: clamp(jdEarned, 0, W.jd), max: W.jd },
    {
      key: "skills",
      label: REQ_HEALTH_LABELS.skills,
      earned: clamp(skillsEarned, 0, W.skills),
      max: W.skills,
    },
    {
      key: "mustHaves",
      label: REQ_HEALTH_LABELS.mustHaves,
      earned: mustHavesEarned,
      max: W.mustHaves,
    },
    {
      key: "interviewPlan",
      label: REQ_HEALTH_LABELS.interviewPlan,
      earned: interviewEarned,
      max: W.interviewPlan,
    },
    { key: "budget", label: REQ_HEALTH_LABELS.budget, earned: budgetEarned, max: W.budget },
    { key: "approval", label: REQ_HEALTH_LABELS.approval, earned: approvalEarned, max: W.approval },
    {
      key: "pipeline",
      label: REQ_HEALTH_LABELS.pipeline,
      earned: pipelineEarned,
      max: W.pipeline,
    },
  ];

  const score = components.reduce((sum, c) => sum + c.earned, 0);
  return { score: clamp(score, 0, 100), components };
}

// ───────────────────────────── difficulty ─────────────────────────────

export type ReqDifficulty = "low" | "medium" | "high";

/**
 * A small constant of broadly-available skills. Used ONLY to decide whether a
 * skill counts as "niche" when NO curated benchmark common-skill list is
 * available for the role — a skill on this list is never niche. This is a
 * deterministic fallback, not a market claim.
 */
export const COMMON_SKILLS: readonly string[] = [
  "javascript",
  "typescript",
  "python",
  "java",
  "sql",
  "html",
  "css",
  "react",
  "node",
  "node.js",
  "git",
  "rest",
  "api",
  "aws",
  "docker",
  "communication",
  "excel",
  "agile",
  "scrum",
  "project management",
];

function normSkill(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.+ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Count skills that are "niche": present on the requisition but absent from
 * BOTH the curated benchmark's common/trending skills AND the constant
 * COMMON_SKILLS fallback. Pure — the caller supplies the benchmark skill list
 * (empty when no benchmark matched the role).
 */
export function countNicheSkills(
  reqSkillNames: readonly string[],
  benchmarkCommonSkills: readonly string[],
): number {
  const known = new Set<string>([
    ...COMMON_SKILLS.map(normSkill),
    ...benchmarkCommonSkills.map(normSkill),
  ]);
  let niche = 0;
  for (const raw of reqSkillNames) {
    const s = normSkill(raw);
    if (!s) continue;
    if (!known.has(s)) niche += 1;
  }
  return niche;
}

/** Must-have counts above this read as demanding (rule: more must-haves = harder). */
export const DIFFICULTY_MUST_HAVE_HIGH = 5;
export const DIFFICULTY_MUST_HAVE_MED = 3;
/** Niche-skill counts at/above these push difficulty up. */
export const DIFFICULTY_NICHE_HIGH = 3;
export const DIFFICULTY_NICHE_MED = 1;
/** Budget as a % of benchmark median: below these underpays for the role. */
export const DIFFICULTY_BUDGET_LOW_PCT = 85;
export const DIFFICULTY_BUDGET_MED_PCT = 100;

export interface ReqDifficultyInput {
  mustHaveCount: number;
  nicheSkillCount: number;
  /**
   * Budget midpoint as a percentage of the benchmark median (100 = exactly at
   * median). null when no comp band is set or no benchmark matched the role —
   * in which case budget contributes no difficulty points (neutral, honest).
   */
  budgetVsBenchmarkPct: number | null;
}

/**
 * Deterministic low|medium|high fill-difficulty. Sums 0–2 points from each of
 * the three signals (0–6 total) and bands the total: 0–1 low, 2–3 medium,
 * 4–6 high.
 */
export function computeReqDifficulty(input: ReqDifficultyInput): ReqDifficulty {
  let points = 0;

  if (input.mustHaveCount > DIFFICULTY_MUST_HAVE_HIGH) points += 2;
  else if (input.mustHaveCount >= DIFFICULTY_MUST_HAVE_MED) points += 1;

  if (input.nicheSkillCount >= DIFFICULTY_NICHE_HIGH) points += 2;
  else if (input.nicheSkillCount >= DIFFICULTY_NICHE_MED) points += 1;

  if (input.budgetVsBenchmarkPct != null) {
    if (input.budgetVsBenchmarkPct < DIFFICULTY_BUDGET_LOW_PCT) points += 2;
    else if (input.budgetVsBenchmarkPct < DIFFICULTY_BUDGET_MED_PCT) points += 1;
  }

  if (points >= 4) return "high";
  if (points >= 2) return "medium";
  return "low";
}
