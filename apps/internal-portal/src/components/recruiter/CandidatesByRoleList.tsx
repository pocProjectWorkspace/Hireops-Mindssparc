"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BULK_MOVE_MAX,
  NEXT_PIPELINE_STAGE,
  type ListCandidatesByRequisitionInput,
  type ListCandidatesByRequisitionOutput,
  type ApplicationStage,
  type ApplicationSource,
  type BulkMoveApplicationsOutput,
  type CandidateListFilter,
  type CandidateListSort,
  type IrisProvenanceRow,
  type KnockoutFilter,
} from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { AiAssistedPill, useProvenanceMap } from "@/components/iris/AiAssistedPill";
import { useDrawerRouting } from "@/lib/use-drawer-routing";
import { useUndoToast } from "@/components/triage/UndoToastProvider";
import { ScreeningChips } from "@/components/triage/ScreeningChips";
import { DiverseSlateBadge, DiverseSlateMoveHint } from "@/components/diversity/DiverseSlateBadge";
import {
  Avatar,
  Badge,
  EmptyState,
  cn,
  TableShell,
  Thead,
  Th,
  Tbody,
  Tr,
  Td,
} from "@/components/ui";
import { ChevronRightIcon } from "@/components/patterns/icons";
import { PageContainer } from "@/components/nav/PageContainer";
import { useScreeningScoreVisible } from "@/components/ScreeningScoreProvider";
import { BulkActionsBar, skipReasonLabel, type BulkSelection } from "./BulkActionsBar";
import { ListPager } from "./ListPager";
import {
  MatchTierChip,
  MissingInfoCell,
  PhaseChip,
  ScoreValue,
  StageBadge,
  sourceLabel,
  stageLabel,
  isTerminalStage,
} from "./recruiter-chips";

type Output = ListCandidatesByRequisitionOutput;
type RawGroup = Output["groups"][number];
type RawRow = RawGroup["rows"][number];
// z.unknown() infers as a REQUIRED key in the schema type but an OPTIONAL key
// in the tRPC query result — loosen to match what useQuery actually hands us
// (same workaround the triage TriageCard uses for aiScoreExplanation).
type Row = Omit<RawRow, "aiScoreExplanation"> & { aiScoreExplanation?: unknown };
type Group = Omit<RawGroup, "rows"> & { rows: Row[] };

/**
 * RECR-02 — the recruiter's "All candidates" surface, grouped into one
 * accordion per requisition (a genuine new surface: there was no grouped
 * candidates table before). Columns: Candidate · Stage · AI Score · Source ·
 * Missing Info · Actions. Everything is REAL, deterministic data — the AI score
 * is applications.ai_score (unscored says so honestly); Missing Info is a
 * deterministic count of absent required fields.
 *
 * Row actions: open the existing triage CandidateDetailDrawer (via ?candidateId
 * / ?applicationId), advance to the next pipeline stage, or reject. The drawer +
 * UndoToastProvider are mounted by the page.
 *
 * PC-5 — triage at volume: server-side paging ("Showing 51–100 of 412"), SQL
 * fact filters (knockout, notice ≤ N, expected CTC ≤ X for pay-visible roles,
 * location, partner, role), sort, and checkbox bulk actions (advance / move /
 * reject with a closing-email preview) via ONE bulkMoveApplications mutation.
 * "Select all N matching" sends the filter, not ids — the server re-resolves it.
 */

// Forward pipeline order for the "advance" action — the next legal stage
// (shared with the server's bulk advance so both agree).
const FORWARD_NEXT = NEXT_PIPELINE_STAGE;

const PAGE_SIZES = [50, 100, 200];
const DEFAULT_PAGE_SIZE = 50;
const LAKH_PAISE = 100_000 * 100;

const STAGE_OPTIONS: ApplicationStage[] = [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
];

const SOURCE_OPTIONS: ApplicationSource[] = [
  "career_site",
  "referral",
  "partner_empanelled",
  "partner_adhoc",
  "job_board",
  "agency_search",
  "talent_pool",
  "whatsapp",
];

