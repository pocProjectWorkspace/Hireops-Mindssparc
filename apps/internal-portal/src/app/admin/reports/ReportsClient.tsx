"use client";

import type { GetRecruitmentReportOutput } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";

/**
 * The admin recruitment report — totals tiles, the pipeline funnel as
 * horizontal bars, a source-mix table, the time-to-hire trio, and a
 * per-stage duration table, over getRecruitmentReport. Seeded from the
 * server render (`initial`) for the default all-time window and kept live
 * by a plain tRPC query.
 *
 * Deliberately basic (REPORT-01): counts, medians, and breakdowns. No
 * cohorting, exports, or filters — the API reserves from/to for a later
 * date-range picker but this surface always requests all-time.
 *
 * Bars are plain divs widthed as a % of the busiest stage (no chart
 * library, matching /admin/costs). Nulls — a median with no completed
 * visits, a time-to-hire with no hires — render as an em dash.
 */
export function ReportsClient({ initial }: { initial: GetRecruitmentReportOutput }) {
  const query = trpc.getRecruitmentReport.useQuery(
    {},
    {
      initialData: initial,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  );

  const data = query.data ?? initial;
  const { funnel, sourceMix, timeToHire, stageDurations, totals } = data;
  const hasApplications = totals.applications > 0;
  const maxFunnel = funnel.reduce((m, f) => Math.max(m, f.current_count), 0);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <p className="mb-6 text-sm text-neutral-600">
        Recruitment funnel, source mix, and time in pipeline across all applications. All time.
        Medians use exact stage-transition history.
      </p>

      {!hasApplications ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-6">
          <p className="text-sm text-neutral-500">No applications recorded.</p>
        </section>
      ) : (
        <>
          <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Tile label="Applications" value={totals.applications.toLocaleString()} tone="info" />
            <Tile label="Active" value={totals.active.toLocaleString()} />
            <Tile label="Hired" value={totals.hired.toLocaleString()} />
            <Tile
              label="Rejected / withdrawn"
              value={totals.rejected_or_withdrawn.toLocaleString()}
            />
          </section>

          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Funnel
            </h2>
            <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4">
              {funnel.map((f) => {
                const pct = maxFunnel > 0 ? (f.current_count / maxFunnel) * 100 : 0;
                return (
                  <div key={f.stage} className="flex items-center gap-3 text-xs">
                    <span className="w-40 shrink-0 text-neutral-700">{humanize(f.stage)}</span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-neutral-100">
                      {/* bg-brand-500, not bg-status-info-400: the portal
                          tailwind theme has no status-info scale (only
                          positive/warning/error), so the costs-page class
                          compiles to nothing — see hand-back finding. */}
                      <div
                        className="h-full rounded bg-brand-500"
                        style={{ width: `${pct}%` }}
                        aria-hidden
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right font-medium tabular-nums text-neutral-800">
                      {f.current_count.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Source mix
            </h2>
            {sourceMix.length === 0 ? (
              <EmptyCard>No sourced applications in range.</EmptyCard>
            ) : (
              <ReportTable
                headers={["Source", "Applications", "Hires", "Conversion"]}
                rows={sourceMix.map((s) => ({
                  key: s.source,
                  cells: [
                    humanize(s.source),
                    s.applications.toLocaleString(),
                    s.hires.toLocaleString(),
                    s.applications > 0 ? `${((s.hires / s.applications) * 100).toFixed(1)}%` : "—",
                  ],
                }))}
              />
            )}
          </section>

          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Time to hire
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Tile label="Median days" value={formatDays(timeToHire.median_days)} tone="info" />
              <Tile label="P90 days" value={formatDays(timeToHire.p90_days)} />
              <Tile label="Hires" value={timeToHire.hires_count.toLocaleString()} />
            </div>
            {timeToHire.hires_count === 0 ? (
              <p className="mt-2 text-xs text-neutral-500">
                No completed hires yet — medians appear once applications reach offer accepted.
              </p>
            ) : null}
          </section>

          <section className="mb-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Stage durations
            </h2>
            <ReportTable
              headers={["Stage", "Median days in stage"]}
              rows={stageDurations.map((s) => ({
                key: s.stage,
                cells: [humanize(s.stage), formatDays(s.median_days)],
              }))}
            />
            <p className="mt-2 text-xs text-neutral-500">
              Median time an application spends in a stage before moving on. Terminal stages and
              stages with no completed visits show —.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-6">
      <p className="text-sm text-neutral-500">{children}</p>
    </div>
  );
}

function ReportTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: { key: string; cells: React.ReactNode[] }[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
            {headers.map((h, i) => (
              <th key={h} className={`px-4 py-2 font-medium ${i === 0 ? "" : "text-right"}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-neutral-100 last:border-0">
              {row.cells.map((cell, i) => (
                <td
                  key={i}
                  className={`px-4 py-2 ${i === 0 ? "text-neutral-800" : "text-right tabular-nums text-neutral-700"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "info";
}) {
  // brand-* rather than the costs page's status-info-* — that scale isn't
  // in the portal tailwind theme, so those classes render transparent.
  const toneClass =
    tone === "info"
      ? "border-brand-100 bg-brand-50 text-brand-700"
      : "border-neutral-200 bg-white text-neutral-800";
  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <p className="text-xs uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}

/** null → "—"; otherwise a 1-decimal day count (e.g. "3.5"). */
function formatDays(days: number | null): string {
  if (days === null) return "—";
  return days.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** snake_case enum label → "Sentence case" for display. */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
