/**
 * PC-6 — evidence-based CV screening. PURE: no db, no io, no clock, no client.
 *
 * Screening shows EVIDENCE, not a score (decision D2). For each requisition
 * criterion the screener returns a verdict (met / partially_met / not_met /
 * unclear), a short reason, and 0–2 verbatim quotes from the candidate's CV.
 * The 0–100 `ai_score` still exists (ordering + back-compat) but the evidence
 * is the primary recruiter-facing output.
 *
 * Four jobs, all deterministic:
 *
 * 1. CRITERIA — `buildScreeningCriteria`: the requisition's must-have skills
 *    (jd_skills.is_required) plus the JD's "Required skills & qualifications"
 *    lines (jd_versions.ai_metadata.sections.requirements). Stable keys
 *    (`mh-1…`, `rq-1…`) so the model's answer can be reconciled against the
 *    criteria ON RECORD, not against whatever the model chose to echo back.
 *
 * 2. CV TEXT — `renderCvForScreening`: the parsed CV rendered to the exact
 *    text the model is shown, and therefore the ONLY text a quote may come
 *    from. Contact details, location and spoken languages are deliberately
 *    NOT rendered (no protected-attribute proxies reach the prompt).
 *
 * 3. RECONCILIATION — `reconcileScreeningEvidence`: the trust layer. Every
 *    quote is checked with the SAME verbatim matcher the AI-interview evidence
 *    uses (./quote-verify.ts). A quote that is not in the CV text is DROPPED
 *    (never repaired) and counted. A met / partially_met verdict that is left
 *    with no verified quote is DOWNGRADED to unclear — the AI never gets to
 *    assert a match it cannot show in the candidate's own CV. A not_met that
 *    cited quotes which all failed verification is likewise downgraded.
 *    Unknown / duplicate criterion keys are discarded; criteria the model
 *    skipped are filled in as unclear.
 *
 * 4. ORDERING — `screeningSortKey` / `compareScreeningSummaries`: met count
 *    (partially_met counts 0.5) descending, then not_met count ascending.
 */

import type { ParserOutput } from "@hireops/ai-client";
import { cleanQuote, isVerbatimQuote, normaliseForQuoteMatch } from "./quote-verify";

export const SCREENING_VERDICTS = ["met", "partially_met", "not_met", "unclear"] as const;
export type ScreeningVerdict = (typeof SCREENING_VERDICTS)[number];

export type ScreeningCriterionKind = "must_have" | "requirement";

export interface ScreeningCriterion {
  /** Stable within one criteria set: `mh-<n>` / `rq-<n>`. */
  key: string;
  kind: ScreeningCriterionKind;
  label: string;
}

export interface ScreeningCriterionEvidence extends ScreeningCriterion {
  verdict: ScreeningVerdict;
  reason: string;
  /** 0–2 verbatim CV quotes, each verified against the CV text. */
  quotes: string[];
}

export interface ScreeningEvidenceCounts {
  criteriaCount: number;
  met: number;
  partiallyMet: number;
  notMet: number;
  unclear: number;
}

/** One criterion as the model returned it (pre-verification). */
export interface RawScreeningCriterion {
  criterion_key: string;
  verdict: ScreeningVerdict;
  reason: string;
  quotes: string[];
}

/* ───────────────────────────────── caps ───────────────────────────────── */

export const MAX_MUST_HAVE_CRITERIA = 15;
export const MAX_REQUIREMENT_CRITERIA = 10;
export const MAX_CRITERION_LABEL_CHARS = 200;
export const MAX_QUOTES_PER_CRITERION = 2;
export const MAX_QUOTE_CHARS = 300;
export const MAX_REASON_CHARS = 300;
/** The CV text handed to the model (and verified against) is capped here. */
export const CV_TEXT_CHAR_CAP = 16_000;

/* ─────────────────────────────── criteria ─────────────────────────────── */

export interface CriteriaSkillInput {
  skillName: string;
  weight: number;
  isRequired: boolean;
}

/**
 * The criteria for one requisition. Must-haves are the REQUIRED jd_skills in
 * the caller's order (the drain orders by weight desc, then name). Requirement
 * lines come from the JD's requirements section; a line that is just a
 * must-have name again (case/whitespace-insensitive) is dropped as a duplicate.
 */
