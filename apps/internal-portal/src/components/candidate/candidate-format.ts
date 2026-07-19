/**
 * Candidate-portal formatting + vocabulary (CAND-01). Shared by the routed
 * candidate pages (dashboard / applications / interviews) so the stage labels,
 * money, and date/time rendering stay consistent. Pure helpers, no hooks.
 *
 * INR ALWAYS (Wave 1 is India-only) — never USD/AED regardless of the
 * prototype's currency.
 */

/** Integer paise → a readable ₹ amount (whole rupees). */
export function formatInr(paise: number): string {
  const rupees = Math.round(paise / 100);
  return `₹${rupees.toLocaleString("en-IN")}`;
}

/** Candidate-safe stage labels. NEVER exposes an AI score — neutral status
 * only (the API already omits the score from candidate reads). */
export const STAGE_LABELS: Record<string, string> = {
  application_received: "Applied",
  ai_screening: "Screening",
  recruiter_review: "Under review",
  shortlisted: "Shortlisted",
  tech_interview: "Technical interview",
  hr_round: "HR round",
  offer_drafted: "Offer prepared",
  offer_accepted: "Offer accepted",
  offer_declined: "Offer declined",
  withdrawn: "Withdrawn",
  recruiter_rejected: "Not progressing",
};

/** Neutral one-line status per step for the timeline — deterministic, no
 * scores, no invented mechanics. */
export const STAGE_TIMELINE_NOTE: Record<string, string> = {
  application_received: "Application received",
  recruiter_review: "Under recruiter review",
  shortlisted: "Shortlisted for interviews",
  tech_interview: "Technical interview stage",
  hr_round: "HR round stage",
  offer_drafted: "Offer being prepared",
  offer_accepted: "Offer accepted",
};

export const TERMINAL_NEGATIVE = new Set(["offer_declined", "withdrawn", "recruiter_rejected"]);

export const MODE_LABEL: Record<string, string> = {
  video: "Video",
  onsite: "On-site",
  phone: "Phone",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

/** ISO → "20 Feb 2026" (date only). Returns "To be confirmed" for null. */
export function formatDate(iso: string | null): string {
  if (!iso) return "To be confirmed";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** ISO → "20 Feb 2026 · 14:00 UTC". Interview times are stored in UTC and we
 * label the zone honestly rather than guessing the candidate's locale. */
export function formatWhen(iso: string | null): string {
  if (!iso) return "To be confirmed";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return `${date} · ${iso.slice(11, 16)} UTC`;
}
