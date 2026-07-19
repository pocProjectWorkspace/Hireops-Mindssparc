"use client";

import { useMemo, useState } from "react";
import type {
  ListCandidatesByRequisitionOutput,
  ApplicationStage,
  ApplicationSource,
} from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { useDrawerRouting } from "@/lib/use-drawer-routing";
import { useUndoToast } from "@/components/triage/UndoToastProvider";
import { Avatar, Badge, EmptyState, cn } from "@/components/ui";
import { ChevronRightIcon } from "@/components/patterns/icons";
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
 */

// Forward pipeline order for the "advance" action — the next legal stage.
const FORWARD_NEXT: Partial<Record<ApplicationStage, ApplicationStage>> = {
  application_received: "recruiter_review",
  ai_screening: "recruiter_review",
  recruiter_review: "shortlisted",
  shortlisted: "tech_interview",
  tech_interview: "hr_round",
  hr_round: "offer_drafted",
  offer_drafted: "offer_accepted",
};

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
}: {
  group: Group;
  open: boolean;
  onToggle: () => void;
  onOpenRow: (ids: { candidateId: string; applicationId: string }) => void;
  selectedCandidateId: string | null;
}) {
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
        <PhaseChip phase={group.phase} />
      </button>

      {open ? (
        <div className="overflow-x-auto border-t border-neutral-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50/60 text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                <th className="px-5 py-2 font-semibold">Candidate</th>
                <th className="px-4 py-2 font-semibold">Stage</th>
                <th className="px-4 py-2 font-semibold">AI Score</th>
                <th className="px-4 py-2 font-semibold">Source</th>
                <th className="px-4 py-2 font-semibold">Missing Info</th>
                <th className="px-5 py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => {
                const name = row.fullName ?? "(no name on file)";
                const selected = selectedCandidateId === row.candidateId;
                return (
                  <tr
                    key={row.applicationId}
                    className={cn(
                      "border-b border-neutral-100 last:border-0 hover:bg-neutral-50",
                      selected && "bg-brand-50",
                    )}
                  >
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={name} seed={row.candidateId} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-neutral-900">{name}</p>
                          <p className="truncate text-xs text-neutral-500 tabular-nums">
                            {row.refCode}
                            {row.yearsOfExperience != null ? ` · ${row.yearsOfExperience} yrs` : ""}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <StageBadge stage={row.stage} />
                    </td>
                    <td className="px-4 py-2.5">
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
                    </td>
                    <td className="px-4 py-2.5 text-neutral-700">{sourceLabel(row.source)}</td>
                    <td className="px-4 py-2.5">
                      <MissingInfoCell info={row.missingInfo} />
                    </td>
                    <td className="px-5 py-2.5">
                      <RowActions
                        row={row}
                        onOpen={() =>
                          onOpenRow({
                            candidateId: row.candidateId,
                            applicationId: row.applicationId,
                          })
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export function CandidatesByRoleList({ initial }: { initial: Output }) {
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<ApplicationStage | "">("");
  const [source, setSource] = useState<ApplicationSource | "">("");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const { open, candidateId } = useDrawerRouting();

  const noFilters = search.trim() === "" && stage === "" && source === "";
  const query = trpc.listCandidatesByRequisition.useQuery(
    {
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(stage ? { stage } : {}),
      ...(source ? { source } : {}),
    },
    { initialData: noFilters ? initial : undefined, placeholderData: (prev) => prev },
  );

  const data = query.data ?? initial;
  const groups = data.groups;

  // First group open by default; user toggles override.
  const isOpen = useMemo(
    () => (id: string, index: number) => openGroups[id] ?? index === 0,
    [openGroups],
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <div className="mb-5 flex items-center gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-neutral-900">
          All candidates
          <Badge tone="neutral" pill>
            {data.totalCandidates}
          </Badge>
        </h2>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or ID…"
          className="h-10 min-w-64 flex-1 rounded-button border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none"
        />
        <select
          value={stage}
          onChange={(e) => setStage(e.target.value as ApplicationStage | "")}
          className="h-10 rounded-button border border-neutral-300 bg-white px-3 text-sm text-neutral-700 focus:border-brand-500 focus:outline-none"
        >
          <option value="">All stages</option>
          {STAGE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {stageLabel(s)}
            </option>
          ))}
        </select>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as ApplicationSource | "")}
          className="h-10 rounded-button border border-neutral-300 bg-white px-3 text-sm text-neutral-700 focus:border-brand-500 focus:outline-none"
        >
          <option value="">All sources</option>
          {SOURCE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {sourceLabel(s)}
            </option>
          ))}
        </select>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          title="No candidates match"
          hint="Try clearing the search or the stage / source filters."
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
                  [g.requisitionId]: !(prev[g.requisitionId] ?? i === 0),
                }))
              }
              onOpenRow={open}
              selectedCandidateId={candidateId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
