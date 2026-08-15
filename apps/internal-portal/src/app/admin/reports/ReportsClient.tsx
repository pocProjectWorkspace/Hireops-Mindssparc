"use client";

import { useMemo, useState, type ReactNode } from "react";
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
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc } from "@/lib/trpc-client";
import { humanizeSentence } from "@/lib/labels";

/**
 * The admin recruitment report — totals tiles, the pipeline funnel as
 * horizontal bars, a source-mix table, the time-to-hire trio, and a
 * per-stage duration table, over getRecruitmentReport. Seeded from the
 * server render (`initial`) for the default all-time window and kept live
 * by a plain tRPC query.
 *
 * Deliberately basic (REPORT-01): counts, medians, and breakdowns. No
 * cohorting or exports — the richer filter bar (BU, requisition, recruiter,
 * source) lands with the /reports catalog surface in R0.2.
 *
 * R0.1 wires the date range the API had reserved and ignored. Two native
 * date inputs bound applications.created_at; both empty = all time, which
 * is the server-prefetched `initial` (so the default view still costs no
 * client fetch). A calendar date is widened to a whole UTC day — 00:00:00
 * on `from`, 23:59:59.999 on `to` — matching the inclusive bounds the
 * semantic layer applies server-side.
 *
 * DESIGN-03: tiles → StatTile, the funnel → the shared DataBar (one bar
 * language with the costs dashboard), the source-mix + stage-duration tables →
 * TableShell. Null medians render as a calm em dash.
 */
export function ReportsClient({ initial }: { initial: GetRecruitmentReportOutput }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const isAllTime = from === "" && to === "";

  const input = useMemo(
    () => ({
      ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
      ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
    }),
    [from, to],
  );

  const query = trpc.getRecruitmentReport.useQuery(input, {
    // Seed only the all-time key — a filtered window must actually fetch.
    initialData: isAllTime ? initial : undefined,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });

  const data = query.data ?? initial;
  const { funnel, sourceMix, timeToHire, stageDurations, totals } = data;
  const hasApplications = totals.applications > 0;
  const maxFunnel = funnel.reduce((m, f) => Math.max(m, f.current_count), 0);

  return (
    <PageContainer>
      <p className="mb-4 text-sm text-neutral-600">
        Recruitment funnel, source mix, and time in pipeline across{" "}
        {isAllTime ? "all applications, all time" : "applications received in the window below"}.
        Medians use exact stage-transition history.
      </p>

      <section className="mb-6 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          Applications received
        </span>
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="From date"
          className={dateInputCls}
        />
        <span className="text-xs text-neutral-400">to</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
          aria-label="To date"
          className={dateInputCls}
        />
        {!isAllTime ? (
          <button
            type="button"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
            className="h-8 rounded-full border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-700 hover:bg-neutral-50 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            All time
          </button>
        ) : null}
        {query.isFetching ? <span className="text-xs text-neutral-400">Updating…</span> : null}
      </section>

      {!hasApplications ? (
        <Card padded={false}>
          <EmptyState
            title={isAllTime ? "No applications recorded" : "No applications in this window"}
            hint={
              isAllTime
                ? "The funnel and medians populate as applications flow through the pipeline."
                : "Widen the date range, or clear it to see all time."
            }
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
                      <Td label="Source">{humanize(s.source)}</Td>
                      <Td numeric label="Applications">
                        {s.applications.toLocaleString()}
                      </Td>
                      <Td numeric label="Hires">
                        {s.hires.toLocaleString()}
                      </Td>
                      <Td numeric label="Conversion">
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
                No completed hires yet, medians appear once applications reach offer accepted.
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
                    <Td label="Stage">{humanize(s.stage)}</Td>
                    <Td numeric label="Median days in stage">
                      {formatDays(s.median_days)}
                    </Td>
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
    </PageContainer>
  );
}

/** Pill-shaped control, same language as the audit filter bar. */
const dateInputCls =
  "h-8 rounded-full border border-neutral-300 bg-white px-3 text-xs text-neutral-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

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
  return humanizeSentence(value);
}