function RowActions({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const utils = trpc.useUtils();
  const { show } = useUndoToast();

  const invalidate = () => {
    utils.listCandidatesByRequisition.invalidate();
    utils.listShortlist.invalidate();
    utils.listCandidates.invalidate();
  };

  const candidateName = row.fullName ?? row.refCode;
  const advance = trpc.advanceApplication.useMutation({
    onSuccess: (res) => {
      invalidate();
      show({
        message: `Advanced to ${stageLabel(res.toStage)}`,
        applicationId: res.applicationId,
        transitionId: res.transitionId,
        candidateName,
      });
    },
  });
  const reject = trpc.rejectApplication.useMutation({
    onSuccess: (res) => {
      invalidate();
      show({
        message: "Candidate rejected",
        applicationId: res.applicationId,
        transitionId: res.transitionId,
        candidateName,
      });
    },
  });

  const next = FORWARD_NEXT[row.stage];
  const terminal = isTerminalStage(row.stage);
  const busy = advance.isPending || reject.isPending;

  return (
    <div className="flex items-center justify-end gap-1">
      <DiverseSlateMoveHint applicationId={row.applicationId} nextStage={next} />
      <button
        type="button"
        onClick={onOpen}
        className="rounded-button px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
        title="Open candidate detail"
      >
        View
      </button>
      <button
        type="button"
        disabled={!next || terminal || busy}
        onClick={() =>
          next && advance.mutate({ applicationId: row.applicationId, targetStage: next })
        }
        className="rounded-button px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:text-neutral-300 disabled:hover:bg-transparent"
        title={next ? `Advance to ${stageLabel(next)}` : "No further stage"}
      >
        Advance
      </button>
      <button
        type="button"
        disabled={terminal || busy}
        onClick={() => reject.mutate({ applicationId: row.applicationId })}
        className="rounded-button px-2 py-1 text-xs font-medium text-status-error-700 hover:bg-status-error-50 disabled:cursor-not-allowed disabled:text-neutral-300 disabled:hover:bg-transparent"
        title="Reject candidate"
      >
        Reject
      </button>
    </div>
  );
}

function GroupAccordion({
  group,
  open,
  onToggle,
  onOpenRow,
  selectedCandidateId,
  sourceLabels,
  provenanceByApplicationId,
  isChecked,
  onCheck,
  checkDisabled,
}: {
  group: Group;
  open: boolean;
  onToggle: () => void;
  onOpenRow: (ids: { candidateId: string; applicationId: string }) => void;
  selectedCandidateId: string | null;
  sourceLabels?: Record<string, string>;
  provenanceByApplicationId: Map<string, IrisProvenanceRow>;
  isChecked: (applicationId: string) => boolean;
  onCheck: (applicationId: string, checked: boolean) => void;
  /** "All matching" mode: every row is selected; per-row boxes are locked. */
  checkDisabled: boolean;
}) {
  const scoreVisible = useScreeningScoreVisible();
  return (
    <div className="overflow-hidden rounded-card border border-neutral-200 bg-white shadow-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-neutral-50"
      >
        <ChevronRightIcon
          className={cn(
            "h-4 w-4 shrink-0 text-neutral-400 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="text-base font-semibold text-neutral-900">{group.roleTitle}</span>
        <Badge tone="neutral" pill>
          {group.candidateCount} {group.candidateCount === 1 ? "candidate" : "candidates"}
        </Badge>
        {group.rows.length < group.candidateCount ? (
          <span className="text-xs text-neutral-500 tabular-nums">
            {group.rows.length} on this page
          </span>
        ) : null}
        <PhaseChip phase={group.phase} />
        <DiverseSlateBadge requisitionId={group.requisitionId} />
      </button>

      {open ? (
        <TableShell className="border-t border-neutral-100">
          <Thead>
            <Th className="w-10">
              <span className="sr-only">Select</span>
            </Th>
            <Th>Candidate</Th>
            <Th>Stage</Th>
            {scoreVisible ? <Th>AI Score</Th> : null}
            <Th>Source</Th>
            <Th>Missing Info</Th>
            <Th numeric>Actions</Th>
          </Thead>
          <Tbody>
            {group.rows.map((row) => {
              const name = row.fullName ?? "(no name on file)";
              const selected = selectedCandidateId === row.candidateId;
              return (
                <Tr key={row.applicationId} className={cn(selected && "bg-brand-50")}>
                  <Td className="w-10">
                    <input
                      type="checkbox"
                      aria-label={`Select ${name}`}
                      checked={isChecked(row.applicationId)}
                      disabled={checkDisabled}
                      onChange={(e) => onCheck(row.applicationId, e.target.checked)}
                      className="h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
                    />
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={name} seed={row.candidateId} size="sm" />
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <p className="truncate font-medium text-neutral-900">{name}</p>
                          <AiAssistedPill row={provenanceByApplicationId.get(row.applicationId)} />
                        </div>
                        <p className="truncate text-xs text-neutral-500 tabular-nums">
                          {row.refCode}
                          {row.yearsOfExperience != null ? ` · ${row.yearsOfExperience} yrs` : ""}
                        </p>
                        {/* PC-7 — screening answers + knockout verdict. */}
                        <div className="mt-1">
                          <ScreeningChips screening={row.screening} knockout={row.knockout} />
                        </div>
                      </div>
                    </div>
                  </Td>
                  <Td label="Stage">
                    <StageBadge stage={row.stage} />
                  </Td>
                  {scoreVisible ? (
                    <Td label="AI Score">
                      <div className="flex items-center gap-2">
                        <ScoreValue score={row.aiScore} />
                        {row.aiScore != null
                          ? (() => {
                              const tier =
                                row.aiScore >= 90
                                  ? "excellent"
                                  : row.aiScore >= 75
                                    ? "good"
                                    : row.aiScore >= 60
                                      ? "partial"
                                      : "below";
                              return tier !== "below" ? <MatchTierChip tier={tier} /> : null;
                            })()
                          : null}
                      </div>
                    </Td>
                  ) : null}
                  <Td label="Source" className="text-neutral-700">
                    {sourceLabel(row.source, sourceLabels, row.partnerOrgName)}
                  </Td>
                  <Td label="Missing Info">
                    <MissingInfoCell info={row.missingInfo} />
                  </Td>
                  <Td label="Actions">
                    <RowActions
                      row={row}
                      onOpen={() =>
                        onOpenRow({
                          candidateId: row.candidateId,
                          applicationId: row.applicationId,
                        })
                      }
                    />
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </TableShell>
      ) : null}
    </div>
  );
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Parse a non-negative number input; blank / invalid → undefined. */
function numOrUndef(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const selectClass =
  "h-10 rounded-button border border-neutral-300 bg-white px-3 text-sm text-neutral-700 focus:border-brand-500 focus:outline-none";
const inputClass =
  "h-10 rounded-button border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none";

export function CandidatesByRoleList({
  initial,
  sourceLabels,
  enabledSources,
}: {
  initial: Output;
  sourceLabels?: Record<string, string>;
  enabledSources?: string[];
}) {
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<ApplicationStage | "">("");
  const [source, setSource] = useState<ApplicationSource | "">("");
  const [requisitionId, setRequisitionId] = useState("");
  const [knockout, setKnockout] = useState<KnockoutFilter | "">("");
  const [maxNotice, setMaxNotice] = useState("");
  const [maxCtcLakh, setMaxCtcLakh] = useState("");
  const [location, setLocation] = useState("");
  const [partner, setPartner] = useState<"" | "yes" | "no">("");
  const [sort, setSort] = useState<CandidateListSort>("ai_score");
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_PAGE_SIZE);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  // Selection: explicit ids on the current page, or "all N matching".
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [lastResult, setLastResult] = useState<BulkMoveApplicationsOutput | null>(null);
  const { open, candidateId } = useDrawerRouting();

  const dSearch = useDebounced(search.trim());
  const dLocation = useDebounced(location.trim());
  const dNotice = useDebounced(maxNotice);
  const dCtc = useDebounced(maxCtcLakh);

  // The filter the server applies — also the bulk "all matching" selection.
  const filter = useMemo<CandidateListFilter>(() => {
    const notice = numOrUndef(dNotice);
    const ctcLakh = numOrUndef(dCtc);
    return {
      ...(dSearch ? { search: dSearch } : {}),
      ...(stage ? { stage } : {}),
      ...(source ? { source } : {}),
      ...(requisitionId ? { requisitionId } : {}),
      ...(knockout ? { knockout } : {}),
      ...(notice !== undefined ? { maxNoticeDays: Math.min(365, Math.round(notice)) } : {}),
      ...(ctcLakh !== undefined
        ? { maxExpectedSalaryInrPaise: Math.round(ctcLakh * LAKH_PAISE) }
        : {}),
      ...(dLocation ? { locationContains: dLocation } : {}),
      ...(partner ? { hasPartner: partner === "yes" } : {}),
    };
  }, [dSearch, stage, source, requisitionId, knockout, dNotice, dCtc, dLocation, partner]);
  const filterKey = JSON.stringify(filter);

  // Any filter / sort / page-size change → back to page 1, selection cleared.
  useEffect(() => {
    setOffset(0);
  }, [filterKey, sort, limit]);
  useEffect(() => {
    setChecked(new Set());
    setAllMatching(false);
  }, [filterKey, sort, limit, offset]);

  const input: ListCandidatesByRequisitionInput = {
    ...filter,
    ...(sort !== "ai_score" ? { sort } : {}),
    ...(offset !== 0 || limit !== DEFAULT_PAGE_SIZE ? { page: { offset, limit } } : {}),
  };
  const isDefault =
    Object.keys(filter).length === 0 &&
    sort === "ai_score" &&
    offset === 0 &&
    limit === DEFAULT_PAGE_SIZE;
  const query = trpc.listCandidatesByRequisition.useQuery(input, {
    initialData: isDefault ? initial : undefined,
    placeholderData: (prev) => prev,
  });

  const data = query.data ?? initial;
  const groups = data.groups;
  const total = data.page?.total ?? data.totalCandidates;
  const pageRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const compFilterAvailable = data.compFilterAvailable ?? false;

  // AI-assisted pill: batch-fetch Iris provenance for every application on the
  // page (one query), so a row advanced/rejected/onboarded THROUGH Iris shows
  // the pill. Rows changed via the inline row actions (the human path) carry no
  // provenance and stay unmarked — the honest persisted-and-consumed flip.
  const applicationIds = useMemo(() => pageRows.map((r) => r.applicationId), [pageRows]);
  const provenanceByApplicationId = useProvenanceMap("application", applicationIds);

  // Every group on the page open by default once a single role is picked;
  // otherwise the first group. User toggles override.
  const isOpen = useMemo(
    () => (id: string, index: number) => openGroups[id] ?? (index === 0 || !!requisitionId),
    [openGroups, requisitionId],
  );

  // Constrain the source filter to the tenant's enabled channels when the
  // registry (G04) provides them; otherwise fall back to the full enum.
  const sourceOptions = useMemo(
    () =>
      enabledSources && enabledSources.length > 0
        ? SOURCE_OPTIONS.filter((s) => enabledSources.includes(s))
        : SOURCE_OPTIONS,
    [enabledSources],
  );

  const pageAllChecked =
    allMatching || (pageRows.length > 0 && pageRows.every((r) => checked.has(r.applicationId)));
  const selectionCount = allMatching ? total : checked.size;
  const selection: BulkSelection | null = allMatching
    ? { mode: "filter", filter }
    : checked.size > 0
      ? { mode: "ids", applicationIds: [...checked] }
      : null;
  // The reject preview names the role when the selection is exactly one role.
  let previewRequisitionId: string | null = null;
  if (allMatching) {
    const only = data.requisitionFacets?.length === 1 ? data.requisitionFacets[0] : undefined;
    previewRequisitionId = requisitionId || only?.requisitionId || null;
  } else {
    const reqs = groups.filter((g) => g.rows.some((r) => checked.has(r.applicationId)));
    previewRequisitionId = reqs.length === 1 ? (reqs[0]?.requisitionId ?? null) : null;
  }

  const nameById = useMemo(
    () => new Map(pageRows.map((r) => [r.applicationId, r.fullName ?? r.refCode])),
    [pageRows],
  );
  const anyFilter =
    search !== "" ||
    stage !== "" ||
    source !== "" ||
    requisitionId !== "" ||
    knockout !== "" ||
    maxNotice !== "" ||
    maxCtcLakh !== "" ||
    location !== "" ||
    partner !== "";
  const clearFilters = () => {
    setSearch("");
    setStage("");
    setSource("");
    setRequisitionId("");
    setKnockout("");
    setMaxNotice("");
    setMaxCtcLakh("");
    setLocation("");
    setPartner("");
  };

  return (
    <PageContainer>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-neutral-900">
          All candidates
          <Badge tone="neutral" pill>
            {total}
          </Badge>
        </h2>
        <label className="ml-auto flex items-center gap-2 text-sm text-neutral-600">
          Sort
          <select
            aria-label="Sort candidates"
            value={sort}
            onChange={(e) => setSort(e.target.value as CandidateListSort)}
            className={selectClass}
          >
            <option value="ai_score">AI score (highest first)</option>
            <option value="newest">Newest first</option>
          </select>
        </label>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or ID…"
          aria-label="Search by name or ID"
          className={cn(inputClass, "min-w-64 flex-1")}
        />
        <select
          aria-label="Filter by role"
          value={requisitionId}
          onChange={(e) => setRequisitionId(e.target.value)}
          className={selectClass}
        >
          <option value="">All roles</option>
          {(data.requisitionFacets ?? []).map((f) => (
            <option key={f.requisitionId} value={f.requisitionId}>
              {f.roleTitle} ({f.count})
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by stage"
          value={stage}
          onChange={(e) => setStage(e.target.value as ApplicationStage | "")}
          className={selectClass}
        >
          <option value="">All stages</option>
          {STAGE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {stageLabel(s)}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by source"
          value={source}
          onChange={(e) => setSource(e.target.value as ApplicationSource | "")}
          className={selectClass}
        >
          <option value="">All sources</option>
          {sourceOptions.map((s) => (
            <option key={s} value={s}>
              {sourceLabel(s, sourceLabels)}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <select
          aria-label="Filter by knockout result"
          value={knockout}
          onChange={(e) => setKnockout(e.target.value as KnockoutFilter | "")}
          className={selectClass}
        >
          <option value="">Any knockout result</option>
          <option value="pass">Knockouts passed</option>
          <option value="fail">Knockouts failed</option>
          <option value="unknown">Knockouts unknown</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-neutral-600">
          Notice ≤
          <input
            type="number"
            min={0}
            max={365}
            inputMode="numeric"
            value={maxNotice}
            onChange={(e) => setMaxNotice(e.target.value)}
            placeholder="days"
            aria-label="Maximum notice period in days"
            className={cn(inputClass, "w-24")}
          />
        </label>
        {compFilterAvailable ? (
          <label className="flex items-center gap-2 text-sm text-neutral-600">
            Expected CTC ≤ ₹
            <input
              type="number"
              min={0}
              step="0.5"
              inputMode="decimal"
              value={maxCtcLakh}
              onChange={(e) => setMaxCtcLakh(e.target.value)}
              placeholder="lakh"
              aria-label="Maximum expected CTC in lakh rupees per year"
              className={cn(inputClass, "w-24")}
            />
            L
          </label>
        ) : null}
        <input
          type="search"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Location contains…"
          aria-label="Current location contains"
          className={cn(inputClass, "w-48")}
        />
        <select
          aria-label="Filter by partner"
          value={partner}
          onChange={(e) => setPartner(e.target.value as "" | "yes" | "no")}
          className={selectClass}
        >
          <option value="">Partner or direct</option>
          <option value="yes">Partner-sourced</option>
          <option value="no">Direct only</option>
        </select>
        {anyFilter ? (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-button px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {lastResult ? (
        <BulkResultBanner
          result={lastResult}
          nameById={nameById}
          onDismiss={() => setLastResult(null)}
        />
      ) : null}

      {selection ? (
        <BulkActionsBar
          selection={selection}
          count={selectionCount}
          previewRequisitionId={previewRequisitionId}
          onDone={(res) => {
            setLastResult(res);
            setChecked(new Set());
            setAllMatching(false);
          }}
          onClear={() => {
            setChecked(new Set());
            setAllMatching(false);
          }}
        />
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={pageAllChecked}
            disabled={pageRows.length === 0 || allMatching}
            onChange={(e) => {
              const next = new Set(checked);
              for (const r of pageRows) {
                if (e.target.checked) next.add(r.applicationId);
                else next.delete(r.applicationId);
              }
              setChecked(next);
            }}
            className="h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
          />
          Select all on this page
        </label>
        {pageAllChecked && !allMatching && total > pageRows.length ? (
          <button
            type="button"
            onClick={() => setAllMatching(true)}
            disabled={total > BULK_MOVE_MAX}
            title={
              total > BULK_MOVE_MAX
                ? `Bulk actions are limited to ${BULK_MOVE_MAX}; narrow the filters`
                : undefined
            }
            className="text-sm font-medium text-brand-700 hover:underline disabled:cursor-not-allowed disabled:text-neutral-400 disabled:no-underline"
          >
            Select all {total.toLocaleString("en-IN")} matching
          </button>
        ) : null}
        {allMatching ? (
          <span className="text-sm text-neutral-700">
            All {total.toLocaleString("en-IN")} matching candidates are selected.{" "}
            <button
              type="button"
              onClick={() => setAllMatching(false)}
              className="font-medium text-brand-700 hover:underline"
            >
              Undo
            </button>
          </span>
        ) : null}
        <ListPager
          className="ml-auto"
          offset={offset}
          limit={limit}
          shown={pageRows.length}
          total={total}
          onOffsetChange={setOffset}
          pageSizes={PAGE_SIZES}
          onLimitChange={setLimit}
          busy={query.isFetching}
        />
      </div>

      {groups.length === 0 ? (
        <EmptyState
          title="No candidates match"
          hint="Try clearing the search or loosening the filters."
        />
      ) : (
        <div className="space-y-3">
          {groups.map((g, i) => (
            <GroupAccordion
              key={g.requisitionId}
              group={g}
              open={isOpen(g.requisitionId, i)}
              onToggle={() =>
                setOpenGroups((prev) => ({
                  ...prev,
                  [g.requisitionId]: !(prev[g.requisitionId] ?? (i === 0 || !!requisitionId)),
                }))
              }
              onOpenRow={open}
              selectedCandidateId={candidateId}
              sourceLabels={sourceLabels}
              provenanceByApplicationId={provenanceByApplicationId}
              isChecked={(id) => allMatching || checked.has(id)}
              onCheck={(id, on) => {
                const next = new Set(checked);
                if (on) next.add(id);
                else next.delete(id);
                setChecked(next);
              }}
              checkDisabled={allMatching}
            />
          ))}
        </div>
      )}

      {pageRows.length > 0 ? (
        <div className="mt-4 flex justify-end">
          <ListPager
            offset={offset}
            limit={limit}
            shown={pageRows.length}
            total={total}
            onOffsetChange={setOffset}
            busy={query.isFetching}
          />
        </div>
      ) : null}
    </PageContainer>
  );
}

function BulkResultBanner({
  result,
  nameById,
  onDismiss,
}: {
  result: BulkMoveApplicationsOutput;
  nameById: Map<string, string>;
  onDismiss: () => void;
}) {
  const skipped = result.results.filter((r) => r.status === "skipped");
  return (
    <div
      role="status"
      className={cn(
        "mb-3 rounded-card border px-4 py-3 text-sm",
        skipped.length > 0
          ? "border-status-warning-200 bg-status-warning-50"
          : "border-status-positive-200 bg-status-positive-50",
      )}
    >
      <div className="flex items-center gap-3">
        <p className="font-medium text-neutral-900">
          Moved {result.moved} of {result.requested}
          {skipped.length > 0 ? ` · ${skipped.length} skipped` : ""}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto text-xs text-neutral-600 hover:text-neutral-900"
        >
          Dismiss
        </button>
      </div>
      {skipped.length > 0 ? (
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs text-neutral-700">
          {skipped.map((r) => (
            <li key={r.applicationId}>
              <span className="font-medium">
                {nameById.get(r.applicationId) ?? `Application ${r.applicationId.slice(0, 8)}`}
              </span>
              {": "}
              {skipReasonLabel(r.skipReason)}
              {r.skipReason === "gate_blocked" && r.message ? ` — ${r.message}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
