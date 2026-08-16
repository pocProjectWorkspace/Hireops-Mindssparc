"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import type {
  GetRequisitionAgingReportOutput,
  GetRecruiterProductivityReportOutput,
  GetPipelineReportOutput,
  GetHeadcountVsPlanReportOutput,
  GetApprovalAnalyticsReportOutput,
  GetPartnerScorecardReportOutput,
  PartnerScorecardRow,
  GetInterviewHealthReportOutput,
  GetOnboardingReadinessReportOutput,
  OnboardingReadinessRow,
  GetExecutiveSummaryReportOutput,
  ExecutiveSummaryAgencyCost,
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
import { formatFeeMinor } from "@/lib/money";
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
 * THE SPONSOR PACK (R1.1) adds two more: headcount vs plan and the
 * approval cycle. Both honour a NARROWER slice of the shared bar than the
 * three above, and each says so on itself rather than quietly ignoring a
 * control the reader just moved:
 *   - headcount takes period + business unit. The period is an OVERLAP
 *     test on the envelope's own period, not a containment test, and the
 *     off-plan number is windowed on when the requisition was raised.
 *   - the approval cycle takes period only; an approval request points at
 *     an opaque subject id, so there is no business unit to filter on.
 * Neither takes the recruiter filter — a budget line and an approval
 * chain have no recruiter.
 *
 * THE PARTNER SCORECARD (R1.3) is the third: one row per agency, over the
 * period and business unit. It reads ONE window against three different
 * date columns, because its measures genuinely live on different clocks —
 * submissions on the application date, fees on the HIRE date, duplicate
 * blocks on the attempt date — and its two "right now" columns (assignments
 * and claims) take no window at all. The section blurb says so; the recruiter
 * filter does not apply to an agency.
 *
 * INTERVIEW & SCORECARD HEALTH and ONBOARDING READINESS (R1.2) close the
 * pack, and each moves the shared period onto its OWN clock — which is the
 * only way either question reads honestly:
 *   - interviews are windowed on when the round was DUE (scheduled_start), so
 *     "booked 40, ran 31, 6 cancelled" is one sentence about one population;
 *     the completion rate's denominator is resolved rounds only. The median
 *     hours to feedback rests on `interviews.completed_at`, which arrived in
 *     migration 0115 and was BACKFILLED for older rows — the section says so
 *     under the tiles rather than presenting an approximation as a fact.
 *   - onboarding is windowed on the EXPECTED START DATE ("who lands in this
 *     window"), and its day counter goes negative for a start date that has
 *     already passed with the case still open. Those rows are toned as
 *     warnings because they are the point of the report.
 * Neither takes the recruiter filter: an interview has a panel, and a hire in
 * onboarding has left the recruiter's desk.
 *
 * THE EXECUTIVE SUMMARY (R1.4) is pinned ABOVE all of them, because it is
 * the page a sponsor forwards upward and nobody scrolls to a summary. It
 * defines nothing: every tile is the number the section below it publishes
 * for the same filters, so the board pack cannot contradict its own detail.
 * Three things it says out loud rather than quietly rounding off:
 *   - AGENCY COST is agency cost, not cost per hire. Partner fees are the
 *     only hiring spend the platform captures — there is no ad/job-board
 *     spend and no internal recruiter cost — so the tile is labelled for
 *     what it is and the note says what a blended number would need.
 *   - DIVERSITY is not captured at all (no demographic fields; the capture
 *     decision is legal, not technical), so it prints as an explicit "not
 *     captured" line. A zero would be a lie and an omission would read as
 *     an oversight.
 *   - AI GOVERNANCE is admin-only, because `ai_usage_logs` is admin-only
 *     everywhere else; hr_head and hr_ops get the note, not the numbers.
 *
 * PRINT (R1.4). "Print / save as PDF" is `window.print()` against a print
 * stylesheet that reduces the page to the board pack: the exec summary
 * carries `data-print-region`, everything else on the page carries Tailwind
 * `print:hidden`, and globals.css un-clips the app shell (which is a fixed-
 * height, overflow-hidden frame — without that the printout stops at one
 * screen) and drops the chrome. A print-only header line names the active
 * filter window, so a forwarded PDF cannot be mistaken for all-time
 * numbers.
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
  initialExecSummary,
  initialAging,
  initialProductivity,
  initialPipeline,
  initialHeadcount,
  initialApprovals,
  initialPartners,
  initialInterviewHealth,
  initialOnboarding,
  isAdmin,
  canOpenRequisitionDetail,
  canOpenTriage,
}: {
  initialExecSummary: GetExecutiveSummaryReportOutput;
  initialAging: GetRequisitionAgingReportOutput;
  initialProductivity: GetRecruiterProductivityReportOutput;
  initialPipeline: GetPipelineReportOutput;
  initialHeadcount: GetHeadcountVsPlanReportOutput;
  initialApprovals: GetApprovalAnalyticsReportOutput;
  initialPartners: GetPartnerScorecardReportOutput;
  initialInterviewHealth: GetInterviewHealthReportOutput;
  initialOnboarding: GetOnboardingReadinessReportOutput;
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

  const execSummaryQuery = trpc.getExecutiveSummaryReport.useQuery(input, {
    initialData: isUnfiltered ? initialExecSummary : undefined,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
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
  const headcountQuery = trpc.getHeadcountVsPlanReport.useQuery(input, {
    initialData: isUnfiltered ? initialHeadcount : undefined,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
  const approvalsQuery = trpc.getApprovalAnalyticsReport.useQuery(input, {
    initialData: isUnfiltered ? initialApprovals : undefined,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
  const partnersQuery = trpc.getPartnerScorecardReport.useQuery(input, {
    initialData: isUnfiltered ? initialPartners : undefined,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
  const interviewHealthQuery = trpc.getInterviewHealthReport.useQuery(input, {
    initialData: isUnfiltered ? initialInterviewHealth : undefined,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
  const onboardingQuery = trpc.getOnboardingReadinessReport.useQuery(input, {
    initialData: isUnfiltered ? initialOnboarding : undefined,
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

  const execSummary = execSummaryQuery.data ?? initialExecSummary;
  const aging = agingQuery.data ?? initialAging;
  const productivity = productivityQuery.data ?? initialProductivity;
  const pipeline = pipelineQuery.data ?? initialPipeline;
  const headcount = headcountQuery.data ?? initialHeadcount;
  const approvals = approvalsQuery.data ?? initialApprovals;
  const partners = partnersQuery.data ?? initialPartners;
  const interviewHealth = interviewHealthQuery.data ?? initialInterviewHealth;
  const onboarding = onboardingQuery.data ?? initialOnboarding;
  const isFetching =
    execSummaryQuery.isFetching ||
    agingQuery.isFetching ||
    productivityQuery.isFetching ||
    pipelineQuery.isFetching ||
    headcountQuery.isFetching ||
    approvalsQuery.isFetching ||
    partnersQuery.isFetching ||
    interviewHealthQuery.isFetching ||
    onboardingQuery.isFetching;

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

  // Partner tiles are derived from the full (uncapped) row set — see the
  // server report for why there is no cap to invalidate them.
  const partnerTotals = useMemo(() => summarisePartners(partners.rows), [partners.rows]);

  const openCount = aging.byStatus
    .filter((s) => !TERMINAL_STATUSES.has(s.status))
    .reduce((sum, s) => sum + s.count, 0);
  const oldestOpen = aging.rows.find((r) => !r.isTerminal)?.daysOpen ?? null;

  return (
    <PageContainer>
      <p className="mb-4 max-w-3xl text-sm text-neutral-600 print:hidden">
        The reporting catalog — the executive summary and eight detail reports on one filter bar,
        from the requisitions being raised through to the hires being onboarded. Every one answers
        its question over the same period, business unit and recruiter: set them once in the filter
        bar and the whole page moves together. Where a report reads the period against a different
        clock — the hire date, the interview date, the expected start date — it says so on itself.
        Numbers come from live requisition, application, interview, offer and onboarding records; no
        snapshots or overnight rollups.
      </p>

      <section
        aria-label="Report filters"
        className="mb-8 flex flex-wrap items-center gap-2 rounded-card border border-neutral-200 bg-neutral-50/60 px-3 py-2.5 print:hidden"
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
        title="Executive summary"
        printRegion
        blurb={
          <>
            The board pack — hiring against plan, how fast we are filling roles, what the agencies
            cost, and what is running late, on one page. Every number here is the number the section
            below it publishes for the same filters; this summary computes none of its own. Read the
            period carefully: each measure reads it on its own clock — applications by when they
            arrived, the trend by when the hire landed, plans by the period they cover, agency fees
            by the hire date.
          </>
        }
        actions={
          <>
            <PrintButton />
            <DownloadCsvButton
              onClick={() =>
                downloadCsv(
                  `executive-summary-${csvDateStamp()}.csv`,
                  buildExecSummaryCsv(execSummary),
                )
              }
            />
          </>
        }
      >
        {/*
          Print-only provenance line. A forwarded PDF loses the filter bar,
          so the paper has to say which window it describes or it reads as
          all-time.
        */}
        <p className="mb-4 hidden text-xs text-neutral-600 print:block">
          HireOps board pack · {describeFilterWindow(from, to)} ·{" "}
          {businessUnitId
            ? (businessUnitOptions.find((b) => b.id === businessUnitId)?.name ??
              "Selected business unit")
            : "All business units"}
        </p>

        <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile
            label="Hires"
            value={execSummary.headline.hires.toLocaleString()}
            tone="accent"
          />
          <StatTile
            label="Applications"
            value={execSummary.headline.applications.toLocaleString()}
          />
          <StatTile
            label="Active pipeline"
            value={execSummary.headline.activePipeline.toLocaleString()}
          />
          <StatTile
            label="Offer acceptance"
            value={formatPct(execSummary.headline.offerAcceptanceRate)}
          />
          <StatTile
            label="Median days to hire"
            value={formatDays(execSummary.headline.medianTimeToFill)}
          />
          <StatTile
            label="Oldest open req (days)"
            value={formatDays(execSummary.headline.oldestOpenReqDays)}
          />
        </div>

        <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Hires vs plan
            </h3>
            <TableShell>
              <Thead>
                <Th>Measure</Th>
                <Th numeric>Count</Th>
              </Thead>
              <Tbody>
                <Tr>
                  <Td label="Measure">Planned headcount</Td>
                  <Td numeric label="Count">
                    {execSummary.hiresVsPlan.plannedHeadcount.toLocaleString()}
                  </Td>
                </Tr>
                <Tr>
                  <Td label="Measure">Openings requested</Td>
                  <Td numeric label="Count">
                    {execSummary.hiresVsPlan.openingsRequested.toLocaleString()}
                  </Td>
                </Tr>
                <Tr>
                  <Td label="Measure">Hires</Td>
                  <Td numeric label="Count">
                    {execSummary.hiresVsPlan.hires.toLocaleString()}
                  </Td>
                </Tr>
                <Tr>
                  <Td label="Measure">Off-plan requisitions</Td>
                  <Td numeric label="Count">
                    <span
                      className={
                        execSummary.hiresVsPlan.unplannedReqs > 0
                          ? "font-semibold text-status-warning-800"
                          : undefined
                      }
                    >
                      {execSummary.hiresVsPlan.unplannedReqs.toLocaleString()}
                    </span>
                  </Td>
                </Tr>
              </Tbody>
            </TableShell>
            <p className="mt-2 text-xs text-neutral-500">
              Openings requested against approved envelopes whose period touches the window;
              off-plan counts requisitions raised in the window against no envelope at all.
            </p>
          </Card>

          <Card>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Time to fill — median days, by hire month
            </h3>
            {execSummary.timeToFillTrend.length === 0 ? (
              <p className="text-sm text-neutral-500">No months in range.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {(() => {
                  const max = Math.max(
                    1,
                    ...execSummary.timeToFillTrend.map((p) => p.medianDays ?? 0),
                  );
                  return execSummary.timeToFillTrend.map((p) => (
                    <DataBar
                      key={p.month}
                      label={p.month}
                      monoLabel
                      labelClassName="w-16 font-mono text-neutral-600"
                      pct={((p.medianDays ?? 0) / max) * 100}
                      meta={`${p.hires.toLocaleString()} ${p.hires === 1 ? "hire" : "hires"}`}
                      value={formatDays(p.medianDays)}
                    />
                  ));
                })()}
              </div>
            )}
            <p className="mt-3 text-xs text-neutral-500">
              Bucketed by the month the hire <em>landed</em>, not the month the application arrived
              — so this line and the median above answer different questions and will not tie out. A
              month with no hires shows no median rather than a zero.
            </p>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Agency cost
            </h3>
            <div className="grid grid-cols-3 gap-4">
              <StatTile label="Agency spend" value={formatAgencyMoney(execSummary.agencyCost)} />
              <StatTile
                label="Fee-bearing hires"
                value={execSummary.agencyCost.agencyHires.toLocaleString()}
              />
              <StatTile
                label="Per agency hire"
                value={formatAgencyCostPerHire(execSummary.agencyCost)}
              />
            </div>
            <p className="mt-3 text-xs text-neutral-500">
              This is <strong>agency cost, not cost per hire</strong>. Partner fees are the only
              hiring spend HireOps captures: accrued, payable and paid fees (disputed excluded),
              counted in the month of the hire. A blended cost per hire also needs job-board and
              advertising spend and an internal recruiter cost model — neither is captured by the
              platform today, so neither is guessed at here.
            </p>
          </Card>

          <Card>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Pipeline health
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <StatTile
                label="SLA breaches"
                value={execSummary.pipelineHealth.totalSlaBreaches.toLocaleString()}
                tone={execSummary.pipelineHealth.totalSlaBreaches > 0 ? "warning" : "neutral"}
                hint={`across ${execSummary.pipelineHealth.breachedStages.toLocaleString()} ${
                  execSummary.pipelineHealth.breachedStages === 1 ? "stage" : "stages"
                }`}
              />
              <StatTile
                label="Interview completion"
                value={formatPct(execSummary.pipelineHealth.interviewCompletionRate)}
                hint={`${execSummary.pipelineHealth.interviewsCompleted.toLocaleString()} completed`}
              />
            </div>
            <p className="mt-3 text-xs text-neutral-500">
              A breach is an application sitting in a thresholded stage past the tenant&apos;s limit
              right now — a live snapshot, not a history. Interview completion counts rounds that
              resolved: still-scheduled rounds are not misses and stay out of the denominator.
            </p>
          </Card>
        </div>

        <div className="mt-6 rounded-card border border-neutral-200 bg-neutral-50/60 px-4 py-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Governance &amp; data gaps
          </h3>
          <p className="text-xs text-neutral-600">
            <span className="font-medium text-neutral-700">AI governance:</span>{" "}
            {execSummary.aiGovernance ? (
              <>
                {execSummary.aiGovernance.calls.toLocaleString()} model{" "}
                {execSummary.aiGovernance.calls === 1 ? "call" : "calls"} ·{" "}
                {formatCostMicros(execSummary.aiGovernance.costMicros)} spent ·{" "}
                {execSummary.aiGovernance.failures.toLocaleString()} failed. Every call is logged
                with its feature, model and cost.
              </>
            ) : (
              <>
                admin-only. The AI cost ledger is restricted to administrators, so it is not shown
                on this pack for your role.
              </>
            )}
          </p>
          <p className="mt-1.5 text-xs text-neutral-600">
            <span className="font-medium text-neutral-700">Diversity:</span> not captured. HireOps
            holds no demographic data — collecting it is a consent and legal decision that has not
            been taken, so there is nothing to report and nothing has been estimated. The reporting
            is designed for it and switches on when you ask.
          </p>
        </div>
      </ReportSection>

      <ReportSection
        title="Requisition status & aging"
        printHidden
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
        printHidden
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
        printHidden
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

      <ReportSection
        title="Headcount vs plan"
        printHidden
        blurb={
          <>
            Approved headcount envelopes against the hiring actually raised inside them. An envelope
            counts every requisition pointing at it, over the envelope&apos;s whole period — so
            utilisation is the plan&apos;s story, not the window&apos;s. The period bounds which
            envelopes appear (any envelope whose period overlaps it) and the business unit narrows
            them; the recruiter filter does not apply to a budget line.
          </>
        }
        actions={
          <DownloadCsvButton
            disabled={headcount.envelopes.length === 0 && headcount.unplanned.reqsRaised === 0}
            onClick={() =>
              downloadCsv(`headcount-vs-plan-${csvDateStamp()}.csv`, buildHeadcountCsv(headcount))
            }
          />
        }
      >
        {headcount.envelopes.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title={
                isUnfiltered
                  ? "No headcount envelopes yet"
                  : "No headcount envelopes overlap this period"
              }
              hint="An envelope is an approved budget for one business unit over one period. Requisitions raised without one appear below."
            />
          </Card>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile
                label="Planned headcount"
                value={headcount.totals.plannedHeadcount.toLocaleString()}
                tone="accent"
              />
              <StatTile
                label="Openings requested"
                value={headcount.totals.openingsRequested.toLocaleString()}
              />
              <StatTile label="Hires" value={headcount.totals.hires.toLocaleString()} />
              <StatTile
                label="Off-plan requisitions"
                value={headcount.unplanned.reqsRaised.toLocaleString()}
              />
            </div>

            <TableShell>
              <Thead>
                <Th>Business unit</Th>
                <Th>Period</Th>
                <Th>Status</Th>
                <Th numeric>Planned</Th>
                <Th numeric>Requested</Th>
                <Th numeric>Utilisation</Th>
                <Th numeric>Hires</Th>
              </Thead>
              <Tbody>
                {headcount.envelopes.map((e) => (
                  <Tr key={e.envelopeId}>
                    <Td label="Business unit">{e.businessUnitName}</Td>
                    <Td label="Period">{formatPeriod(e.periodStart, e.periodEnd)}</Td>
                    <Td label="Status">
                      <Badge tone={envelopeStatusTone(e.status)} pill>
                        {humanizeSentence(e.status)}
                      </Badge>
                    </Td>
                    <Td numeric label="Planned">
                      {e.plannedHeadcount.toLocaleString()}
                    </Td>
                    <Td numeric label="Requested">
                      {e.openingsRequested.toLocaleString()}
                    </Td>
                    <Td numeric label="Utilisation">
                      <span
                        className={
                          e.utilisationPct !== null && e.utilisationPct > 100
                            ? "font-semibold text-status-warning-800"
                            : undefined
                        }
                      >
                        {formatPct(e.utilisationPct)}
                      </span>
                    </Td>
                    <Td numeric label="Hires">
                      {e.hires.toLocaleString()}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </TableShell>
          </>
        )}

        <p className="mt-3 text-xs text-neutral-500">
          {headcount.unplanned.reqsRaised === 0 ? (
            <>Every requisition raised in this period sits against an approved envelope.</>
          ) : (
            <>
              <span className="font-medium text-status-warning-800">
                Off plan: {headcount.unplanned.reqsRaised.toLocaleString()}{" "}
                {headcount.unplanned.reqsRaised === 1 ? "requisition" : "requisitions"} (
                {headcount.unplanned.openingsRequested.toLocaleString()}{" "}
                {headcount.unplanned.openingsRequested === 1 ? "opening" : "openings"})
              </span>{" "}
              raised in this period against no envelope at all. These are counted by when they were
              raised, not by an envelope period, and are not in the table above.
            </>
          )}
        </p>
      </ReportSection>

      <ReportSection
        title="Approval cycle"
        printHidden
        blurb={
          <>
            How long approvals take and where they stall. A request counts as decided whenever it
            reached a terminal state — approved, rejected, cancelled or expired. An approver&apos;s
            clock starts at the end of the previous step, not when the request was raised, so nobody
            carries the queue ahead of them. The period bounds when the request was raised; business
            unit and recruiter do not apply.
          </>
        }
        actions={
          <DownloadCsvButton
            disabled={approvalTotal(approvals) === 0}
            onClick={() =>
              downloadCsv(`approval-cycle-${csvDateStamp()}.csv`, buildApprovalCsv(approvals))
            }
          />
        }
      >
        {approvalTotal(approvals) === 0 ? (
          <Card padded={false}>
            <EmptyState
              title={
                isUnfiltered ? "No approval requests yet" : "No approval requests in this period"
              }
              hint="Requests appear here as soon as a headcount envelope, requisition, JD or offer enters an approval chain."
            />
          </Card>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile
                label="Median hours to decide"
                value={formatHours(approvals.turnaround.medianHours)}
                tone="accent"
              />
              <StatTile label="P90 hours" value={formatHours(approvals.turnaround.p90Hours)} />
              <StatTile
                label="Pending"
                value={approvals.turnaround.pendingCount.toLocaleString()}
              />
              <StatTile
                label="Oldest pending (h)"
                value={formatHours(approvals.turnaround.oldestPendingHours)}
              />
            </div>

            <div className="mb-4 flex flex-wrap gap-2">
              {approvals.byStatus.map((s) => (
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
                </span>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Slowest approvers — median hours per decision
                </h3>
                {approvals.bottleneckApprovers.length === 0 ? (
                  <p className="text-sm text-neutral-500">
                    No decisions have been recorded against these requests yet.
                  </p>
                ) : (
                  <TableShell>
                    <Thead>
                      <Th>Approver</Th>
                      <Th numeric>Decisions</Th>
                      <Th numeric>Median hours</Th>
                    </Thead>
                    <Tbody>
                      {approvals.bottleneckApprovers.map((a) => (
                        <Tr key={a.approverMembershipId}>
                          <Td label="Approver">{a.approverName ?? "Unnamed approver"}</Td>
                          <Td numeric label="Decisions">
                            {a.decisions.toLocaleString()}
                          </Td>
                          <Td numeric label="Median hours">
                            {formatHours(a.medianHours)}
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </TableShell>
                )}
                <p className="mt-2 text-xs text-neutral-500">
                  Ten slowest at most. External approvers have no membership to attribute and are
                  not listed.
                </p>
              </Card>

              <Card>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  By subject — what goes through approval
                </h3>
                <TableShell>
                  <Thead>
                    <Th>Subject</Th>
                    <Th numeric>Requests</Th>
                    <Th numeric>Median hours</Th>
                  </Thead>
                  <Tbody>
                    {approvals.bySubjectType.map((s) => (
                      <Tr key={s.subjectType}>
                        <Td label="Subject">{humanizeSentence(s.subjectType)}</Td>
                        <Td numeric label="Requests">
                          {s.requests.toLocaleString()}
                        </Td>
                        <Td numeric label="Median hours">
                          {formatHours(s.medianHours)}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </TableShell>
                <p className="mt-2 text-xs text-neutral-500">
                  End to end, request raised → decided. Pending requests count in the volume but not
                  in the median.
                </p>
              </Card>
            </div>
          </>
        )}
      </ReportSection>

      <ReportSection
        title="Partner scorecard"
        printHidden
        blurb={
          <>
            Every partner agency: what it holds right now, what it delivered in the period, and what
            that cost. The period bounds submissions, both rates and time-to-submit by when the
            candidate was submitted, and fees by the <em>hire</em> date — a fee belongs to the month
            the hire happened, not the month the CV arrived. Assignments and claims are live counts
            and ignore the period entirely. Shortlist rate counts anyone who ever reached
            shortlisted or beyond, so a good candidate later rejected still counts for the partner
            who found them. The recruiter filter does not apply to an agency.
          </>
        }
        actions={
          <DownloadCsvButton
            disabled={partners.rows.length === 0}
            onClick={() =>
              downloadCsv(`partner-scorecard-${csvDateStamp()}.csv`, buildPartnerCsv(partners))
            }
          />
        }
      >
        {partners.rows.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title="No partner activity"
              hint="Partners appear once they submit. Empanel an agency and assign it a requisition to start the clock."
            />
          </Card>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile
                label="Partners with activity"
                value={partnerTotals.active.toLocaleString()}
                tone="accent"
              />
              <StatTile label="Submissions" value={partnerTotals.submissions.toLocaleString()} />
              <StatTile label="Hires" value={partnerTotals.hires.toLocaleString()} />
              <StatTile label="Fees accrued" value={partnerTotals.fees} />
            </div>

            <TableShell>
              <Thead>
                <Th>Partner</Th>
                <Th>Tier</Th>
                <Th numeric>Assignments</Th>
                <Th numeric>Submissions</Th>
                <Th numeric>Shortlisted</Th>
                <Th numeric>Hires</Th>
                <Th numeric>Hire rate</Th>
                <Th numeric>Dup-blocked</Th>
                <Th numeric>Days to submit</Th>
                <Th numeric>Fees accrued</Th>
              </Thead>
              <Tbody>
                {partners.rows.map((r) => (
                  <Tr key={r.partnerOrgId}>
                    <Td label="Partner">
                      <span className={r.active ? undefined : "text-neutral-500"}>{r.orgName}</span>
                      {r.active ? null : (
                        <span className="ml-2 text-xs text-neutral-400">suspended</span>
                      )}
                    </Td>
                    <Td label="Tier">
                      <Badge tone={r.tier === "empanelled" ? "info" : "neutral"} pill>
                        {humanizeSentence(r.tier)}
                      </Badge>
                    </Td>
                    <Td numeric label="Assignments">
                      {r.activeAssignments.toLocaleString()}
                    </Td>
                    <Td numeric label="Submissions">
                      {r.submissions.toLocaleString()}
                    </Td>
                    <Td numeric label="Shortlisted">
                      {formatPct(r.shortlistRate)}
                    </Td>
                    <Td numeric label="Hires">
                      {r.hires.toLocaleString()}
                    </Td>
                    <Td numeric label="Hire rate">
                      {formatPct(r.hireRate)}
                    </Td>
                    <Td numeric label="Dup-blocked">
                      {r.duplicateBlocked > 0 ? (
                        <Badge tone="warning" pill>
                          {r.duplicateBlocked.toLocaleString()}
                        </Badge>
                      ) : (
                        <span className="text-neutral-400">0</span>
                      )}
                    </Td>
                    <Td numeric label="Days to submit">
                      {formatDays(r.medianDaysToSubmit)}
                    </Td>
                    <Td numeric label="Fees accrued">
                      {formatPartnerFees(r)}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </TableShell>
            <p className="mt-2 text-xs text-neutral-500">
              Dup-blocked counts submissions the platform refused because another partner already
              owned the candidate — read it next to submissions, not on its own. Fees exclude
              disputed rows, matching the commercials ledger. Active partners always appear, at
              zeros if that is the truth.
            </p>
          </>
        )}
      </ReportSection>

      <ReportSection
        title="Interview & scorecard health"
        printHidden
        blurb={
          <>
            Whether the interviews we book actually run, and whether the panel ever writes them up.
            The period bounds when a round was <em>due</em> — its scheduled start — so the counts
            below all describe the same set of interviews. The completion rate is measured against
            rounds that <em>resolved</em>: a round still on the calendar is not a miss and is left
            out of the denominator. Business unit and requisition narrow the set through the
            interview&apos;s own requisition; the recruiter filter does not apply to a panel.
          </>
        }
        actions={
          <DownloadCsvButton
            disabled={interviewHealth.totals.total === 0}
            onClick={() =>
              downloadCsv(
                `interview-health-${csvDateStamp()}.csv`,
                buildInterviewHealthCsv(interviewHealth),
              )
            }
          />
        }
      >
        {interviewHealth.totals.total === 0 ? (
          <Card padded={false}>
            <EmptyState
              title={isUnfiltered ? "No interviews yet" : "No interviews scheduled in this period"}
              hint="Interviews appear here as soon as a round is booked against a requisition."
            />
          </Card>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile
                label="Interviews scheduled"
                value={interviewHealth.totals.total.toLocaleString()}
                tone="accent"
              />
              <StatTile
                label="Completed"
                value={interviewHealth.totals.completed.toLocaleString()}
              />
              <StatTile
                label="Completion rate"
                value={formatPct(interviewHealth.totals.completionRate)}
              />
              <StatTile
                label="Median hours to feedback"
                value={formatHours(interviewHealth.totals.medianHoursToFeedback)}
              />
            </div>

            <p className="mb-4 text-xs text-neutral-500">
              {interviewHealth.totals.scheduled.toLocaleString()} still scheduled ·{" "}
              {interviewHealth.totals.cancelled.toLocaleString()} cancelled ·{" "}
              {interviewHealth.totals.noShow.toLocaleString()} no-show. The feedback median is taken
              over {interviewHealth.totals.feedbackPairs.toLocaleString()} submitted{" "}
              {interviewHealth.totals.feedbackPairs === 1 ? "scorecard" : "scorecards"}, timed from
              the moment the interview was marked complete — interviews completed before that
              timestamp existed carry a backfilled value, so older periods are an approximation.
            </p>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Scorecard coverage — completed interviews
                </h3>
                {interviewHealth.scorecardCompletion.expectedScorecards === 0 ? (
                  <p className="text-sm text-neutral-500">
                    No completed interview in this period had a panel to write it up.
                  </p>
                ) : (
                  <>
                    <DataBar
                      label="Submitted"
                      labelClassName="w-24 text-neutral-700"
                      pct={interviewHealth.scorecardCompletion.completionRate ?? 0}
                      value={`${interviewHealth.scorecardCompletion.submittedScorecards.toLocaleString()} / ${interviewHealth.scorecardCompletion.expectedScorecards.toLocaleString()}`}
                    />
                    <p className="mt-2 text-xs text-neutral-500">
                      {formatPct(interviewHealth.scorecardCompletion.completionRate)} of the
                      scorecards expected across{" "}
                      {interviewHealth.scorecardCompletion.interviewsCompleted.toLocaleString()}{" "}
                      completed{" "}
                      {interviewHealth.scorecardCompletion.interviewsCompleted === 1
                        ? "interview"
                        : "interviews"}
                      . One is expected per panelist; a saved draft does not count as submitted.
                    </p>
                  </>
                )}

                {interviewHealth.scorecardCompletion.laggards.length > 0 ? (
                  <div className="mt-4">
                    <TableShell>
                      <Thead>
                        <Th>Panelist</Th>
                        <Th numeric>Outstanding</Th>
                      </Thead>
                      <Tbody>
                        {interviewHealth.scorecardCompletion.laggards.map((l) => (
                          <Tr key={l.membershipId}>
                            <Td label="Panelist">{l.panelistName ?? "Unnamed panelist"}</Td>
                            <Td numeric label="Outstanding">
                              <Badge tone="warning" pill>
                                {l.outstanding.toLocaleString()}
                              </Badge>
                            </Td>
                          </Tr>
                        ))}
                      </Tbody>
                    </TableShell>
                    <p className="mt-2 text-xs text-neutral-500">
                      Ten at most, worst first — panelists on a completed interview who have
                      submitted nothing for it.
                    </p>
                  </div>
                ) : null}
              </Card>

              <Card>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  By round — volume and write-up speed
                </h3>
                <TableShell>
                  <Thead>
                    <Th>Round</Th>
                    <Th numeric>Total</Th>
                    <Th numeric>Completed</Th>
                    <Th numeric>Cancelled</Th>
                    <Th numeric>No-show</Th>
                    <Th numeric>Median hours</Th>
                  </Thead>
                  <Tbody>
                    {interviewHealth.byRound.map((r) => (
                      <Tr key={r.roundName}>
                        <Td label="Round">{r.roundName}</Td>
                        <Td numeric label="Total">
                          {r.total.toLocaleString()}
                        </Td>
                        <Td numeric label="Completed">
                          {r.completed.toLocaleString()}
                        </Td>
                        <Td numeric label="Cancelled">
                          {r.cancelled.toLocaleString()}
                        </Td>
                        <Td numeric label="No-show">
                          {r.noShow > 0 ? (
                            <Badge tone="warning" pill>
                              {r.noShow.toLocaleString()}
                            </Badge>
                          ) : (
                            <span className="text-neutral-400">0</span>
                          )}
                        </Td>
                        <Td numeric label="Median hours">
                          {formatHours(r.medianHoursToFeedback)}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </TableShell>
                <p className="mt-2 text-xs text-neutral-500">
                  Round names come from the interview plan, so they are whatever your plans call
                  them — a renamed round starts its own row rather than merging with its history.
                </p>
              </Card>
            </div>
          </>
        )}
      </ReportSection>

      <ReportSection
        title="Onboarding readiness"
        printHidden
        blurb={
          <>
            The hires that have been made but not yet landed. The period bounds the{" "}
            <em>expected start date</em> — who arrives in this window, not whose paperwork opened in
            it — and the business unit narrows through the requisition they were hired against. Days
            counts down to the start date and goes negative once it has passed with the case still
            open; those rows are flagged. Only active cases are listed; completed and cancelled ones
            still count in the mix below.
          </>
        }
        actions={
          <DownloadCsvButton
            disabled={onboarding.rows.length === 0}
            onClick={() =>
              downloadCsv(
                `onboarding-readiness-${csvDateStamp()}.csv`,
                buildOnboardingCsv(onboarding),
              )
            }
          />
        }
      >
        {onboarding.rollups.activeCases === 0 ? (
          <Card padded={false}>
            <EmptyState
              title={isUnfiltered ? "No onboarding in flight" : "No hires start in this period"}
              hint="A case opens automatically when a candidate accepts their offer."
            />
          </Card>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile
                label="Starting within 14 days"
                value={onboarding.rollups.startingWithin14Days.toLocaleString()}
                tone="accent"
              />
              <StatTile
                label="Cases with overdue tasks"
                value={onboarding.rollups.casesWithOverdueTasks.toLocaleString()}
              />
              <StatTile
                label="BGV in flight"
                value={onboarding.rollups.bgvInProgress.toLocaleString()}
              />
              <StatTile
                label="Start date passed"
                value={onboarding.rollups.overdueStart.toLocaleString()}
              />
            </div>

            <div className="mb-4 flex flex-wrap gap-2">
              {onboarding.byStatus.map((s) => (
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
                </span>
              ))}
            </div>

            <TableShell>
              <Thead>
                <Th>Candidate</Th>
                <Th>Status</Th>
                <Th numeric>Starts</Th>
                <Th numeric>Days</Th>
                <Th numeric>Tasks</Th>
                <Th numeric>Documents</Th>
                <Th>BGV</Th>
                <Th numeric>IT</Th>
              </Thead>
              <Tbody>
                {onboarding.rows.map((r) => (
                  <Tr key={r.caseId}>
                    <Td label="Candidate">{r.candidateName ?? "Unnamed candidate"}</Td>
                    <Td label="Status">
                      <Badge tone={onboardingStatusTone(r.status)} pill>
                        {humanizeSentence(r.status)}
                      </Badge>
                    </Td>
                    <Td numeric label="Starts">
                      {r.expectedStartDate ? formatDay(r.expectedStartDate) : "—"}
                    </Td>
                    <Td numeric label="Days">
                      <span
                        className={
                          isOnboardingLate(r) ? "font-semibold text-status-warning-800" : undefined
                        }
                      >
                        {formatDaysToStart(r.daysToStart)}
                      </span>
                    </Td>
                    <Td numeric label="Tasks">
                      <span
                        className={
                          r.overdueTasks > 0 ? "font-semibold text-status-warning-800" : undefined
                        }
                      >
                        {formatRatio(r.tasksDone, r.tasksTotal)}
                      </span>
                    </Td>
                    <Td numeric label="Documents">
                      {formatRatio(r.docsVerified, r.docsTotal)}
                    </Td>
                    <Td label="BGV">
                      {r.bgvStatus ? (
                        <Badge tone={bgvTone(r.bgvStatus)} pill>
                          {humanizeSentence(r.bgvStatus)}
                        </Badge>
                      ) : (
                        <span className="text-neutral-400">Not started</span>
                      )}
                    </Td>
                    <Td numeric label="IT">
                      {formatRatio(r.itProvisioned, r.itTotal)}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </TableShell>
            <p className="mt-2 text-xs text-neutral-500">
              {onboarding.truncated ? (
                <>
                  Showing the {onboarding.rows.length.toLocaleString()} soonest starts. The tiles
                  above still count every active case in range.{" "}
                </>
              ) : null}
              Tasks and IT count work that is still owed — cancelled and skipped items are out of
              both denominators. Documents count what has been uploaded, not what the hire&apos;s
              geography requires, so an empty case reads 0 / 0. BGV shows the latest run.
            </p>
          </>
        )}
      </ReportSection>

      {isAdmin ? (
        <ReportSection
          title="Governance"
          printHidden
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
  printHidden = false,
  printRegion = false,
  children,
}: {
  title: string;
  blurb: ReactNode;
  /** Right-aligned header slot — the section's Download CSV button. */
  actions?: ReactNode;
  /** Off the printed page: everything except the board pack (R1.4). */
  printHidden?: boolean;
  /**
   * THE printed page. `data-print-region` is what globals.css's print block
   * keys off to un-clip the app shell around this section; exactly one
   * section on the page may carry it.
   */
  printRegion?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={printHidden ? "mb-10 last:mb-0 print:hidden" : "mb-10 last:mb-0"}
      {...(printRegion ? { "data-print-region": "board-pack" } : {})}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">{title}</h2>
        {/* Controls are screen furniture — they must not print. */}
        {actions ? <div className="flex shrink-0 gap-2 print:hidden">{actions}</div> : null}
      </div>
      <p className="mb-3 mt-1 max-w-3xl text-xs text-neutral-500">{blurb}</p>
      {children}
    </section>
  );
}

/**
 * "Print / save as PDF" — `window.print()` against the print stylesheet in
 * globals.css, which reduces the page to the section carrying
 * `data-print-region`. No PDF library: the browser's own print-to-PDF is
 * the deliberate choice (reporting build plan §2.4 defers server-side PDF
 * generation), and it keeps the pack in the reader's own paper size.
 */
function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={`${controlCls} font-medium hover:bg-neutral-50`}
    >
      Print / save as PDF
    </button>
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

const EXEC_SUMMARY_CSV_HEADERS = ["section", "item", "metric", "value"] as const;

/**
 * LONG format — section, item, metric, value — for the same reason the
 * pipeline and approval exports use it, only more so: the board pack is
 * seven datasets with nothing in common but the filter window.
 *
 * Two things ride along that the screen renders as prose, because a
 * spreadsheet must not silently drop them: the diversity placeholder
 * (`available = false`) and the AI-governance block's absence for a
 * non-admin reader (`visibility = admin_only`). Money exports in MINOR
 * units with its currency in its own row — a number the sheet can sum.
 */
function buildExecSummaryCsv(summary: GetExecutiveSummaryReportOutput): string {
  const rows: string[][] = [
    ["headline", "", "hires", String(summary.headline.hires)],
    ["headline", "", "applications", String(summary.headline.applications)],
    ["headline", "", "active_pipeline", String(summary.headline.activePipeline)],
    ["headline", "", "offer_acceptance_rate_pct", csvNumber(summary.headline.offerAcceptanceRate)],
    ["headline", "", "median_time_to_fill_days", csvNumber(summary.headline.medianTimeToFill)],
    ["headline", "", "oldest_open_req_days", csvNumber(summary.headline.oldestOpenReqDays)],
    ["hires_vs_plan", "", "planned_headcount", String(summary.hiresVsPlan.plannedHeadcount)],
    ["hires_vs_plan", "", "openings_requested", String(summary.hiresVsPlan.openingsRequested)],
    ["hires_vs_plan", "", "hires", String(summary.hiresVsPlan.hires)],
    ["hires_vs_plan", "", "unplanned_reqs", String(summary.hiresVsPlan.unplannedReqs)],
  ];
  for (const p of summary.timeToFillTrend) {
    rows.push(["time_to_fill_trend", p.month, "median_days", csvNumber(p.medianDays)]);
    rows.push(["time_to_fill_trend", p.month, "hires", String(p.hires)]);
  }
  rows.push(["agency_cost", "", "agency_spend_minor", summary.agencyCost.agencySpendMinor]);
  rows.push(["agency_cost", "", "currency", summary.agencyCost.currency ?? ""]);
  rows.push(["agency_cost", "", "agency_hires", String(summary.agencyCost.agencyHires)]);
  rows.push([
    "agency_cost",
    "",
    "cost_per_agency_hire_minor",
    summary.agencyCost.costPerAgencyHireMinor ?? "",
  ]);
  rows.push([
    "pipeline_health",
    "",
    "sla_breaches",
    String(summary.pipelineHealth.totalSlaBreaches),
  ]);
  rows.push([
    "pipeline_health",
    "",
    "breached_stages",
    String(summary.pipelineHealth.breachedStages),
  ]);
  rows.push([
    "pipeline_health",
    "",
    "interviews_completed",
    String(summary.pipelineHealth.interviewsCompleted),
  ]);
  rows.push([
    "pipeline_health",
    "",
    "interview_completion_rate_pct",
    csvNumber(summary.pipelineHealth.interviewCompletionRate),
  ]);
  if (summary.aiGovernance) {
    rows.push(["ai_governance", "", "calls", String(summary.aiGovernance.calls)]);
    rows.push(["ai_governance", "", "cost_micros", summary.aiGovernance.costMicros]);
    rows.push(["ai_governance", "", "failures", String(summary.aiGovernance.failures)]);
  } else {
    rows.push(["ai_governance", "", "visibility", "admin_only"]);
  }
  rows.push(["diversity", "", "available", String(summary.diversity.available)]);
  rows.push(["diversity", "", "reason", summary.diversity.reason]);
  return buildCsv(EXEC_SUMMARY_CSV_HEADERS, rows);
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

const HEADCOUNT_CSV_HEADERS = [
  "row_type",
  "business_unit",
  "period_start",
  "period_end",
  "status",
  "planned_headcount",
  "reqs_raised",
  "openings_requested",
  "utilisation_pct",
  "hires",
] as const;

/**
 * One row per envelope plus a FINAL `unplanned` row, rather than a second
 * button for two numbers. The leading `row_type` column says which is
 * which, so a filter on it recovers either half; the unplanned row leaves
 * the plan-shaped cells (period, status, planned, utilisation, hires)
 * empty because it has no envelope to describe — an empty cell is honest
 * where a zero would read as "planned nothing, hired nobody".
 */
function buildHeadcountCsv(headcount: GetHeadcountVsPlanReportOutput): string {
  const rows: string[][] = headcount.envelopes.map((e) => [
    "envelope",
    e.businessUnitName,
    e.periodStart,
    e.periodEnd,
    e.status,
    String(e.plannedHeadcount),
    String(e.reqsRaised),
    String(e.openingsRequested),
    csvNumber(e.utilisationPct),
    String(e.hires),
  ]);
  rows.push([
    "unplanned",
    "",
    "",
    "",
    "",
    "",
    String(headcount.unplanned.reqsRaised),
    String(headcount.unplanned.openingsRequested),
    "",
    "",
  ]);
  return buildCsv(HEADCOUNT_CSV_HEADERS, rows);
}

const APPROVAL_CSV_HEADERS = ["section", "item", "metric", "value"] as const;

/**
 * Long format — section, item, metric, value — for the same reason the
 * pipeline export uses it: four datasets (turnaround, status mix,
 * approvers, subject types) with incompatible column sets, one button.
 * Nulls export as empty cells.
 */
function buildApprovalCsv(approvals: GetApprovalAnalyticsReportOutput): string {
  const rows: string[][] = [
    ["turnaround", "", "median_hours", csvNumber(approvals.turnaround.medianHours)],
    ["turnaround", "", "p90_hours", csvNumber(approvals.turnaround.p90Hours)],
    ["turnaround", "", "decided_requests", String(approvals.turnaround.decidedCount)],
    ["turnaround", "", "pending_requests", String(approvals.turnaround.pendingCount)],
    ["turnaround", "", "oldest_pending_hours", csvNumber(approvals.turnaround.oldestPendingHours)],
  ];
  for (const s of approvals.byStatus) {
    rows.push(["by_status", s.status, "requests", String(s.count)]);
  }
  for (const a of approvals.bottleneckApprovers) {
    const who = a.approverName ?? a.approverMembershipId;
    rows.push(["approvers", who, "decisions", String(a.decisions)]);
    rows.push(["approvers", who, "median_hours", String(a.medianHours)]);
  }
  for (const s of approvals.bySubjectType) {
    rows.push(["by_subject_type", s.subjectType, "requests", String(s.requests)]);
    rows.push(["by_subject_type", s.subjectType, "median_hours", csvNumber(s.medianHours)]);
  }
  return buildCsv(APPROVAL_CSV_HEADERS, rows);
}

const PARTNER_CSV_HEADERS = [
  "partner",
  "tier",
  "active",
  "active_assignments",
  "submissions",
  "shortlist_rate_pct",
  "hires",
  "hire_rate_pct",
  "duplicate_blocked",
  "active_claims",
  "median_days_to_submit",
  "fees_accrued_minor",
  "fees_currency",
] as const;

/**
 * WIDE format — one row per agency — unlike the pipeline and approval
 * exports. The scorecard is already one rectangular table on screen, so a
 * long-format export would be strictly worse to read and to pivot.
 *
 * `fees_accrued_minor` exports the raw MINOR units, not the formatted
 * string: a spreadsheet should get a number it can sum, and the currency
 * travels in its own column. `active_claims` is exported even though the
 * table has no room for it — the file is the place for the column that
 * didn't fit.
 */
function buildPartnerCsv(partners: GetPartnerScorecardReportOutput): string {
  return buildCsv(
    PARTNER_CSV_HEADERS,
    partners.rows.map((r) => [
      r.orgName,
      r.tier,
      String(r.active),
      String(r.activeAssignments),
      String(r.submissions),
      csvNumber(r.shortlistRate),
      String(r.hires),
      csvNumber(r.hireRate),
      String(r.duplicateBlocked),
      String(r.activeClaims),
      csvNumber(r.medianDaysToSubmit),
      r.feesAccruedMinor,
      r.feesCurrency ?? "",
    ]),
  );
}

const INTERVIEW_HEALTH_CSV_HEADERS = ["section", "item", "metric", "value"] as const;

/**
 * LONG format — section, item, metric, value — for the same reason the
 * pipeline and approval exports use it: three datasets (the funnel totals,
 * the scorecard laggards, the per-round table) with incompatible column
 * sets, one button. Nulls export as empty cells.
 */
function buildInterviewHealthCsv(health: GetInterviewHealthReportOutput): string {
  const rows: string[][] = [
    ["totals", "", "scheduled", String(health.totals.scheduled)],
    ["totals", "", "completed", String(health.totals.completed)],
    ["totals", "", "cancelled", String(health.totals.cancelled)],
    ["totals", "", "no_show", String(health.totals.noShow)],
    ["totals", "", "total", String(health.totals.total)],
    ["totals", "", "completion_rate_pct", csvNumber(health.totals.completionRate)],
    ["totals", "", "median_hours_to_feedback", csvNumber(health.totals.medianHoursToFeedback)],
    ["totals", "", "feedback_pairs", String(health.totals.feedbackPairs)],
    [
      "scorecards",
      "",
      "interviews_completed",
      String(health.scorecardCompletion.interviewsCompleted),
    ],
    ["scorecards", "", "expected", String(health.scorecardCompletion.expectedScorecards)],
    ["scorecards", "", "submitted", String(health.scorecardCompletion.submittedScorecards)],
    ["scorecards", "", "completion_rate_pct", csvNumber(health.scorecardCompletion.completionRate)],
  ];
  for (const l of health.scorecardCompletion.laggards) {
    // The membership id is the fallback label — a null display name must not
    // collapse two different panelists onto one CSV row.
    rows.push(["laggards", l.panelistName ?? l.membershipId, "outstanding", String(l.outstanding)]);
  }
  for (const r of health.byRound) {
    rows.push(["by_round", r.roundName, "total", String(r.total)]);
    rows.push(["by_round", r.roundName, "scheduled", String(r.scheduled)]);
    rows.push(["by_round", r.roundName, "completed", String(r.completed)]);
    rows.push(["by_round", r.roundName, "cancelled", String(r.cancelled)]);
    rows.push(["by_round", r.roundName, "no_show", String(r.noShow)]);
    rows.push([
      "by_round",
      r.roundName,
      "median_hours_to_feedback",
      csvNumber(r.medianHoursToFeedback),
    ]);
  }
  return buildCsv(INTERVIEW_HEALTH_CSV_HEADERS, rows);
}

const ONBOARDING_CSV_HEADERS = [
  "candidate",
  "case_id",
  "status",
  "expected_start_date",
  "days_to_start",
  "tasks_done",
  "tasks_total",
  "overdue_tasks",
  "docs_verified",
  "docs_total",
  "bgv_status",
  "it_provisioned",
  "it_total",
] as const;

/**
 * WIDE format — one row per case — like the partner scorecard and unlike the
 * two long-format exports: the section is already one rectangular table, so
 * long format would be strictly worse to read and to pivot.
 *
 * `case_id` rides along even though the table has no column for it: it is
 * the only stable key for a case, and two hires can share a name. Exactly
 * the rows on screen, cap included — the on-screen note is the only place
 * that says the list was capped.
 */
function buildOnboardingCsv(onboarding: GetOnboardingReadinessReportOutput): string {
  return buildCsv(
    ONBOARDING_CSV_HEADERS,
    onboarding.rows.map((r) => [
      r.candidateName ?? "",
      r.caseId,
      r.status,
      r.expectedStartDate ?? "",
      csvNumber(r.daysToStart),
      String(r.tasksDone),
      String(r.tasksTotal),
      String(r.overdueTasks),
      String(r.docsVerified),
      String(r.docsTotal),
      r.bgvStatus ?? "",
      String(r.itProvisioned),
      String(r.itTotal),
    ]),
  );
}

/**
 * The board pack's period, in words, for the print-only header line. The
 * bounds are the raw `<input type="date">` values — whole UTC days, which
 * is exactly how the server reads them.
 */
function describeFilterWindow(from: string, to: string): string {
  if (!from && !to) return "All time";
  if (from && to) return `${formatDay(from)} – ${formatDay(to)}`;
  if (from) return `From ${formatDay(from)}`;
  return `Up to ${formatDay(to)}`;
}

/**
 * Total agency spend. A null currency means nothing accrued in range, which
 * reads as an em dash rather than a "₹0.00" that implies free hiring;
 * "MIXED" is the server's flag for a tenant whose fees span currencies,
 * where a single formatted total would be a lie.
 */
function formatAgencyMoney(cost: ExecutiveSummaryAgencyCost): string {
  if (!cost.currency) return "—";
  if (cost.currency === "MIXED") return "Mixed";
  return formatFeeMinor(Number(cost.agencySpendMinor), cost.currency);
}

/** Spend per fee-bearing agency hire; null (no such hire) reads as an em dash. */
function formatAgencyCostPerHire(cost: ExecutiveSummaryAgencyCost): string {
  if (cost.costPerAgencyHireMinor === null || !cost.currency) return "—";
  if (cost.currency === "MIXED") return "Mixed";
  return formatFeeMinor(Number(cost.costPerAgencyHireMinor), cost.currency);
}

/**
 * One agency's accrued fees. `feesCurrency` is null exactly when nothing
 * accrued in range, which reads as an em dash rather than a misleading
 * "₹0.00" against a partner that simply has no hires yet.
 */
function formatPartnerFees(row: PartnerScorecardRow): string {
  if (!row.feesCurrency) return "—";
  return formatFeeMinor(Number(row.feesAccruedMinor), row.feesCurrency);
}

/**
 * The four scorecard tiles, rolled up over the full row set.
 *
 * "Partners with activity" counts agencies that did SOMETHING in range —
 * submitted, had a submission blocked, or accrued a fee. It deliberately
 * excludes an active agency sitting at zeros, which is the whole reason
 * that row is still on screen.
 *
 * The fee total is summed PER CURRENCY. One currency per org is the POC's
 * commercial reality (a fee inherits it from the org's MSA), so in practice
 * there is one bucket; if a tenant ever mixes them the tile says "Mixed"
 * rather than adding rupees to dollars.
 */
function summarisePartners(rows: readonly PartnerScorecardRow[]): {
  active: number;
  submissions: number;
  hires: number;
  fees: string;
} {
  let active = 0;
  let submissions = 0;
  let hires = 0;
  const byCurrency = new Map<string, number>();

  for (const r of rows) {
    const accrued = Number(r.feesAccruedMinor);
    if (r.submissions > 0 || r.duplicateBlocked > 0 || accrued > 0) active += 1;
    submissions += r.submissions;
    hires += r.hires;
    if (r.feesCurrency && accrued > 0) {
      byCurrency.set(r.feesCurrency, (byCurrency.get(r.feesCurrency) ?? 0) + accrued);
    }
  }

  let fees = "—";
  if (byCurrency.size > 1) {
    fees = "Mixed";
  } else {
    // Runs exactly once when there is a single currency, never when empty.
    for (const [currency, total] of byCurrency) fees = formatFeeMinor(total, currency);
  }

  return { active, submissions, hires, fees };
}

/** Requests in range across every status — the section's "is there anything here". */
function approvalTotal(approvals: GetApprovalAnalyticsReportOutput): number {
  return approvals.byStatus.reduce((sum, s) => sum + s.count, 0);
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

/** null → "—"; otherwise a 1-decimal hour count (approvals run in hours). */
function formatHours(hours: number | null): string {
  if (hours === null) return "—";
  return hours.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/**
 * A readiness pair as "3 / 5". An empty denominator reads "—" rather than
 * "0 / 0": nothing has been raised, which is not the same as nothing done.
 */
function formatRatio(done: number, total: number): string {
  if (total === 0) return "—";
  return `${done.toLocaleString()} / ${total.toLocaleString()}`;
}

/**
 * The countdown to a start date. Negative is the interesting case — the day
 * has come and gone with the case still open — so it reads "12 late" rather
 * than "-12", which a reader can mistake for a formatting bug.
 */
function formatDaysToStart(days: number | null): string {
  if (days === null) return "—";
  if (days < 0) return `${Math.abs(days).toLocaleString()} late`;
  if (days === 0) return "today";
  return days.toLocaleString();
}

/** A case whose start date has passed while it is still open — the warning tone. */
function isOnboardingLate(row: OnboardingReadinessRow): boolean {
  return row.daysToStart !== null && row.daysToStart < 0;
}

/** Onboarding case status → badge tone. Five values (CHECK constraint). */
function onboardingStatusTone(
  status: string,
): "neutral" | "info" | "success" | "warning" | "error" {
  switch (status) {
    case "completed":
      return "success";
    case "in_progress":
    case "day_zero":
      return "info";
    case "cancelled":
      return "error";
    default:
      return "neutral";
  }
}

/**
 * Latest BGV run status → badge tone. `failed` is an error the People Ops
 * lead has to act on; a finished check is a success; everything else is
 * simply in flight.
 */
function bgvTone(status: string): "neutral" | "info" | "success" | "warning" | "error" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "neutral";
    default:
      return "info";
  }
}

/** null → "—"; otherwise a 1-decimal percentage, e.g. "112.5%". */
function formatPct(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

/**
 * An envelope period. These are `date` columns — plain calendar days —
 * so they are formatted from their parts rather than parsed as instants
 * and shifted by the reader's timezone.
 */
function formatPeriod(periodStart: string, periodEnd: string): string {
  return `${formatDay(periodStart)} – ${formatDay(periodEnd)}`;
}

function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Envelope status → badge tone. Only three values exist (CHECK constraint). */
function envelopeStatusTone(status: string): "neutral" | "info" | "success" | "warning" | "error" {
  switch (status) {
    case "approved":
      return "success";
    case "closed":
      return "neutral";
    default:
      return "warning";
  }
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
