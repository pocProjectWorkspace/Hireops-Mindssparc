"use client";

import { useState } from "react";
import type {
  ListMarketBenchmarksOutput,
  MarketBenchmarkRow,
  BenchmarkLevel,
} from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  TableShell,
  Thead,
  Th,
  Tbody,
  Tr,
  Td,
} from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { IntelPageHeader } from "./IntelPageHeader";

/**
 * Market Intelligence — the benchmark table + per-role trending-skills cards,
 * with the honesty source_note line. Admins get an inline edit form per row
 * (upsertMarketBenchmark). Seeded from the server render and kept live by a
 * React Query fetch so an edit reflects immediately.
 *
 * Money: medianSalaryMinor is INR paise; we render it as ₹X.X LPA (1 LPA =
 * 10,000,000 paise) — the unit HR reasons about. This is NOT the positions
 * comp-band (major-rupee) convention; the value came from the benchmark row.
 */

const LEVEL_TONE: Record<BenchmarkLevel, BadgeTone> = {
  low: "neutral",
  medium: "warning",
  high: "success",
};

function lpaLabel(minor: number): string {
  const lpa = minor / 10_000_000;
  // One decimal, trimmed — 42.0 → "42", 34.5 → "34.5".
  const s = lpa.toFixed(1).replace(/\.0$/, "");
  return `₹${s} LPA`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function MarketIntelligenceView({
  initial,
  canEdit,
}: {
  initial: ListMarketBenchmarksOutput;
  canEdit: boolean;
}) {
  const query = trpc.listMarketBenchmarks.useQuery(
    {},
    { initialData: initial, staleTime: 5_000, refetchOnWindowFocus: true },
  );
  const rows = query.data?.rows ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const editingRow = editing ? rows.find((r) => r.id === editing) : undefined;

  // The honesty line — every row shares the same curated source in the demo,
  // so surface the most recent one prominently and note it applies to all.
  const sourceNote = rows[0]?.sourceNote ?? "Curated benchmark — update quarterly";

  return (
    <>
      <IntelPageHeader
        title="Market intelligence"
        subtitle={
          <>
            Curated salary + hiring benchmarks by role.{" "}
            <span className="font-medium text-neutral-600">{sourceNote}.</span> These are reference
            figures maintained by your team — not a live market feed.
          </>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No benchmarks yet"
          hint={
            canEdit
              ? "Seed benchmarks with pnpm db:seed:benchmarks, or add rows once the edit form ships. Each row is curated reference data your team maintains."
              : "An administrator hasn't added market benchmarks for your tenant yet."
          }
        />
      ) : (
        <>
          <section className="mb-8">
            <TableShell>
              <Thead>
                <Th>Role</Th>
                <Th numeric>Market median</Th>
                <Th numeric>Time to fill</Th>
                <Th>Availability</Th>
                <Th>Competitor demand</Th>
                <Th numeric>Rounds</Th>
                {canEdit ? <Th> </Th> : null}
              </Thead>
              <Tbody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td className="font-medium text-neutral-900">{r.roleTitle}</Td>
                    <Td numeric>{lpaLabel(r.medianSalaryMinor)}</Td>
                    <Td numeric>{r.ttfDays}d</Td>
                    <Td>
                      <Badge tone={LEVEL_TONE[r.availability]}>{cap(r.availability)}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={LEVEL_TONE[r.competitorDemand]}>{cap(r.competitorDemand)}</Badge>
                    </Td>
                    <Td numeric>{r.recommendedRounds}</Td>
                    {canEdit ? (
                      <Td>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(editing === r.id ? null : r.id)}
                        >
                          {editing === r.id ? "Close" : "Edit"}
                        </Button>
                      </Td>
                    ) : null}
                  </Tr>
                ))}
              </Tbody>
            </TableShell>

            {canEdit && editingRow ? (
              <div className="mt-3">
                <BenchmarkEditForm
                  row={editingRow}
                  onDone={() => {
                    setEditing(null);
                    void query.refetch();
                  }}
                />
              </div>
            ) : null}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-neutral-900">Trending skills by role</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rows.map((r) => (
                <Card key={r.id} padded={false} className="p-4">
                  <div className="mb-2 flex items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold text-neutral-900">{r.roleTitle}</h3>
                    <span className="text-xs text-neutral-500">
                      {lpaLabel(r.medianSalaryMinor)}
                    </span>
                  </div>
                  {r.trendingSkills.length === 0 ? (
                    <p className="text-xs text-neutral-400">No trending skills recorded.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {r.trendingSkills.map((s) => (
                        <span
                          key={s}
                          className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px] font-normal text-neutral-700"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}

/** Inline admin edit (upsertMarketBenchmark). Role title is the key — editable
 * here creates a NEW row if changed, so it's shown read-only. */
function BenchmarkEditForm({ row, onDone }: { row: MarketBenchmarkRow; onDone: () => void }) {
  const upsert = trpc.upsertMarketBenchmark.useMutation();
  const [medianLpa, setMedianLpa] = useState((row.medianSalaryMinor / 10_000_000).toString());
  const [ttfDays, setTtfDays] = useState(row.ttfDays.toString());
  const [availability, setAvailability] = useState<BenchmarkLevel>(row.availability);
  const [competitorDemand, setCompetitorDemand] = useState<BenchmarkLevel>(row.competitorDemand);
  const [recommendedRounds, setRecommendedRounds] = useState(row.recommendedRounds.toString());
  const [trending, setTrending] = useState(row.trendingSkills.join(", "));
  const [sourceNote, setSourceNote] = useState(row.sourceNote);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const medianMinor = Math.round(Number(medianLpa) * 10_000_000);
    if (!Number.isFinite(medianMinor) || medianMinor < 0) {
      setError("Median must be a non-negative number of lakhs per annum.");
      return;
    }
    try {
      await upsert.mutateAsync({
        roleTitle: row.roleTitle,
        medianSalaryMinor: medianMinor,
        currency: row.currency,
        ttfDays: Math.max(0, Math.round(Number(ttfDays) || 0)),
        availability,
        competitorDemand,
        recommendedRounds: Math.max(0, Math.round(Number(recommendedRounds) || 0)),
        trendingSkills: trending
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 20),
        sourceNote: sourceNote.trim() || "Curated benchmark — update quarterly",
      });
      onDone();
    } catch (err) {
      handleTRPCError(err, { onMessage: (m) => setError(m) });
      setError("Could not save the benchmark. Please try again.");
    }
  }

  const field = "rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm";
  const level = ["low", "medium", "high"] as const;

  return (
    <Card padded={false} className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-neutral-900">Edit — {row.roleTitle}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-600">
          Market median (₹ LPA)
          <input
            className={field}
            value={medianLpa}
            inputMode="decimal"
            onChange={(e) => setMedianLpa(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-600">
          Time to fill (days)
          <input
            className={field}
            value={ttfDays}
            inputMode="numeric"
            onChange={(e) => setTtfDays(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-600">
          Recommended rounds
          <input
            className={field}
            value={recommendedRounds}
            inputMode="numeric"
            onChange={(e) => setRecommendedRounds(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-600">
          Availability
          <select
            className={field}
            value={availability}
            onChange={(e) => setAvailability(e.target.value as BenchmarkLevel)}
          >
            {level.map((l) => (
              <option key={l} value={l}>
                {cap(l)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-600">
          Competitor demand
          <select
            className={field}
            value={competitorDemand}
            onChange={(e) => setCompetitorDemand(e.target.value as BenchmarkLevel)}
          >
            {level.map((l) => (
              <option key={l} value={l}>
                {cap(l)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-600 sm:col-span-2 lg:col-span-3">
          Trending skills (comma-separated)
          <input className={field} value={trending} onChange={(e) => setTrending(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-600 sm:col-span-2 lg:col-span-3">
          Source note (the honesty label)
          <input
            className={field}
            value={sourceNote}
            onChange={(e) => setSourceNote(e.target.value)}
          />
        </label>
      </div>
      {error ? <p className="mt-2 text-xs text-status-error-700">{error}</p> : null}
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={save} disabled={upsert.isPending}>
          {upsert.isPending ? "Saving…" : "Save benchmark"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={upsert.isPending}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
