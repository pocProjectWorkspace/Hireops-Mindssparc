import { Badge, Card } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { PanelInterviewRow, FeedbackState } from "@hireops/api-types";

/** Anchor styled as a house button (valid link markup — no button-in-anchor). */
const LINK_BUTTON_BASE =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-button px-3 text-sm font-medium " +
  "transition-colors duration-150 focus-visible:outline focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-brand-500";
const LINK_BUTTON_SECONDARY =
  "bg-white text-neutral-700 border border-neutral-300 shadow-1 hover:bg-neutral-50 hover:border-neutral-400";
const LINK_BUTTON_PRIMARY = "bg-brand-600 text-white shadow-1 hover:bg-brand-700";

/**
 * InterviewCard (PANEL-01) — the reusable interview tile for the panel persona.
 *
 * Renders one interview the signed-in panellist is on: candidate, role, round,
 * time / duration / mode, a status chip, a candidate-confirmed indicator, the
 * panellist's own feedback state, and the Brief / Join / Scorecard actions.
 * Join opens the meeting URL in a new tab and is hidden when there is none.
 *
 * MERGE NOTE (PANEL-02): the session board reuses this component. Keep the prop
 * surface additive — pass an interviewRow-shaped object plus optional flags; do
 * not couple it to the dashboard's local state.
 */

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

/** The minimal shape InterviewCard needs — a structural subset of PanelInterviewRow
 * so PANEL-02's board can feed it its own rows without importing the full type. */
export type InterviewCardData = Pick<
  PanelInterviewRow,
  | "id"
  | "candidateName"
  | "positionTitle"
  | "roundNumber"
  | "roundName"
  | "status"
  | "mode"
  | "scheduledStart"
  | "durationMinutes"
  | "meetingUrl"
  | "candidateConfirmedAt"
> & { myFeedbackState?: FeedbackState };

export interface InterviewCardProps {
  interview: InterviewCardData;
  /** Show the "In window now" ribbon (dashboard computes this against `now`). */
  inWindowNow?: boolean;
  /** Hide the Scorecard CTA (e.g. a board that only briefs). Default false. */
  hideScorecard?: boolean;
  className?: string;
}

function statusTone(status: string): BadgeTone {
  switch (status) {
    case "scheduled":
      return "info";
    case "completed":
      return "success";
    case "no_show":
    case "cancelled":
      return "warning";
    default:
      return "neutral";
  }
}

function feedbackMeta(state: FeedbackState | undefined): { label: string; tone: BadgeTone } | null {
  switch (state) {
    case "submitted":
      return { label: "Scorecard submitted", tone: "success" };
    case "draft":
      return { label: "Scorecard draft", tone: "warning" };
    case "none":
      return { label: "No scorecard yet", tone: "neutral" };
    default:
      return null;
  }
}

function formatWhen(iso: string | null): string {
  if (!iso) return "Time TBC";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Time TBC";
  return d.toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function InterviewCard({
  interview: iv,
  inWindowNow = false,
  hideScorecard = false,
  className,
}: InterviewCardProps) {
  const fb = feedbackMeta(iv.myFeedbackState);
  const briefHref = `/panel/${iv.id}`;
  return (
    <Card className={cn("flex flex-col gap-3", inWindowNow && "ring-1 ring-brand-300", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-neutral-900">
              {iv.candidateName ?? "Candidate"}
            </h3>
            {inWindowNow ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand-600" />
                In window now
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-sm text-neutral-600">{iv.positionTitle}</p>
        </div>
        <Badge tone={statusTone(iv.status)}>{iv.status.replace(/_/g, " ")}</Badge>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
        <span className="font-medium text-neutral-700">
          Round {iv.roundNumber}: {iv.roundName}
        </span>
        <span aria-hidden className="text-neutral-300">
          ·
        </span>
        <span>{formatWhen(iv.scheduledStart)}</span>
        <span aria-hidden className="text-neutral-300">
          ·
        </span>
        <span>{iv.durationMinutes}m</span>
        <span aria-hidden className="text-neutral-300">
          ·
        </span>
        <span>{MODE_LABEL[iv.mode] ?? iv.mode}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {iv.candidateConfirmedAt ? (
          <Badge tone="success">Candidate confirmed</Badge>
        ) : iv.status === "scheduled" ? (
          <Badge tone="warning">Awaiting confirmation</Badge>
        ) : null}
        {fb ? <Badge tone={fb.tone}>{fb.label}</Badge> : null}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-3">
        <a href={briefHref} className={cn(LINK_BUTTON_BASE, LINK_BUTTON_SECONDARY)}>
          Brief
        </a>
        {iv.meetingUrl ? (
          <a
            href={iv.meetingUrl}
            target="_blank"
            rel="noreferrer"
            className={cn(LINK_BUTTON_BASE, LINK_BUTTON_SECONDARY)}
          >
            Join
          </a>
        ) : null}
        {!hideScorecard ? (
          <a href={briefHref} className={cn(LINK_BUTTON_BASE, LINK_BUTTON_PRIMARY, "ml-auto")}>
            {iv.myFeedbackState === "submitted" ? "View scorecard" : "Scorecard"}
          </a>
        ) : null}
      </div>
    </Card>
  );
}