export function buildScreeningCriteria(input: {
  jdSkills: readonly CriteriaSkillInput[];
  jdRequirements: readonly string[];
}): ScreeningCriterion[] {
  const out: ScreeningCriterion[] = [];
  const seen = new Set<string>();

  const clip = (s: string): string => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > MAX_CRITERION_LABEL_CHARS
      ? `${t.slice(0, MAX_CRITERION_LABEL_CHARS - 1).trimEnd()}…`
      : t;
  };

  let mh = 0;
  for (const s of input.jdSkills) {
    if (!s.isRequired) continue;
    const label = clip(s.skillName);
    const norm = normaliseForQuoteMatch(label);
    if (!label || seen.has(norm)) continue;
    if (mh >= MAX_MUST_HAVE_CRITERIA) break;
    seen.add(norm);
    mh += 1;
    out.push({ key: `mh-${mh}`, kind: "must_have", label });
  }

  let rq = 0;
  for (const line of input.jdRequirements) {
    const label = clip(line.replace(/^[\s•*\-–—]+/, ""));
    const norm = normaliseForQuoteMatch(label);
    if (!label || seen.has(norm)) continue;
    if (rq >= MAX_REQUIREMENT_CRITERIA) break;
    seen.add(norm);
    rq += 1;
    out.push({ key: `rq-${rq}`, kind: "requirement", label });
  }
  return out;
}

/**
 * The JD "requirements" list from `jd_versions.ai_metadata` (jsonb, typed
 * unknown). Defensive: anything that is not `{ sections: { requirements:
 * string[] } }` yields [].
 */
export function jdRequirementsFromMetadata(aiMetadata: unknown): string[] {
  if (!aiMetadata || typeof aiMetadata !== "object") return [];
  const sections = (aiMetadata as Record<string, unknown>).sections;
  if (!sections || typeof sections !== "object") return [];
  const reqs = (sections as Record<string, unknown>).requirements;
  if (!Array.isArray(reqs)) return [];
  return reqs.filter((r): r is string => typeof r === "string" && r.trim().length > 0);
}

/* ─────────────────────────────── CV text ──────────────────────────────── */

/**
 * The parsed CV as screening text. EXCLUDES `personal` (name, email, phone,
 * location, links), `skills.languages` (spoken languages are a national-origin
 * proxy) and expected compensation — none of them is screening evidence for a
 * must-have, and none may reach the model. Line-oriented so a quote is
 * naturally one line or part of one.
 */
export function renderCvForScreening(p: ParserOutput): string {
  const lines: string[] = [];
  if (p.total_years_experience !== null) {
    lines.push(`Total years of experience: ${p.total_years_experience}`);
  }
  if (p.summary && p.summary.trim()) {
    lines.push("Summary:", p.summary.trim());
  }

  if (p.work_history.length > 0) {
    lines.push("Experience:");
    for (const w of p.work_history) {
      lines.push(`- ${w.title} at ${w.company} (${w.start_date} to ${w.end_date ?? "present"})`);
      if (w.description && w.description.trim()) lines.push(w.description.trim());
    }
  } else if (p.current_role) {
    const c = p.current_role;
    lines.push("Experience:", `- ${c.title} at ${c.company} (${c.start_date} to present)`);
    if (c.description && c.description.trim()) lines.push(c.description.trim());
  }

  if (p.education.length > 0) {
    lines.push("Education:");
    for (const e of p.education) {
      const field = e.field_of_study ? ` in ${e.field_of_study}` : "";
      const years =
        e.start_year !== null || e.end_year !== null
          ? ` (${e.start_year ?? "?"} to ${e.end_year ?? "?"})`
          : "";
      lines.push(`- ${e.degree}${field}, ${e.institution}${years}`);
    }
  }

  if (p.skills.technical.length > 0) lines.push(`Skills: ${p.skills.technical.join(", ")}`);
  if (p.skills.domain.length > 0) lines.push(`Domain skills: ${p.skills.domain.join(", ")}`);
  if (p.skills.certifications.length > 0) {
    lines.push("Certifications:");
    for (const c of p.skills.certifications) {
      const meta = [c.issuer, c.year !== null ? String(c.year) : null].filter(Boolean).join(", ");
      lines.push(`- ${c.name}${meta ? ` (${meta})` : ""}`);
    }
  }
  if (p.notice_period_days !== null) lines.push(`Notice period: ${p.notice_period_days} days`);

  const text = lines.join("\n");
  return text.length > CV_TEXT_CHAR_CAP ? text.slice(0, CV_TEXT_CHAR_CAP) : text;
}

/* ──────────────────────────── reconciliation ──────────────────────────── */

const MISSING_REASON = "The screener returned no assessment for this criterion.";
const DOWNGRADE_NOTE =
  "No supporting quote could be verified against the CV, so this is marked unclear.";

function clipReason(reason: string): string {
  const t = reason.replace(/\s+/g, " ").trim();
  return t.length > MAX_REASON_CHARS ? `${t.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…` : t;
}

