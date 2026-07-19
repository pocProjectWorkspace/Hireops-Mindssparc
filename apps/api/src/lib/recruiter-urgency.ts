/**
 * Recruiter urgency + shortlist rule engine (RECR-02). PURE + DETERMINISTIC —
 * no DB, no AI, no clock. This is the "deterministic rule engine" leg of the
 * persona-pass trio for the recruiter surfaces (candidates-by-role list + AI
 * shortlist). It mirrors the shape of `comp-rules.ts` / `req-health.ts`: named
 * constants, pure functions, every branch pinned by the unit suite
 * (test/recruiter-urgency.test.ts).
 *
 * WHAT THIS IS NOT: there is deliberately NO "heat score", no engagement
 * probability, no "likelihood to accept". The prototype's "Heat Score %" is
 * REFUSED — it implied a fabricated probability. `computeRecruiterUrgency`
 * returns a DETERMINISTIC 0–100 index + a High/Medium/Low rank that is a
 * transparent function of three checkable facts (SLA state, days-in-stage,
 * notice period). It is an "act on this now" ranking for the recruiter, not a
 * prediction about the candidate. Every point maps to a documented rule below.
 *
 * The four exports:
 *   - computeRecruiterUrgency — the urgency composite (index + rank + parts).
 *   - matchTier               — buckets a REAL ai_score into the honest tiers
 *                               (excellent / good / partial / below), or null
 *                               when the application is unscored.
 *   - computeMustHavePct      — deterministic share of a requisition's
 *                               must-have skills the candidate demonstrably has.
 *   - computeRiskFlags        — deterministic flags (skill-mismatch, salary-gap)
 *                               — NOT AI, NOT a judgement, just facts.
 */

// ─────────────────────────────── urgency ───────────────────────────────

export type UrgencyRank = "high" | "medium" | "low";

/**
 * SLA state for the candidate's current stage, computed by the caller from
 * hours-in-stage vs the stage's SLA threshold (see sla-thresholds). Kept as a
 * pre-resolved fact so this engine stays pure (no clock, no threshold map):
 *   - "breached"  — past the stage SLA threshold.
 *   - "at_risk"   — within the last quarter of the threshold window.
 *   - "ok"        — comfortably inside the threshold.
 *   - "none"      — the stage has no SLA threshold (terminal / unclocked stage).
 */
export type UrgencySlaState = "breached" | "at_risk" | "ok" | "none";

/**
 * Component weights (sum = 100). Ordered by how load-bearing each facet is for
 * "should the recruiter act on this candidate now". Documented here so the UI
 * copy and the unit test cite one source.
 */
export const RECRUITER_URGENCY_WEIGHTS = {
  /** How overdue the candidate is against the stage SLA. */
  sla: 40,
  /** How long the candidate has sat in the current stage. */
  daysInStage: 35,
  /** How soon the candidate can start (short notice = act fast before they go). */
  notice: 25,
} as const;

export type UrgencyComponentKey = keyof typeof RECRUITER_URGENCY_WEIGHTS;

export interface UrgencyComponent {
  key: UrgencyComponentKey;
  label: string;
  earned: number;
  max: number;
  /** One-line, human reason for this component's contribution. */
  note: string;
}

export interface RecruiterUrgencyResult {
  /** Deterministic 0–100 index. NOT a probability. */
  index: number;
  rank: UrgencyRank;
  components: UrgencyComponent[];
}

export interface RecruiterUrgencyInput {
  slaState: UrgencySlaState;
  /** Whole days the candidate has been in the current stage (>= 0). */
  daysInStage: number;
  /**
   * Candidate notice period in days (0 = immediately available), or null when
   * it has not been captured — in which case notice contributes NO urgency
   * (neutral, honest — we do not guess).
   */
  noticePeriodDays: number | null;
}

const URGENCY_LABELS: Record<UrgencyComponentKey, string> = {
  sla: "SLA state",
  daysInStage: "Time in stage",
  notice: "Notice period",
};

/** SLA-state → earned points (of the 40-pt max). */
export const URGENCY_SLA_POINTS: Record<UrgencySlaState, number> = {
  breached: 40,
  at_risk: 25,
  ok: 6,
  none: 0,
};

/** Days-in-stage bands → earned points (of the 35-pt max). */
export const URGENCY_DAYS_HIGH = 14;
export const URGENCY_DAYS_MED = 7;
export const URGENCY_DAYS_LOW = 3;

