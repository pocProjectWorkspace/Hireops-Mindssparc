"use client";

import { useMemo, useState, type ReactNode } from "react";
import type {
  GetRequisitionAgingReportOutput,
  GetRecruiterProductivityReportOutput,
} from "@hireops/api-types";
import {
  Badge,
  Card,
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
 * The /reports catalog (R0.2) — every report on ONE shared filter bar.
 *
 * The catalog's promise is that "requisitions in this period, in this BU,
 * for this recruiter" means the same thing in every section, because all
 * of them take the same `reportFiltersSchema` input and resolve it through
 * the one server-side semantic layer. Two reports ship here (requisition
 * aging, recruiter productivity — the two the build plan rates as
 * genuinely absent); the rest of the catalog re-homes the existing
 * persona surfaces in a later ticket.
 *
 * FILTER OPTION LISTS are derived from the UNFILTERED server prefetch and
 * then held constant, deliberately:
 *   - `listBusinessUnits` is gated to admin/hiring_manager/recruiter, so
 *     hr_head and hr_ops — two of this surface's three personas — cannot
 *     call it. Widening that gate is out of scope for this ticket.
 *   - Deriving from the CURRENT result set instead would make options
 *     vanish as you filter (pick a BU, lose every other BU).
 * The lists therefore show the BUs and recruiters that appear anywhere in
 * the tenant's requisition/application history, which is exactly the set
 * that can produce a non-empty report.
 *
 * The unfiltered view is the server-prefetched `initial*` (so the default
 * landing costs no client fetch); any filter change fetches. Calendar
 * dates are widened to whole UTC days — 00:00:00 on `from`, 23:59:59.999
 * on `to` — matching the inclusive bounds the semantic layer applies.
 */

/** Age past which an OPEN requisition is worth chasing. */
const AGING_HIGHLIGHT_DAYS = 30;

export function ReportsHubClient({
  initialAging,
  initialProductivity,
}: {
  initialAging: GetRequisitionAgingReportOutput;
  initialProductivity: GetRecruiterProductivityReportOutput;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [businessUnitId, setBusinessUnitId] = useState("");
  const [recruiterMembershipId, setRecruiterMembershipId] = useState("");

  const isUnfiltered = !from && !to && !businessUnitId && !recruiterMembershipId;

  const input = useMemo(
    () => ({
      ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
      ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
      ...(businessUnitId ? { businessUnitId } : {}),
      ...(recruiterMembershipId ? { recruiterMembershipId } : {}),
    }),
    [from, to, businessUnitId, recruiterMembershipId],
  );

  const agingQuery = trpc.getRequisitionAgingReport.useQuery(input, {
    // Seed only the unfiltered key — a filtered view must actually fetch.
    initialData: isUnfiltered ? initialAging : undefined,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
  const productivityQuery = trpc.getRecruiterProductivityReport.useQuery(input, {
    initialData: isUnfiltered ? initialProductivity : undefined,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });

  const aging = agingQuery.data ?? initialAging;
  const productivity = productivityQuery.data ?? initialProductivity;
  const isFetching = agingQuery.isFetching || productivityQuery.isFetching;

  // Options come from the unfiltered prefetch and never change — see the
  // file header for why they aren't a separate list procedure.
  const businessUnitOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of initialAging.rows) byId.set(r.businessUnitId, r.businessUnitName);
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [initialAging]);

  const recruiterOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of initialProductivity.rows) {
      byId.set(r.recruiterMembershipId, r.recruiterName ?? "Unnamed recruiter");
    }
    for (const r of initialAging.rows) {
      if (!byId.has(r.recruiterMembershipId)) {
        byId.set(r.recruiterMembershipId, r.recruiterName ?? "Unnamed recruiter");
      }
    }
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [initialAging, initialProductivity]);

  const openCount = aging.byStatus
    .filter((s) => !TERMINAL_STATUSES.has(s.status))
    .reduce((sum, s) => sum + s.count, 0);
  const oldestOpen = aging.rows.find((r) => !r.isTerminal)?.daysOpen ?? null;

  return (
    <PageContainer>
      <p className="mb-4 max-w-3xl text-sm text-neutral-600">
        The reporting catalog. Every report below answers its question over the same period,
        business unit and recruiter — set them once in the filter bar and the whole page moves
        together. Numbers come from live requisition, application, interview and offer records; no
        snapshots or overnight rollups.
      </p>

      <section
        aria-label="Report filters"
        className="mb-8 flex flex-wrap items-center gap-2 rounded-card border border-neutral-200 bg-neutral-50/60 px-3 py-2.5"
      >
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Period</span>
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="From date"
          className={controlCls}
        />
        <span className="text-xs text-neutral-400">to</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
          aria-label="To date"
          className={controlCls}
        />
        <select
          value={businessUnitId}
          onChange={(e) => setBusinessUnitId(e.target.value)}
          aria-label="Business unit"
          className={controlCls}
        >
          <option value="">All business units</option>
          {businessUnitOptions.map((bu) => (
            <option key={bu.id} value={bu.id}>
              {bu.name}
            </option>
          ))}
        </select>
        <select
          value={recruiterMembershipId}
          onChange={(e) => setRecruiterMembershipId(e.target.value)}
          aria-label="Recruiter"
          className={controlCls}
        >
          <option value="">All recruiters</option>
          {recruiterOptions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        {!isUnfiltered ? (
          <button
            type="button"
            onClick={() => {
              setFrom("");
              setTo("");
              setBusinessUnitId("");
              setRecruiterMembershipId("");
            }}
            className="h-8 rounded-full border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-700 hover:bg-neutral-50 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            Clear filters
          </button>
        ) : null}
        {isFetching ? <span className="text-xs text-neutral-400">Updating…</span> : null}
      </section>

      <ReportSection
        title="Requisition status & aging"
        blurb={
          <>
            Every requisition raised in the period, oldest first. An open requisition ages to today;
            a filled, closed or cancelled one stops ageing at the first transition into that status.
            Anything open past {AGING_HIGHLIGHT_DAYS} days is flagged.
          </>
        }
      >
        {aging.rows.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title={isUnfiltered ? "No requisitions yet" : "No requisitions match these filters"}
              hint={
                isUnfiltered
                  ? "Requisitions appear here as soon as they are raised."
                  : "Widen the period, or clear the filters."
              }
            />
          </Card>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile
                label="Requisitions"
                value={totalOf(aging).toLocaleString()}
                tone="accent"
              />
              <StatTile label="Still open" value={openCount.toLocaleString()} />
              <StatTile label="Filled" value={countOf(aging, "filled").toLocaleString()} />
              <StatTile label="Oldest open (days)" value={formatDays(oldestOpen)} />
            </div>

            <div className="mb-4 flex flex-wrap gap-2">
              {aging.byStatus.map((s) => (
                <span
                  key={s.status}
                  className={
                    s.count === 0
                      ? "inline-flex items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 py-1 text-xs text-neutral-400"
                      : "inline-flex items-center gap-1.5 rounded-full border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700"
                  }
                >
                  <span className="font-medium">{humanizeSentence(s.status)}</span>
                  <span className="tabular-nums">{s.count}</span>
                  <span className="text-neutral-400">avg {formatDays(s.avgDaysOpen)}d</span>
                </span>
              ))}
            </div>

            <TableShell>
              <Thead>
                <Th>Requisition</Th>
                <Th>Business unit</Th>
                <Th>Status</Th>
                <Th>Recruiter</Th>
                <Th numeric>Openings</Th>
                <Th numeric>Raised</Th>
                <Th numeric>Days open</Th>
              </Thead>
              <Tbody>
                {aging.rows.map((r) => (
                  <Tr key={r.requisitionId}>
                    <Td label="Requisition">{r.title}</Td>
                    <Td label="Business unit">{r.businessUnitName}</Td>
                    <Td label="Status">
                      <Badge tone={statusTone(r.status)} pill>
                        {humanizeSentence(r.status)}
                      </Badge>
                    </Td>
                    <Td label="Recruiter">{r.recruiterName ?? "—"}</Td>
                    <Td numeric label="Openings">
                      {r.openings.toLocaleString()}
                    </Td>
                    <Td numeric label="Raised">
                      {formatDate(r.createdAt)}
                    </Td>
                    <Td numeric label="Days open">
                      <span
                        className={
                          !r.isTerminal && r.daysOpen > AGING_HIGHLIGHT_DAYS
                            ? "font-semibold text-status-warning-800"
                            : undefined
                        }
                      >
                        {formatDays(r.daysOpen)}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </TableShell>
            {aging.truncated ? (
              <p className="mt-2 text-xs text-neutral-500">
                Showing the {aging.rows.length.toLocaleString()} oldest requisitions. The status
                summary above still counts every requisition in range.
              </p>
            ) : null}
          </>
        )}
      </ReportSection>

      <ReportSection
        title="Recruiter productivity"
        blurb={
          <>
            What each recruiter moved in the period. Requisitions owned counts reqs where they are
            the primary recruiter, over when the requisition was raised; the activity columns count
            work on applications assigned to them, over when the application arrived — so the two
            halves answer different questions on purpose.
          </>
        }
      >
        {productivity.rows.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title={
                isUnfiltered ? "No recruiter activity yet" : "No recruiter activity in this range"
              }
              hint="Rows appear once a recruiter owns a requisition or is assigned an application."
            />
          </Card>
        ) : (
          <TableShell>
            <Thead>
              <Th>Recruiter</Th>
              <Th numeric>Reqs owned</Th>
              <Th numeric>Applications</Th>
              <Th numeric>Interviews</Th>
              <Th numeric>Offers extended</Th>
              <Th numeric>Hires</Th>
            </Thead>
            <Tbody>
              {productivity.rows.map((r) => (
                <Tr key={r.recruiterMembershipId}>
                  <Td label="Recruiter">{r.recruiterName ?? "Unnamed recruiter"}</Td>
                  <Td numeric label="Reqs owned">
                    {r.reqsOwned.toLocaleString()}
                  </Td>
                  <Td numeric label="Applications">
                    {r.applications.toLocaleString()}
                  </Td>
                  <Td numeric label="Interviews">
                    {r.interviewsScheduled.toLocaleString()}
                  </Td>
                  <Td numeric label="Offers extended">
                    {r.offersExtended.toLocaleString()}
                  </Td>
                  <Td numeric label="Hires">
                    {r.hires.toLocaleString()}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </TableShell>
        )}
      </ReportSection>
    </PageContainer>
  );
}

/** Mirrors the server's terminal-status set (lib/reports/requisition-aging.ts). */
const TERMINAL_STATUSES = new Set(["filled", "cancelled", "closed"]);

/** Pill-shaped control, same language as the admin report + audit filter bars. */
const controlCls =
  "h-8 rounded-full border border-neutral-300 bg-white px-3 text-xs text-neutral-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

function ReportSection({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-10 last:mb-0">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">{title}</h2>
      <p className="mb-3 mt-1 max-w-3xl text-xs text-neutral-500">{blurb}</p>
      {children}
    </section>
  );
}

function totalOf(aging: GetRequisitionAgingReportOutput): number {
  return aging.byStatus.reduce((sum, s) => sum + s.count, 0);
}

function countOf(aging: GetRequisitionAgingReportOutput, status: string): number {
  return aging.byStatus.find((s) => s.status === status)?.count ?? 0;
}

/** null → "—"; otherwise a 1-decimal day count. */
function formatDays(days: number | null): string {
  if (days === null) return "—";
  return days.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** ISO instant → a short UTC calendar date (the period filter is UTC too). */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Status → badge tone: live states neutral/info, terminal states resolved. */
function statusTone(status: string): "neutral" | "info" | "success" | "warning" | "error" {
  switch (status) {
    case "filled":
      return "success";
    case "posted":
    case "approved":
      return "info";
    case "on_hold":
      return "warning";
    case "cancelled":
      return "error";
    default:
      return "neutral";
  }
}