export interface ReconciledScreeningEvidence {
  criteria: ScreeningCriterionEvidence[];
  counts: ScreeningEvidenceCounts;
  /** Quotes discarded because they were not verbatim / duplicate / over cap / unknown key. */
  quotesDropped: number;
  /** Criteria whose verdict was downgraded to unclear by verification. */
  downgraded: number;
}

/**
 * The model's raw criteria → the stored evidence, in the order of the
 * criteria ON RECORD. `cvText` must be the SAME text the prompt carried
 * (after any PII masking), since that is the only text the model could quote.
 */
export function reconcileScreeningEvidence(args: {
  raw: readonly RawScreeningCriterion[];
  criteria: readonly ScreeningCriterion[];
  cvText: string;
}): ReconciledScreeningEvidence {
  let quotesDropped = 0;
  let downgraded = 0;
  const known = new Set(args.criteria.map((c) => c.key));
  const rawByKey = new Map<string, RawScreeningCriterion>();
  for (const r of args.raw) {
    const key = r.criterion_key.trim();
    if (!known.has(key) || rawByKey.has(key)) {
      quotesDropped += r.quotes.length;
      continue;
    }
    rawByKey.set(key, r);
  }

  const out: ScreeningCriterionEvidence[] = args.criteria.map((c) => {
    const r = rawByKey.get(c.key);
    if (!r) return { ...c, verdict: "unclear", reason: MISSING_REASON, quotes: [] };

    const kept: string[] = [];
    const keptNorm = new Set<string>();
    for (const q of r.quotes) {
      const cleaned = cleanQuote(q);
      const norm = normaliseForQuoteMatch(cleaned);
      if (
        cleaned.length > MAX_QUOTE_CHARS ||
        !isVerbatimQuote(cleaned, args.cvText) ||
        keptNorm.has(norm) ||
        kept.length >= MAX_QUOTES_PER_CRITERION
      ) {
        quotesDropped += 1;
        continue;
      }
      keptNorm.add(norm);
      kept.push(cleaned);
    }

    let verdict: ScreeningVerdict = r.verdict;
    let reason = clipReason(r.reason);
    // A positive verdict must be SHOWN in the CV. A negative one that rested
    // on quotes that turned out not to exist rested on nothing.
    const reliedOnQuotes =
      verdict === "met" ||
      verdict === "partially_met" ||
      (verdict === "not_met" && r.quotes.length > 0);
    if (reliedOnQuotes && kept.length === 0) {
      verdict = "unclear";
      reason = reason ? `${reason} ${DOWNGRADE_NOTE}` : DOWNGRADE_NOTE;
      downgraded += 1;
    }
    return { ...c, verdict, reason: reason || "No reason given.", quotes: kept };
  });

  return { criteria: out, counts: countScreeningVerdicts(out), quotesDropped, downgraded };
}

/* ─────────────────────────────── ordering ─────────────────────────────── */

export function countScreeningVerdicts(
  criteria: readonly { verdict: ScreeningVerdict }[],
): ScreeningEvidenceCounts {
  const counts: ScreeningEvidenceCounts = {
    criteriaCount: criteria.length,
    met: 0,
    partiallyMet: 0,
    notMet: 0,
    unclear: 0,
  };
  for (const c of criteria) {
    if (c.verdict === "met") counts.met += 1;
    else if (c.verdict === "partially_met") counts.partiallyMet += 1;
    else if (c.verdict === "not_met") counts.notMet += 1;
    else counts.unclear += 1;
  }
  return counts;
}

/**
 * The deterministic screening order as a tuple: [met points DESC, not-met
 * ASC]. Met points = met + 0.5 × partially_met.
 */
export function screeningSortKey(
  c: Pick<ScreeningEvidenceCounts, "met" | "partiallyMet" | "notMet">,
): [metPoints: number, notMet: number] {
  return [c.met + 0.5 * c.partiallyMet, c.notMet];
}

/**
 * Comparator for Array.prototype.sort: best evidence first; rows with no
 * evidence (null) last. Ties return 0 so the caller's stable secondary order
 * (e.g. most recent first) survives.
 */
export function compareScreeningSummaries(
  a: Pick<ScreeningEvidenceCounts, "met" | "partiallyMet" | "notMet"> | null,
  b: Pick<ScreeningEvidenceCounts, "met" | "partiallyMet" | "notMet"> | null,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const [am, an] = screeningSortKey(a);
  const [bm, bn] = screeningSortKey(b);
  if (am !== bm) return bm - am;
  return an - bn;
}
