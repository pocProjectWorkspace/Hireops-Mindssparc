/**
 * Human-readable labels for machine tokens (enum values, snake_case keys,
 * booleans) shown in the UI. Pure functions — no DOM — so they unit-test
 * cleanly and are shared across every form / badge / select.
 *
 * Replaces the scattered inline `value.replace(/_/g, " ")` formatters, which
 * title-cased naively and mangled acronyms ("Ai Screening", "Hr Ops",
 * "Jd Library"). The canonical-word table is the single place to teach the app
 * a new acronym's casing.
 */

import { STAGE_LABELS } from "@/components/candidate/candidate-format";

/**
 * Words that render in fixed casing rather than Title Case. Keyed by the
 * lowercased token; the value is the exact display casing. Extend as new
 * acronyms surface in enums.
 */
const CANONICAL_WORDS: Record<string, string> = {
  ai: "AI",
  hr: "HR",
  it: "IT",
  jd: "JD",
  sla: "SLA",
  kpi: "KPI",
  pii: "PII",
  gcc: "GCC",
  ttf: "TTF",
  lpa: "LPA",
  hrbp: "HRBP",
  qa: "QA",
  id: "ID",
  url: "URL",
  ctc: "CTC",
  poc: "POC",
};

function splitToken(value: string): string[] {
  return value
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
}

/**
 * Turn a machine token into a Title-Cased human label:
 *   "ai_screening"  → "AI Screening"
 *   "hr_ops"        → "HR Ops"
 *   "hiring-manager"→ "Hiring Manager"
 * Words in CANONICAL_WORDS keep their fixed casing. Empty / non-string input
 * yields "". Already-spaced input is normalised the same way.
 */
export function humanize(value: string | null | undefined): string {
  if (!value) return "";
  return splitToken(String(value))
    .map(
      (word) =>
        CANONICAL_WORDS[word.toLowerCase()] ??
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

/**
 * Sentence-case variant for phrase-like enums (pipeline stages, statuses):
 *   "application_received" → "Application received"
 * Only the first word is capitalised (canonical acronyms keep their casing
 * wherever they fall), which reads better than Title Case for full phrases.
 */
export function humanizeSentence(value: string | null | undefined): string {
  if (!value) return "";
  return splitToken(String(value))
    .map((word, i) => {
      const canonical = CANONICAL_WORDS[word.toLowerCase()];
      if (canonical) return canonical;
      const lower = word.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/**
 * Human label for an application stage key; falls back to humanize() for
 * unknown keys. The single source of stage wording for every internal-portal
 * surface (e.g. `tech_interview` → "Panel interview"), so a relabel in
 * STAGE_LABELS reaches badges, filters, charts and reports alike.
 */
export function applicationStageLabel(stage: string | null | undefined): string {
  if (!stage) return "—";
  return STAFF_STAGE_OVERRIDES[stage] ?? STAGE_LABELS[stage] ?? humanize(stage);
}

/**
 * Where the candidate-facing wording in STAGE_LABELS is deliberately soft
 * ("Not progressing"), staff need the operational word. Everything not listed
 * here shares the candidate label so both portals tell the same story.
 */
const STAFF_STAGE_OVERRIDES: Record<string, string> = {
  ai_screening: "AI screening",
  recruiter_review: "Recruiter review",
  offer_drafted: "Offer drafted",
  recruiter_rejected: "Rejected",
};

/**
 * Boolean → a human yes/no label. Defaults "Yes"/"No"; pass custom copy for
 * domain-specific booleans (e.g. { yes: "Required", no: "Optional" }).
 */
export function humanizeBool(
  value: boolean | null | undefined,
  opts: { yes?: string; no?: string } = {},
): string {
  return value ? (opts.yes ?? "Yes") : (opts.no ?? "No");
}