function daysInStagePoints(days: number): number {
  if (days >= URGENCY_DAYS_HIGH) return 35;
  if (days >= URGENCY_DAYS_MED) return 25;
  if (days >= URGENCY_DAYS_LOW) return 14;
  if (days >= 1) return 6;
  return 0;
}

/** Notice-period bands → earned points (of the 25-pt max). Shorter = higher. */
export const URGENCY_NOTICE_IMMEDIATE = 0;
export const URGENCY_NOTICE_SHORT = 15;
export const URGENCY_NOTICE_MED = 30;
export const URGENCY_NOTICE_LONG = 60;
export const URGENCY_NOTICE_VLONG = 90;

function noticePoints(noticePeriodDays: number | null): { earned: number; note: string } {
  if (noticePeriodDays == null) {
    return { earned: 0, note: "Notice not captured — no time-pressure signal" };
  }
  const d = noticePeriodDays;
  if (d <= URGENCY_NOTICE_IMMEDIATE)
    return { earned: 25, note: "Immediately available — move before they accept elsewhere" };
  if (d <= URGENCY_NOTICE_SHORT) return { earned: 20, note: `${d}-day notice — short runway` };
  if (d <= URGENCY_NOTICE_MED) return { earned: 15, note: `${d}-day notice` };
  if (d <= URGENCY_NOTICE_LONG) return { earned: 8, note: `${d}-day notice — some runway` };
  if (d <= URGENCY_NOTICE_VLONG) return { earned: 4, note: `${d}-day notice — long runway` };
  return { earned: 0, note: `${d}-day notice — no time-pressure` };
}

/** Index → rank bands. */
export const URGENCY_RANK_HIGH = 60;
export const URGENCY_RANK_MEDIUM = 35;

function rankFor(index: number): UrgencyRank {
  if (index >= URGENCY_RANK_HIGH) return "high";
  if (index >= URGENCY_RANK_MEDIUM) return "medium";
  return "low";
}

const SLA_NOTES: Record<UrgencySlaState, string> = {
  breached: "Past the stage SLA — overdue",
  at_risk: "Approaching the stage SLA",
  ok: "Inside the stage SLA",
  none: "Stage has no SLA clock",
};

/**
 * Compute the recruiter urgency composite. Deterministic — same input always
 * yields the same index + component breakdown. Every component's `earned` is in
 * [0, max]; the index is the integer sum, in [0, 100].
 */
export function computeRecruiterUrgency(input: RecruiterUrgencyInput): RecruiterUrgencyResult {
  const days = Math.max(0, Math.floor(input.daysInStage));

  const slaEarned = URGENCY_SLA_POINTS[input.slaState];
  const daysEarned = daysInStagePoints(days);
  const notice = noticePoints(input.noticePeriodDays);

  const components: UrgencyComponent[] = [
    {
      key: "sla",
      label: URGENCY_LABELS.sla,
      earned: slaEarned,
      max: RECRUITER_URGENCY_WEIGHTS.sla,
      note: SLA_NOTES[input.slaState],
    },
    {
      key: "daysInStage",
      label: URGENCY_LABELS.daysInStage,
      earned: daysEarned,
      max: RECRUITER_URGENCY_WEIGHTS.daysInStage,
      note: days <= 0 ? "Entered stage today" : `${days}d in stage`,
    },
    {
      key: "notice",
      label: URGENCY_LABELS.notice,
      earned: notice.earned,
      max: RECRUITER_URGENCY_WEIGHTS.notice,
      note: notice.note,
    },
  ];

  const index = components.reduce((sum, c) => sum + c.earned, 0);
  return { index, rank: rankFor(index), components };
}

/** Present a notice-period value for the UI's "Notice" column, honestly. */
export function noticePeriodLabel(noticePeriodDays: number | null): string {
  if (noticePeriodDays == null) return "Not captured";
  if (noticePeriodDays <= 0) return "Immediate";
  return `${noticePeriodDays} days`;
}

// ────────────────────────────── match tiers ──────────────────────────────

/**
 * Honest match tiers — DETERMINISTIC buckets over the REAL ai_score. These are
 * NOT a separate "match confidence"; they are just a labelling of the score the
 * AI scorer already wrote. `null` when the application is unscored (scoring off
 * or not yet run) — the UI says so rather than pretending a tier.
 */
