import { Card, EmptyState } from "@/components/ui";
import { RecommendationChip } from "@/components/patterns";
import type { GetPanelDashboardOutput } from "@hireops/api-types";

/**
 * PanelFeedbackQueue (PANEL-01) — /panel/feedback.
 *
 * Two sections over MY interview_feedback: Pending (red-tinted rows — completed
 * interviews with no submitted scorecard of mine, Score-now CTA) and Submitted
 * (neutral rows with a Submitted chip + my recommendation chip). Server-
 * rendered from getPanelDashboard; presentational only.
 */

function daysAgo(iso: string | null): string {
  if (!iso) return "past its window";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const hours = Math.floor((Date.now() - then) / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function PanelFeedbackQueue({ board }: { board: GetPanelDashboardOutput }) {
  const { pending, submitted } = board;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-8 py-6">
      {/* Pending */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Pending your score
          </h2>
          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-status-error-100 px-1.5 text-[11px] font-semibold text-status-error-700">
            {pending.length}
          </span>
        </div>
        {pending.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title="No scorecards waiting"
              hint="When you complete an interview, it appears here until you submit your scorecard."
            />
          </Card>
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-neutral-100">
              {pending.map((p) => (
                <li
                  key={p.interviewId}
                  className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-l-status-error-400 bg-status-error-50/40 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-900">
                      {p.candidateName ?? "Candidate"}
                      {p.overdue ? (
                        <span className="ml-2 rounded-full bg-status-error-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-error-700">
                          Overdue
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-neutral-500">
                      {p.roleTitle} · Round {p.roundNumber}: {p.roundName} ·{" "}
                      {p.completedAt ? `interviewed ${daysAgo(p.completedAt)}` : "past its window"}
                    </p>
                  </div>
                  <a
                    href={`/panel/${p.interviewId}`}
                    className="inline-flex h-8 shrink-0 items-center justify-center rounded-button bg-brand-600 px-3 text-sm font-medium text-white shadow-1 hover:bg-brand-700"
                  >
                    Score now
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      {/* Submitted */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Submitted
          </h2>
          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-neutral-100 px-1.5 text-[11px] font-semibold text-neutral-600">
            {submitted.length}
          </span>
        </div>
        {submitted.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title="Nothing submitted yet"
              hint="Your submitted scorecards will be listed here."
            />
          </Card>
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-neutral-100">
              {submitted.map((s) => (
                <li
                  key={s.interviewId}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-900">
                      {s.candidateName ?? "Candidate"}
                    </p>
                    <p className="truncate text-xs text-neutral-500">
                      {s.roleTitle} · Round {s.roundNumber}: {s.roundName} · submitted{" "}
                      {fmtDate(s.submittedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="inline-flex items-center rounded-full bg-status-positive-50 px-2 py-0.5 text-[11px] font-medium text-status-positive-700">
                      Submitted
                    </span>
                    <RecommendationChip recommendation={s.recommendation} />
                    <a
                      href={`/panel/${s.interviewId}`}
                      className="text-sm font-medium text-brand-700 hover:underline"
                    >
                      View
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
