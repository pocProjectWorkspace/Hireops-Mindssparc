import { cn } from "@/components/ui/cn";
import { Badge } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import type {
  MatchTierValue,
  RequisitionPhase,
  ApplicationStage,
  ApplicationSource,
} from "@hireops/api-types";

/**
 * RECR-02 chips — the recruiter candidates + shortlist surfaces' small pills.
 * Match-tier chips are OWNED here (deterministic buckets of the REAL ai_score,
 * never a fabricated "confidence"); urgency + risk + phase chips render the
 * deterministic verdicts from lib/recruiter-urgency. All are text-only tinted
 * grounds on our slate+indigo tokens so a row of them reads as quiet metadata.
 */

// ─────────────── AI score ───────────────

/**
 * Compact AI-score value for a table cell. Reuses the triage honesty rule:
 * a null score reads "Unscored" (calm neutral), never a fabricated 0%. Scored
 * values tint by tier so the eye finds the strong candidates.
 */
export function ScoreValue({ score, className }: { score: number | null; className?: string }) {
  if (score == null) {
    return <span className={cn("text-xs text-neutral-400", className)}>Unscored</span>;
  }
  const rounded = Math.round(score);
  const tone =
    rounded >= 75
      ? "text-status-positive-700"
      : rounded >= 60
        ? "text-neutral-800"
        : "text-status-warning-800";
  return <span className={cn("font-semibold tabular-nums", tone, className)}>{rounded}%</span>;
}

// ─────────────── match tier ───────────────

const TIER_META: Record<
  Exclude<MatchTierValue, "below">,
  { label: string; short: string; tone: BadgeTone }
> = {
  excellent: { label: "Excellent match (90+)", short: "Excellent", tone: "gold" },
  good: { label: "Good match (75–89)", short: "Good", tone: "accent" },
  partial: { label: "Partial match (60–74)", short: "Partial", tone: "silver" },
};

export function MatchTierChip({
  tier,
  full = false,
  className,
}: {
  tier: MatchTierValue;
  full?: boolean;
  className?: string;
}) {
  if (tier === "below") return null;
  const meta = TIER_META[tier];
  return (
    <Badge tone={meta.tone} pill className={className}>
      {full ? meta.label : meta.short}
    </Badge>
  );
}

// ─────────────── urgency ───────────────

const URGENCY_META: Record<"high" | "medium" | "low", { label: string; cls: string }> = {
  high: { label: "High", cls: "bg-status-error-50 text-status-error-700" },
  medium: { label: "Medium", cls: "bg-status-warning-50 text-status-warning-800" },
  low: { label: "Low", cls: "bg-neutral-100 text-neutral-600" },
};

/**
 * Urgency chip — REPLACES the prototype's "Heat Score %". Shows the
 * DETERMINISTIC rank + the 0–100 index (not a probability). The title spells
 * out the honest provenance for anyone who hovers.
 */
export function UrgencyChip({
  rank,
  index,
  className,
}: {
  rank: "high" | "medium" | "low";
  index: number;
  className?: string;
}) {
  const meta = URGENCY_META[rank];
  return (
    <span
      title="Deterministic urgency: SLA state + time-in-stage + notice period. Not a probability."
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
        meta.cls,
        className,
      )}
    >
      {meta.label}
      <span className="tabular-nums opacity-70">{index}</span>
    </span>
  );
}

// ─────────────── risk ───────────────

const RISK_LABELS: Record<string, string> = {
  skill_mismatch: "Skill gap",
  salary_gap: "Salary gap",
};

export function RiskCell({ flags, className }: { flags: string[]; className?: string }) {
  if (flags.length === 0) {
    return <span className={cn("text-xs text-status-positive-700", className)}>Clear</span>;
  }
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {flags.map((f) => (
        <Badge key={f} tone="warning" pill>
          {RISK_LABELS[f] ?? f}
        </Badge>
      ))}
    </span>
  );
}

// ─────────────── phase ───────────────

const PHASE_META: Record<RequisitionPhase, { label: string; tone: BadgeTone }> = {
  sourcing: { label: "Sourcing", tone: "neutral" },
  screening: { label: "Screening", tone: "info" },
  interviewing: { label: "Interviewing", tone: "accent" },
  offer: { label: "Offer", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
};

export function PhaseChip({ phase, className }: { phase: RequisitionPhase; className?: string }) {
  const meta = PHASE_META[phase];
  return (
    <Badge tone={meta.tone} pill className={className}>
      {meta.label}
    </Badge>
  );
}

// ─────────────── application stage ───────────────

export function stageLabel(stage: string): string {
  return stage.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const TERMINAL_STAGES = new Set(["offer_declined", "withdrawn", "recruiter_rejected"]);

const STAGE_TONE: Record<string, BadgeTone> = {
  recruiter_rejected: "error",
  withdrawn: "error",
  offer_declined: "error",
  offer_accepted: "success",
  offer_drafted: "success",
  shortlisted: "accent",
};

export function StageBadge({ stage, className }: { stage: ApplicationStage; className?: string }) {
  return (
    <Badge tone={STAGE_TONE[stage] ?? "neutral"} className={className}>
      {stageLabel(stage)}
    </Badge>
  );
}

export function isTerminalStage(stage: string): boolean {
  return TERMINAL_STAGES.has(stage);
}

// ─────────────── source ───────────────

const SOURCE_LABELS: Record<ApplicationSource, string> = {
  career_site: "Career site",
  referral: "Referral",
  partner_empanelled: "Partner",
  partner_adhoc: "Partner (ad-hoc)",
  job_board: "Job board",
  agency_search: "Agency search",
  talent_pool: "Talent pool",
  whatsapp: "WhatsApp",
};

export function sourceLabel(source: ApplicationSource | null): string {
  return source ? (SOURCE_LABELS[source] ?? source) : "—";
}

// ─────────────── missing info ───────────────

export function MissingInfoCell({
  info,
  className,
}: {
  info: { count: number; fields: string[] };
  className?: string;
}) {
  if (info.count === 0) {
    return <span className={cn("text-xs text-status-positive-700", className)}>Complete</span>;
  }
  const [first, ...rest] = info.fields;
  return (
    <span
      title={info.fields.join(", ")}
      className={cn("inline-flex items-center gap-1", className)}
    >
      <Badge tone="warning" pill>
        {first}
      </Badge>
      {rest.length > 0 ? (
        <span className="text-[11px] text-neutral-500">+{rest.length}</span>
      ) : null}
    </span>
  );
}
