"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import type {
  GetRequisitionAgingReportOutput,
  GetRecruiterProductivityReportOutput,
  GetPipelineReportOutput,
} from "@hireops/api-types";
import {
  Badge,
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
import { formatCostMicros } from "@/lib/approval-format";
import { buildCsv, downloadCsv } from "@/lib/csv";

/**
 * The /reports catalog (R0.2, filled out in R0.3) — every report on ONE
 * shared filter bar.
 *
 * The catalog's promise is that "requisitions in this period, in this BU,
 * for this recruiter" means the same thing in every section, because all
 * of them take the same `reportFiltersSchema` input and resolve it through
 * the one server-side semantic layer. Three reports ship on that bar:
 * requisition aging, recruiter productivity (R0.2) and pipeline & speed
 * (R0.3 — funnel, time to fill, time in stage, source mix, offers and the
 * live SLA-breach table, all off the R0.1 measures).
 *
 * GOVERNANCE is the deliberate exception. Its two sections reuse the
 * EXISTING admin procedures (getAiUsageSummary, listAuditEvents) rather
 * than rebuilding /admin/costs and /admin/audit here — they are catalog
 * entries with a drill-through, not replacements. Two consequences the UI
 * states out loud rather than papering over:
 *   - those procedures are admin-gated (USERS_ADMIN_ROLES), so hr_head and
 *     hr_ops simply do not see the sections;
 *   - they take no report filters, so the shared bar does NOT move them —
 *     each carries its own window label ("All time", "Last 30 days").
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
 *
 * DELIVERY (R0.4). Each filterable section carries a Download CSV button
 * that serialises the CURRENT query result client-side (`@/lib/csv`, the
 * audit console's helpers) — so the file is exactly the rows on screen,
 * cap included, and a filter change needs no new round trip.
 *
 * DRILL-DOWN links out only where a real surface exists AND the viewer can
 * open it. Two do: a requisition title → /requisitions/[id], and an SLA
 * stage → /triage?stage=<stage> (the triage feed's URL-backed stage
 * filter, `useFilterChips`). Both targets are gated to admin + hr_head,
 * NOT hr_ops — who can read this catalog — so the links render as plain
 * text for hr_ops rather than walking them into a role notice. The
 * recruiter column stays plain text throughout: no surface takes a
 * recruiter query-param filter, and inventing one is a later ticket.
 */

/** Age past which an OPEN requisition is worth chasing. */
const AGING_HIGHLIGHT_DAYS = 30;

export function ReportsHubClient({
  initialAging,
  initialProductivity,
  initialPipeline,
  isAdmin,
  canOpenRequisitionDetail,
  canOpenTriage,
}: {
  initialAging: GetRequisitionAgingReportOutput;
  initialProductivity: GetRecruiterProductivityReportOutput;
  initialPipeline: GetPipelineReportOutput;
  isAdmin: boolean;
  /** Viewer passes /requisitions/[id]'s own read gate — see the drill-down note. */
  canOpenRequisitionDetail: boolean;
  /** Viewer passes listCandidates' read gate, which /triage needs to render. */
  canOpenTriage: boolean;
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
  const pipelineQuery = trpc.getPipelineReport.useQuery(input, {
    initialData: isUnfiltered ? initialPipeline : undefined,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });

  // Governance (admin only) — deliberately OUTSIDE the shared filter bar;
  // see the file header. `enabled` gates the calls so non-admins never fire
  // an admin-gated procedure just to have it 403.
  const aiUsageQuery = trpc.getAiUsageSummary.useQuery(
    {},
    { enabled: isAdmin, refetchOnWindowFocus: false, staleTime: 30_000 },
  );
  const auditQuery = trpc.listAuditEvents.useQuery(
    { limit: 5 },
    { enabled: isAdmin, refetchOnWindowFocus: false, staleTime: 30_000 },
  );

  const aging = agingQuery.data ?? initialAging;
  const productivity = productivityQuery.data ?? initialProductivity;
  const pipeline = pipelineQuery.data ?? initialPipeline;
  const isFetching =
    agingQuery.isFetching || productivityQuery.isFetching || pipelineQuery.isFetching;

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
        actions={
          <DownloadCsvButton
            disabled={aging.rows.length === 0}
            onClick={() =>
              downloadCsv(`requisition-aging-${csvDateStamp()}.csv`, buildAgingCsv(aging))
            }
          />
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
                    <Td label="Requisition">
                      {canOpenRequisitionDetail ? (
                        <Link
                          href={`/requisitions/${r.requisitionId}`}
                          className="text-brand-700 hover:underline"
                        >
                          {r.title}
                        </Link>
                      ) : (
                        r.title
                      )}
                    </Td>
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
        actions={
          <DownloadCsvButton
            disabled={productivity.rows.length === 0}
            onClick={() =>
              downloadCsv(
                `recruiter-productivity-${csvDateStamp()}.csv`,
                buildProductivityCsv(productivity),
              )
            }
          />
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

      <ReportSection
        title="Pipeline & speed"
        blurb={
          <>
            The funnel, hiring speed and channel mix for applications raised in the period, plus the
            live SLA standing: a breach is an application still sitting in a thresholded stage past
            the tenant&apos;s limit — a snapshot of right now, not a history.
          </>
        }
        actions={
          <DownloadCsvButton
            onClick={() =>
              downloadCsv(`pipeline-speed-${csvDateStamp()}.csv`, buildPipelineCsv(pipeline))
            }
          />
        }
      >
        <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile
            label="Median days to hire"
            value={formatDays(pipeline.timeToFill.medianDays)}
            tone="accent"
          />
          <StatTile label="P90 days to hire" value={formatDays(pipeline.timeToFill.p90Days)} />
          <StatTile label="Hires" value={pipeline.timeToFill.hires.toLocaleString()} />
          <StatTile
            label="Offer acceptance"
            value={
              pipeline.offers.extended > 0
                ? `${Math.round((pipeline.offers.accepted / pipeline.offers.extended) * 100)}%`
                : "—"
            }
          />
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Funnel — where applications sit now
            </h3>
            <div className="flex flex-col gap-2">
              {(() => {
                const max = Math.max(1, ...pipeline.funnel.map((f) => f.count));
                return pipeline.funnel.map((f) => (
                  <DataBar
                    key={f.stage}
                    label={humanizeSentence(f.stage)}
                    labelClassName="w-40 text-neutral-700"
                    pct={(f.count / max) * 100}
                    value={f.count.toLocaleString()}
                  />
                ));
              })()}
            </div>
          </Card>

          <Card>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              SLA hot spots — in-stage past the threshold
            </h3>
            {pipeline.slaBreaches.length === 0 ? (
              <p className="text-sm text-neutral-500">No thresholded stages are configured.</p>
            ) : (
              <TableShell>
                <Thead>
                  <Th>Stage</Th>
                  <Th numeric>Threshold (h)</Th>
                  <Th numeric>In stage</Th>
                  <Th numeric>Breached</Th>
                </Thead>
                <Tbody>
                  {pipeline.slaBreaches.map((s) => (
                    <Tr key={s.stage}>
                      <Td label="Stage">
                        {canOpenTriage ? (
                          <Link
                            href={`/triage?stage=${s.stage}`}
                            className="text-brand-700 hover:underline"
                            title="Open the triage feed filtered to this stage"
                          >
                            {humanizeSentence(s.stage)}
                          </Link>
                        ) : (
                          humanizeSentence(s.stage)
                        )}
                      </Td>
                      <Td numeric label="Threshold (h)">
                        {s.thresholdHours.toLocaleString()}
                      </Td>
                      <Td numeric label="In stage">
                        {s.totalInStage.toLocaleString()}
                      </Td>
                      <Td numeric label="Breached">
                        {s.breachedCount > 0 ? (
                          <Badge tone="warning" pill>
                            {s.breachedCount.toLocaleString()}
                          </Badge>
                        ) : (
                          <span className="text-neutral-400">0</span>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </TableShell>
            )}
          </Card>

          <Card>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Time in stage — median days, completed visits
            </h3>
            <TableShell>
              <Thead>
                <Th>Stage</Th>
                <Th numeric>Median days</Th>
              </Thead>
              <Tbody>
                {pipeline.timeInStage
                  .filter((s) => s.medianDays !== null)
                  .map((s) => (
                    <Tr key={s.stage}>
                      <Td label="Stage">{humanizeSentence(s.stage)}</Td>
                      <Td numeric label="Median days">
                        {formatDays(s.medianDays)}
                      </Td>
                    </Tr>
                  ))}
              </Tbody>
            </TableShell>
            {pipeline.timeInStage.every((s) => s.medianDays === null) ? (
              <p className="mt-2 text-sm text-neutral-500">
                No completed stage visits in this range yet.
              </p>
            ) : null}
          </Card>

          <Card>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Source mix — volume and hires by channel
            </h3>
            {pipeline.sourceMix.length === 0 ? (
              <p className="text-sm text-neutral-500">No applications in this range.</p>
            ) : (
              <TableShell>
                <Thead>
                  <Th>Source</Th>
                  <Th numeric>Applications</Th>
                  <Th numeric>Hires</Th>
                </Thead>
                <Tbody>
                  {pipeline.sourceMix.map((s) => (
                    <Tr key={s.source}>
                      <Td label="Source">{humanizeSentence(s.source)}</Td>
                      <Td numeric label="Applications">
                        {s.applications.toLocaleString()}
                      </Td>
                      <Td numeric label="Hires">
                        {s.hires.toLocaleString()}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </TableShell>
            )}
            <p className="mt-3 text-xs text-neutral-500">
              Offers: {pipeline.offers.drafted.toLocaleString()} drafted ·{" "}
              {pipeline.offers.extended.toLocaleString()} extended ·{" "}
              {pipeline.offers.accepted.toLocaleString()} accepted ·{" "}
              {pipeline.offers.declined.toLocaleString()} declined
            </p>
          </Card>
        </div>
      </ReportSection>

      {isAdmin ? (
        <ReportSection
          title="Governance"
          blurb={
            <>
              Catalog entries for the compliance and AI-spend stories — drill through for the full
              consoles. These are admin-only and are <em>not</em> affected by the filters above.
            </>
          }
        >
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <div className="mb-3 flex items-baseline justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  AI usage &amp; cost
                </h3>
                <span className="text-xs text-neutral-400">All time</span>
              </div>
              {aiUsageQuery.data ? (
                <>
                  <div className="mb-3 grid grid-cols-3 gap-4">
                    <StatTile
                      label="Calls"
                      value={aiUsageQuery.data.totals.calls.toLocaleString()}
                    />
                    <StatTile
                      label="Spend"
                      value={formatCostMicros(aiUsageQuery.data.totals.cost_micros)}
                      tone="accent"
                    />
                    <StatTile
                      label="Failures"
                      value={aiUsageQuery.data.totals.failures.toLocaleString()}
                    />
                  </div>
                  <ul className="mb-3 flex flex-col gap-1">
                    {aiUsageQuery.data.byFeature.slice(0, 3).map((f) => (
                      <li key={f.feature} className="flex justify-between text-sm">
                        <span className="text-neutral-700">{humanizeSentence(f.feature)}</span>
                        <span className="tabular-nums text-neutral-500">
                          {formatCostMicros(f.cost_micros)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="mb-3 text-sm text-neutral-500">Loading usage…</p>
              )}
              <Link
                href="/admin/costs"
                className="text-sm font-medium text-brand-600 hover:underline"
              >
                Open AI costs →
              </Link>
            </Card>

            <Card>
              <div className="mb-3 flex items-baseline justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Compliance &amp; audit
                </h3>
                <span className="text-xs text-neutral-400">Most recent events</span>
              </div>
              {auditQuery.data ? (
                <ul className="mb-3 flex flex-col gap-1">
                  {auditQuery.data.items.map((e) => (
                    <li key={e.id} className="flex justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate text-neutral-700">
                        {humanizeSentence(e.entity_type)} · {e.action}
                      </span>
                      <span className="shrink-0 tabular-nums text-neutral-500">
                        {formatDate(e.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mb-3 text-sm text-neutral-500">Loading events…</p>
              )}
              <Link
                href="/admin/audit"
                className="text-sm font-medium text-brand-600 hover:underline"
              >
                Open audit console →
              </Link>
            </Card>
          </div>
        </ReportSection>
      ) : null}
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
  actions,
  children,
}: {
  title: string;
  blurb: ReactNode;
  /** Right-aligned header slot — the section's Download CSV button. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-10 last:mb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">{title}</h2>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      <p className="mb-3 mt-1 max-w-3xl text-xs text-neutral-500">{blurb}</p>
      {children}
    </section>
  );
}

/**
 * The section-header export control. Pill styling from `controlCls` (the
 * same language as the filter bar), and it exports the CURRENT filtered
 * data straight from the already-fetched query result — see `@/lib/csv`
 * for why there is no server round trip.
 */
function DownloadCsvButton({
  onClick,
  disabled,
  label = "Download CSV",
}: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${controlCls} font-medium hover:bg-neutral-50 disabled:cursor-not-allowed disabled:text-neutral-400 disabled:hover:bg-white`}
    >
      {label}
    </button>
  );
}

/** Today as YYYY-MM-DD in UTC — the axis the whole catalog reports on. */
function csvDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A nullable number for a CSV cell: null → empty, never "—". */
function csvNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

const AGING_CSV_HEADERS = [
  "title",
  "business_unit",
  "status",
  "recruiter",
  "openings",
  "raised_at",
  "days_open",
] as const;

/**
 * Exactly the rows on screen — so when the server capped the list, the
 * file is capped too and the on-screen note is the only place that says
 * so. Nothing is appended to the CSV.
 */
function buildAgingCsv(aging: GetRequisitionAgingReportOutput): string {
  return buildCsv(
    AGING_CSV_HEADERS,
    aging.rows.map((r) => [
      r.title,
      r.businessUnitName,
      r.status,
      r.recruiterName ?? "",
      String(r.openings),
      r.createdAt,
      String(r.daysOpen),
    ]),
  );
}

const PRODUCTIVITY_CSV_HEADERS = [
  "recruiter",
  "reqs_owned",
  "applications",
  "interviews_scheduled",
  "offers_extended",
  "hires",
] as const;

function buildProductivityCsv(productivity: GetRecruiterProductivityReportOutput): string {
  return buildCsv(
    PRODUCTIVITY_CSV_HEADERS,
    productivity.rows.map((r) => [
      r.recruiterName ?? "Unnamed recruiter",
      String(r.reqsOwned),
      String(r.applications),
      String(r.interviewsScheduled),
      String(r.offersExtended),
      String(r.hires),
    ]),
  );
}

const PIPELINE_CSV_HEADERS = ["section", "item", "metric", "value"] as const;

/**
 * ONE pipeline CSV rather than a button per card.
 *
 * The section renders six datasets (time to fill, funnel, SLA, time in
 * stage, source mix, offers) with incompatible column sets; six buttons
 * would swamp the header and picking two of the six would be arbitrary.
 * So it exports long-format — section, item, metric, value — which holds
 * all six losslessly, pivots in one step in a spreadsheet, and keeps the
 * catalog's "one export per section" rhythm. Nulls export as empty cells.
 */
function buildPipelineCsv(pipeline: GetPipelineReportOutput): string {
  const rows: string[][] = [
    ["time_to_fill", "", "median_days", csvNumber(pipeline.timeToFill.medianDays)],
    ["time_to_fill", "", "p90_days", csvNumber(pipeline.timeToFill.p90Days)],
    ["time_to_fill", "", "hires", String(pipeline.timeToFill.hires)],
  ];
  for (const f of pipeline.funnel) {
    rows.push(["funnel", f.stage, "applications_in_stage", String(f.count)]);
  }
  for (const s of pipeline.slaBreaches) {
    rows.push(["sla", s.stage, "threshold_hours", String(s.thresholdHours)]);
    rows.push(["sla", s.stage, "in_stage", String(s.totalInStage)]);
    rows.push(["sla", s.stage, "breached", String(s.breachedCount)]);
  }
  for (const s of pipeline.timeInStage) {
    rows.push(["time_in_stage", s.stage, "median_days", csvNumber(s.medianDays)]);
  }
  for (const s of pipeline.sourceMix) {
    rows.push(["source_mix", s.source, "applications", String(s.applications)]);
    rows.push(["source_mix", s.source, "hires", String(s.hires)]);
  }
  rows.push(["offers", "", "drafted", String(pipeline.offers.drafted)]);
  rows.push(["offers", "", "extended", String(pipeline.offers.extended)]);
  rows.push(["offers", "", "accepted", String(pipeline.offers.accepted)]);
  rows.push(["offers", "", "declined", String(pipeline.offers.declined)]);
  return buildCsv(PIPELINE_CSV_HEADERS, rows);
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
