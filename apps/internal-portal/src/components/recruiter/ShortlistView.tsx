"use client";

import { useState } from "react";
import type { ListShortlistOutput } from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { useDrawerRouting } from "@/lib/use-drawer-routing";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  ScoreMeter,
  StatTile,
  TableShell,
  Thead,
  Th,
  Tbody,
  Tr,
  Td,
  cn,
} from "@/components/ui";
import { MatchTierChip, RiskCell, StageBadge, UrgencyChip, sourceLabel } from "./recruiter-chips";

type Output = ListShortlistOutput;
type RawRow = Output["rows"][number];
// z.unknown() (aiScoreExplanation) is required in the schema type but optional
// in the tRPC query result — loosen to match, as the triage cards do.
type Row = Omit<RawRow, "aiScoreExplanation"> & { aiScoreExplanation?: unknown };

/**
 * RECR-02 — the AI Shortlist. A THRESHOLD control over the REAL ai_score, three
 * DETERMINISTIC match tiers (buckets of that score, header count cards), and a
 * ranked table. Columns: AI Score (bar) · Must-have % · Notice · Stage ·
 * Urgency · Risk.
 *
 * HONESTY: the "Urgency" column REPLACES the prototype's "Heat Score %" — it is
 * a deterministic composite (SLA + time-in-stage + notice period), NOT a
 * probability. Tiers are honest labels of the score; "Must-have %" is a real
 * skill-overlap ratio (— when not computable); Risk is deterministic flags.
 * No fabricated confidence anywhere.
 */

function noticeLabel(days: number | null): string {
  if (days == null) return "Not captured";
  if (days <= 0) return "Immediate";
  return `${days} days`;
}

function ShortlistRowView({
  row,
  index,
  selected,
  onOpen,
}: {
  row: Row;
  index: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const name = row.fullName ?? "(no name on file)";
  return (
    <Tr className={cn("cursor-pointer", selected && "bg-brand-50")} onClick={onOpen}>
      <Td numeric className="text-neutral-400">
        {index}
      </Td>
      <Td>
        <div className="flex items-center gap-2.5">
          <Avatar name={name} seed={row.candidateId} size="sm" />
          <div className="min-w-0">
            <p className="truncate font-medium text-neutral-900">{name}</p>
            <p className="truncate text-xs text-neutral-500">{sourceLabel(row.source)}</p>
          </div>
        </div>
      </Td>
      <Td className="text-neutral-700">{row.roleTitle}</Td>
      <Td>
        <div className="flex items-center gap-2">
          <div className="w-24">
            <ScoreMeter score={row.aiScore} />
          </div>
          <MatchTierChip tier={row.tier} />
        </div>
      </Td>
      <Td numeric className="text-neutral-700">
        {row.mustHavePct == null ? "—" : `${row.mustHavePct}%`}
      </Td>
      <Td className="text-neutral-700">{noticeLabel(row.noticePeriodDays)}</Td>
      <Td>
        <StageBadge stage={row.stage} />
      </Td>
      <Td>
        <UrgencyChip rank={row.urgencyRank} index={row.urgencyIndex} />
      </Td>
      <Td>
        <RiskCell flags={row.riskFlags} />
      </Td>
    </Tr>
  );
}

export function ShortlistView({
  initial,
  canManageDefaults = false,
}: {
  initial: Output;
  canManageDefaults?: boolean;
}) {
  const [threshold, setThreshold] = useState(initial.threshold);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { open, candidateId } = useDrawerRouting();
  const utils = trpc.useUtils();

  const query = trpc.listShortlist.useQuery(
    { threshold },
    {
      initialData: threshold === initial.threshold ? initial : undefined,
      placeholderData: (prev) => prev,
    },
  );

  const data = query.data ?? initial;
  const rows = data.rows;
  const cutoffs = data.tierCutoffs;

  // The Min-score button set IS the tenant's three resolved tier floors (T2.3 /
  // G08) — not fixed 60/75/90 — so the control is honest about the boundaries.
  const thresholdOptions = [cutoffs.partial, cutoffs.good, cutoffs.excellent];

  const saveDefault = trpc.updateShortlistDefaults.useMutation({
    onSuccess: () => {
      void utils.listShortlist.invalidate();
      void utils.getShortlistDefaults.invalidate();
    },
  });

  async function persistDefault() {
    setSaveError(null);
    try {
      // Persist the CURRENT threshold + the tenant's current cutoffs as the
      // tenant default — genuinely consumed by listShortlist on reload.
      await saveDefault.mutateAsync({
        version: 1,
        threshold,
        tierCutoffs: {
          excellent: cutoffs.excellent,
          good: cutoffs.good,
          partial: cutoffs.partial,
        },
      });
    } catch (err) {
      handleTRPCError(err, { onMessage: (m) => setSaveError(m) });
      setSaveError((prev) => prev ?? "Could not save the default. Please try again.");
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-neutral-900">
          AI Shortlist
          <Badge tone="accent" pill>
            Threshold {threshold}%
          </Badge>
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Min score
          </span>
          {thresholdOptions.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setThreshold(t)}
              className={cn(
                "rounded-button px-3 py-1.5 text-sm font-medium transition-colors",
                threshold === t
                  ? "bg-brand-600 text-white"
                  : "border border-neutral-300 text-neutral-700 hover:bg-neutral-50",
              )}
            >
              {t}%
            </button>
          ))}
          {canManageDefaults ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void persistDefault()}
              disabled={saveDefault.isPending}
              title="Persist the current threshold as this tenant's shortlist default"
            >
              {saveDefault.isPending
                ? "Saving…"
                : saveDefault.isSuccess
                  ? "Saved as default"
                  : "Save current as default"}
            </Button>
          ) : null}
        </div>
      </div>

      {saveError ? (
        <p className="mb-4 text-sm text-danger-600" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          tone="accent"
          label={`Excellent match (${cutoffs.excellent}+)`}
          value={data.tierCounts.excellent}
          hint="candidates in the scored pool"
        />
        <StatTile
          label={`Good match (${cutoffs.good}–${cutoffs.excellent - 1})`}
          value={data.tierCounts.good}
          hint="candidates in the scored pool"
        />
        <StatTile
          label={`Partial match (${cutoffs.partial}–${cutoffs.good - 1})`}
          value={data.tierCounts.partial}
          hint="candidates in the scored pool"
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No candidates at this threshold"
          hint="Lower the minimum score, or wait for more applications to be scored by the AI screener."
        />
      ) : (
        <>
          <TableShell>
            <Thead>
              <Th numeric>#</Th>
              <Th>Candidate</Th>
              <Th>Role</Th>
              <Th>AI Score</Th>
              <Th numeric>Must-have</Th>
              <Th>Notice</Th>
              <Th>Stage</Th>
              <Th>Urgency</Th>
              <Th>Risk</Th>
            </Thead>
            <Tbody>
              {rows.map((row, i) => (
                <ShortlistRowView
                  key={row.applicationId}
                  row={row}
                  index={i + 1}
                  selected={candidateId === row.candidateId}
                  onOpen={() =>
                    open({ candidateId: row.candidateId, applicationId: row.applicationId })
                  }
                />
              ))}
            </Tbody>
          </TableShell>
          <p className="mt-3 text-xs text-neutral-500">
            Showing {rows.length} candidate{rows.length === 1 ? "" : "s"} at or above {threshold}%.
            Urgency is a deterministic rank (SLA state + time-in-stage + notice period), not a
            probability. Match tiers are buckets of the real AI score.
          </p>
        </>
      )}
    </div>
  );
}
