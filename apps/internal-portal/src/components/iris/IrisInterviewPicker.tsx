"use client";

import { useMemo } from "react";
import { trpc } from "@/lib/trpc-client";

/**
 * IrisInterviewPicker — the interview picker behind the Iris `cancel_interview`
 * action. Backed by `listUpcomingInterviews` (the recruiter /interviews read,
 * gated to INTERVIEW_MANAGE_ROLES — the SAME set that may cancel an interview),
 * filtered to `status: "scheduled"` so only cancellable interviews are shown
 * (a completed / already-cancelled round can't be cancelled).
 *
 * The value is the interview id (`cancelInterview`'s input), with a human label
 * (candidate — round — time) for display.
 */

export interface IrisPickedInterview {
  interviewId: string;
  label: string;
}

/** Compact, locale-aware time label for a scheduled start (or a calm fallback). */
function formatWhen(scheduledStart: string | null): string {
  if (!scheduledStart) return "Time TBC";
  const d = new Date(scheduledStart);
  if (Number.isNaN(d.getTime())) return "Time TBC";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function IrisInterviewPicker({
  value,
  onChange,
  enabled,
}: {
  value: IrisPickedInterview | null;
  onChange: (picked: IrisPickedInterview | null) => void;
  enabled: boolean;
}) {
  const query = trpc.listUpcomingInterviews.useQuery(
    { status: "scheduled", limit: 100 },
    { enabled },
  );
  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);

  if (value) {
    return (
      <div className="rounded-lg border border-brand-200 bg-brand-50 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-medium text-brand-900">{value.label}</p>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="shrink-0 rounded-button px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="block text-sm font-medium text-neutral-800">Interview</p>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-neutral-200 bg-white">
        {query.isLoading ? (
          <p className="px-3 py-4 text-sm text-neutral-500">Loading interviews…</p>
        ) : query.error ? (
          <p className="px-3 py-4 text-sm text-status-error-700">Couldn&apos;t load interviews.</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-4 text-sm text-neutral-500">No scheduled interviews to cancel.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {rows.map((r) => {
              const who = r.candidateName ?? "(no name on file)";
              const when = formatWhen(r.scheduledStart);
              const label = `${who} — ${r.roundName} — ${when}`;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onChange({ interviewId: r.id, label })}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-neutral-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-neutral-800">
                        {who}
                      </span>
                      <span className="block truncate text-xs text-neutral-500">
                        {r.roundName} · {r.positionTitle}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">{when}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