export type MatchTier = "excellent" | "good" | "partial" | "below";

export const MATCH_TIER_EXCELLENT_MIN = 90;
export const MATCH_TIER_GOOD_MIN = 75;
export const MATCH_TIER_PARTIAL_MIN = 60;

export interface MatchTierMeta {
  tier: MatchTier;
  label: string;
  /** Inclusive score range for the tier, for header cards + copy. */
  min: number;
  max: number;
}

export const MATCH_TIERS: MatchTierMeta[] = [
  { tier: "excellent", label: "Excellent match", min: MATCH_TIER_EXCELLENT_MIN, max: 100 },
  {
    tier: "good",
    label: "Good match",
    min: MATCH_TIER_GOOD_MIN,
    max: MATCH_TIER_EXCELLENT_MIN - 1,
  },
  {
    tier: "partial",
    label: "Partial match",
    min: MATCH_TIER_PARTIAL_MIN,
    max: MATCH_TIER_GOOD_MIN - 1,
  },
];

/**
 * Bucket a real ai_score (0–100) into a tier. Returns null for an unscored
 * application (null score) OR a score below the partial floor — those never
 * belong on the shortlist. Deterministic, boundary-inclusive at each tier min.
 */
export function matchTier(aiScore: number | null): MatchTier | null {
  if (aiScore == null) return null;
  if (aiScore >= MATCH_TIER_EXCELLENT_MIN) return "excellent";
  if (aiScore >= MATCH_TIER_GOOD_MIN) return "good";
  if (aiScore >= MATCH_TIER_PARTIAL_MIN) return "partial";
  return "below";
}

// ───────────────────────────── must-have % ─────────────────────────────

function normSkill(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.+ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic share (0–100, rounded) of a requisition's MUST-HAVE skills that
 * the candidate demonstrably lists. Case/spacing-insensitive exact match on
 * normalised skill names — no fuzzy inference, no AI. Returns null when the
 * requisition has no must-have skills OR the candidate has no parsed skills —
 * the UI renders an honest "—" rather than a fabricated 0%.
 */
export function computeMustHavePct(
  mustHaveSkills: readonly string[],
  candidateSkills: readonly string[],
): number | null {
  const required = mustHaveSkills.map(normSkill).filter(Boolean);
  if (required.length === 0) return null;
  if (candidateSkills.length === 0) return null;
  const have = new Set(candidateSkills.map(normSkill).filter(Boolean));
  const matched = required.filter((s) => have.has(s)).length;
  return Math.round((matched / required.length) * 100);
}

// ────────────────────────────── risk flags ──────────────────────────────

/**
 * Deterministic risk flags — plain facts, NOT an AI judgement:
 *   - skill_mismatch: the candidate is missing a large share of the req's
 *     must-have skills (must-have % below the threshold).
 *   - salary_gap: the candidate's expected salary exceeds the role's comp band
 *     ceiling (an out-of-band ask).
 * When a flag's inputs are unknown (null must-have %, no expected salary or no
 * comp band) that flag simply does not fire — silence is honest, not "clear".
 */
export type RiskFlag = "skill_mismatch" | "salary_gap";

/** Must-have % at/below this reads as a skill mismatch. */
export const RISK_SKILL_MISMATCH_MAX_PCT = 50;

export interface RiskFlagInput {
  /** Result of computeMustHavePct (null when not computable). */
  mustHavePct: number | null;
  /** Candidate's expected salary in INR paise, or null when not captured. */
  expectedSalaryInrPaise: bigint | null;
  /** Role comp-band ceiling in INR paise, or null when no band is set. */
  compBandMaxInrPaise: bigint | null;
}

export const RISK_FLAG_LABELS: Record<RiskFlag, string> = {
  skill_mismatch: "Skill gap",
  salary_gap: "Salary gap",
};

export function computeRiskFlags(input: RiskFlagInput): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (input.mustHavePct != null && input.mustHavePct <= RISK_SKILL_MISMATCH_MAX_PCT) {
    flags.push("skill_mismatch");
  }
  if (
    input.expectedSalaryInrPaise != null &&
    input.compBandMaxInrPaise != null &&
    input.expectedSalaryInrPaise > input.compBandMaxInrPaise
  ) {
    flags.push("salary_gap");
  }
  return flags;
}
