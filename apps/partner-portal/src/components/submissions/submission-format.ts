import type { BadgeTone } from "@/components/ui";
import { fmtDate, humanise } from "@/components/reqs/req-format";

/**
 * Formatting shared by every surface that renders a SUBMISSION to a partner —
 * the dashboard's list, /submissions, and /submissions/<claimId> (P1.2).
 * Same job req-format.ts does for requisitions: one place decides how a stage
 * and an ownership claim are worded, so the three surfaces can't drift.
 *
 * The stage vocabulary is the application_stage enum verbatim; the labels are
 * the partner-facing wording the API's own partner stage emails use
 * (apps/api/src/lib/partner-stage-email.ts), extended to the stages a partner
 * can *see* on a list but never gets emailed about. No invented stages.
 */

/** Every stage the filter offers, in the enum's forward order. */
export const PARTNER_STAGE_OPTIONS = [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
] as const;

export type PartnerStageOption = (typeof PARTNER_STAGE_OPTIONS)[number];

const STAGE_LABELS: Record<PartnerStageOption, string> = {
  application_received: "Submitted",
  ai_screening: "Screening",
  recruiter_review: "Recruiter review",
  shortlisted: "Shortlisted",
  tech_interview: "Technical interview",
  hr_round: "HR round",
  offer_drafted: "Offer in progress",
  offer_accepted: "Offer accepted",
  offer_declined: "Offer declined",
  withdrawn: "Withdrawn",
  recruiter_rejected: "Not moving forward",
};

/** `true` for a stage string the platform actually knows about. */
export function isPartnerStage(value: string | null | undefined): value is PartnerStageOption {
  return typeof value === "string" && value in STAGE_LABELS;
}

/** The partner-facing name of a stage; an unknown value degrades to itself. */
export function stageLabel(stage: string): string {
  return isPartnerStage(stage) ? STAGE_LABELS[stage] : humanise(stage);
}

const STAGE_TONES: Record<PartnerStageOption, BadgeTone> = {
  application_received: "neutral",
  ai_screening: "info",
  recruiter_review: "info",
  shortlisted: "accent",
  tech_interview: "accent",
  hr_round: "accent",
  offer_drafted: "warning",
  offer_accepted: "success",
  offer_declined: "error",
  withdrawn: "neutral",
  recruiter_rejected: "error",
};

/** Badge tone for a stage; unknown stages read as neutral. */
export function stageTone(stage: string | null): BadgeTone {
  if (!stage || !isPartnerStage(stage)) return "neutral";
  return STAGE_TONES[stage];
}

export interface OwnershipState {
  active: boolean;
  tone: BadgeTone;
  headline: string;
  detail: string;
}

/**
 * The ownership banner, worded honestly for each claim state
 * (partner-wireflows §3.8). An `active` claim whose expiry has already passed
 * is read as lapsed regardless of the stored status: the sweep that flips
 * status to 'expired' runs daily, so the date is the truth the partner should
 * see, not the flag (see the note on the partial-unique index in
 * packages/db/src/schema/candidate-ownership-claims.ts).
 */
export function ownershipState(claim: {
  status: string;
  claimedAt: string;
  expiresAt: string;
  releasedAt: string | null;
}): OwnershipState {
  const expiry = new Date(claim.expiresAt);
  const lapsedByDate = !Number.isNaN(expiry.getTime()) && expiry.getTime() < Date.now();

  if (claim.status === "active" && !lapsedByDate) {
    return {
      active: true,
      tone: "success",
      headline: `Exclusive claim until ${fmtDate(claim.expiresAt)}`,
      detail: `Your organisation has owned this candidate since ${fmtDate(
        claim.claimedAt,
      )}. No other partner can submit them to Kyndryl while this window is open.`,
    };
  }

  if (claim.status === "released") {
    return {
      active: false,
      tone: "neutral",
      headline: `Ownership released${claim.releasedAt ? ` on ${fmtDate(claim.releasedAt)}` : ""}`,
      detail:
        "This claim was given up, so it no longer confers exclusivity on this candidate. Fee attribution follows your MSA.",
    };
  }

  if (claim.status === "superseded") {
    return {
      active: false,
      tone: "warning",
      headline: "Claim superseded",
      detail:
        "This claim has been replaced by a later one and no longer confers exclusivity. Fee attribution follows your MSA — contact your Kyndryl point of contact if you expected otherwise.",
    };
  }

  // status === 'expired', or an 'active' row the daily sweep hasn't caught up
  // with yet. Both are the same fact for the partner: the window has closed.
  return {
    active: false,
    tone: "warning",
    headline: `Ownership window expired on ${fmtDate(claim.expiresAt)}`,
    detail:
      "Your exclusivity window has closed. The candidate stays in the pipeline, but fee attribution now follows your MSA — contact your Kyndryl point of contact.",
  };
}

/**
 * The keys of applications.partner_submission_metadata this surface knows how
 * to render, in the order the wireflows' §3.8 "submitted details" card reads.
 * Anything else in the jsonb is ignored rather than dumped — the column is
 * schemaless, so the surface refuses to guess at a shape it wasn't given.
 */
export const SNAPSHOT_FIELDS: { key: string; label: string }[] = [
  { key: "currentTitle", label: "Current title" },
  { key: "currentCompany", label: "Current company" },
  { key: "noteToRecruiter", label: "Your note to the recruiter" },
  { key: "consentVersion", label: "Consent version attested" },
];

/** A snapshot value we can safely put on screen, or null to skip the row. */
export function snapshotValue(
  snapshot: Record<string, unknown> | null,
  key: string,
): string | null {
  const raw = snapshot?.[key];
  if (typeof raw === "string" && raw.trim() !== "") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return null;
}
