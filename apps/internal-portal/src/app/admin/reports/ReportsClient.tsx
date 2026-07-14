"use client";

import type { ReactNode } from "react";
import type { GetRecruitmentReportOutput } from "@hireops/api-types";
import {
  Card,
  DataBar,
  EmptyState,
  StatTile,
  TableShell,
  Thead,
  Th,
  Tbody,
  Tr,
  Td,
} from "@/components/ui";
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
 * DESIGN-03: tiles → StatTile, the funnel → the shared DataBar (one bar
 * language with the costs dashboard), the source-mix + stage-duration tables →
 * TableShell. Null medians render as a calm em dash.
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
        <Card padded={false}>
          <EmptyState
            title="No applications recorded"
            hint="The funnel and medians populate as applications flow through the pipeline."
          />
        </Card>
      ) : (
        <>
          <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatTile
              label="Applications"
              value={totals.applications.toLocaleString()}
              tone="accent"
            />
            <StatTile label="Active" value={totals.active.toLocaleString()} />
            <StatTile label="Hired" value={totals.hired.toLocaleString()} />
            <StatTile
              label="Rejected / withdrawn"
              value={totals.rejected_or_withdrawn.toLocaleString()}
            />
          </section>

          <Section title="Funnel">
            <Card className="space-y-2.5">
              {funnel.map((f) => {
                const pct = maxFunnel > 0 ? (f.current_count / maxFunnel) * 100 : 0;
                return (
                  <DataBar
                    key={f.stage}
                    label={humanize(f.stage)}
                    labelClassName="w-40 text-neutral-700"
                    pct={pct}
                    value={f.current_count.toLocaleString()}
                  />
                );
              })}
            </Card>
          </Section>

          <Section title="Source mix">
            {sourceMix.length === 0 ? (
              <Card padded={false}>
                <EmptyState title="No sourced applications in range" />
              </Card>
            ) : (
              <TableShell>
                <Thead>
                  <Th>Source</Th>
                  <Th numeric>Applications</Th>
                  <Th numeric>Hires</Th>
                  <Th numeric>Conversion</Th>
                </Thead>
                <Tbody>
                  {sourceMix.map((s) => (
                    <Tr key={s.source}>
                      <Td>{humanize(s.source)}</Td>
                      <Td numeric>{s.applications.toLocaleString()}</Td>
                      <Td numeric>{s.hires.toLocaleString()}</Td>
                      <Td numeric>
                        {s.applications > 0
                          ? `${((s.hires / s.applications) * 100).toFixed(1)}%`
                          : "—"}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </TableShell>
            )}
          </Section>

          <Section title="Time to hire">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <StatTile
                label="Median days"
                value={formatDays(timeToHire.median_days)}
                tone="accent"
              />
              <StatTile label="P90 days" value={formatDays(timeToHire.p90_days)} />
              <StatTile label="Hires" value={timeToHire.hires_count.toLocaleString()} />
            </div>
            {timeToHire.hires_count === 0 ? (
              <p className="mt-2 text-xs text-neutral-500">
                No completed hires yet — medians appear once applications reach offer accepted.
              </p>
            ) : null}
          </Section>

          <Section title="Stage durations">
            <TableShell>
              <Thead>
                <Th>Stage</Th>
                <Th numeric>Median days in stage</Th>
              </Thead>
              <Tbody>
                {stageDurations.map((s) => (
                  <Tr key={s.stage}>
                    <Td>{humanize(s.stage)}</Td>
                    <Td numeric>{formatDays(s.median_days)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </TableShell>
            <p className="mt-2 text-xs text-neutral-500">
              Median time an application spends in a stage before moving on. Terminal stages and
              stages with no completed visits show —.
            </p>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8 last:mb-0">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
        {title}
      </h2>
      {children}
    </section>
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
