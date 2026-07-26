"use client";

import { useMemo, useState } from "react";
import type { ListCompDeskOutput, CompDeskRow } from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Button, EmptyState, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";
import { HeroStatCard, PageHeader } from "@/components/patterns";
import { StatTile } from "@/components/ui";
import { VerdictChip, OfferStatusChip, ApprovalStatusChip } from "./chips";
import { paiseToLpa } from "./format";
import { CompAnalysisPanel } from "./CompAnalysisPanel";
import { OfferComposerPanel } from "./OfferComposerPanel";

/**
 * CompDeskView (HROPS-02) — the Comp & offer desk. Hero stats (pipeline /
 * proceed / negotiate / need approval) + search + verdict filter + a table over
 * applications in the three comp stages. Each row opens a side drawer with the
 * analysis panel (Rec) or the offer composer (Draft). All money is INR paise on
 * the wire; display converts.
 */

type DrawerMode = { kind: "analysis" } | { kind: "composer"; suggestedPaise: number | null };

const VERDICT_FILTERS = [
  { key: "all", label: "All" },
  { key: "proceed", label: "Proceed" },
  { key: "negotiate", label: "Negotiate" },
  { key: "need_approval", label: "Need approval" },
] as const;
type VerdictFilter = (typeof VERDICT_FILTERS)[number]["key"];

export function CompDeskView({ initial }: { initial: ListCompDeskOutput }) {
  const query = trpc.listCompDesk.useQuery(
    {},
    { initialData: initial, staleTime: 5_000, refetchOnWindowFocus: true },
  );
  const rows = query.data?.rows ?? [];
  const stats = query.data?.stats ?? { total: 0, proceed: 0, negotiate: 0, needApproval: 0 };

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<VerdictFilter>("all");
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [mode, setMode] = useState<DrawerMode>({ kind: "analysis" });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all" && r.verdict !== filter) return false;
      if (q && !r.candidateName.toLowerCase().includes(q) && !r.roleTitle.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [rows, search, filter]);

  const openRow = rows.find((r) => r.applicationId === openApp) ?? null;

  function openAnalysis(appId: string) {
    setOpenApp(appId);
    setMode({ kind: "analysis" });
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <PageHeader
        title="Comp & offer desk"
        subtitle={
          <>
            Every late-stage candidate with its rule-computed comp verdict, offer status, and
            approval posture.{" "}
            <span className="font-medium text-neutral-600">
              Verdicts are deterministic — the AI writes only the rationale prose.
            </span>
          </>
        }
      />

      {/* Hero stats */}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <HeroStatCard label="On desk" value={stats.total} />
        <StatTile label="Proceed" value={stats.proceed} tone="positive" />
        <StatTile label="Negotiate" value={stats.negotiate} tone="warning" />
        <StatTile label="Need approval" value={stats.needApproval} tone="error" />
      </div>

      {/* Controls */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search candidate or role…"
          className="w-64 rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
        />
        <div className="flex items-center gap-1">
          {VERDICT_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                filter === f.key
                  ? "bg-brand-600 text-white"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="mt-4">
        {filtered.length === 0 ? (
          <div className="rounded-card border border-neutral-200 bg-white p-8 shadow-card">
            <EmptyState
              title="No candidates on the comp desk"
              hint="The desk covers applications in the HR round, offer-drafted, and offer-accepted stages."
            />
          </div>
        ) : (
          <TableShell>
            <Thead>
              <Th>Candidate</Th>
              <Th>Role</Th>
              <Th>Expected</Th>
              <Th>Band (min–max)</Th>
              <Th>Suggested</Th>
              <Th>Verdict</Th>
              <Th>Offer</Th>
              <Th>Approval</Th>
              <Th numeric>Actions</Th>
            </Thead>
            <Tbody>
              {filtered.map((r) => (
                <DeskRow
                  key={r.applicationId}
                  row={r}
                  onRec={() => openAnalysis(r.applicationId)}
                  onDraft={() => {
                    setOpenApp(r.applicationId);
                    setMode({ kind: "composer", suggestedPaise: r.suggestedPaise });
                  }}
                />
              ))}
            </Tbody>
          </TableShell>
        )}
      </div>

      {openRow ? (
        <DeskDrawer
          row={openRow}
          mode={mode}
          onClose={() => setOpenApp(null)}
          onModeChange={setMode}
          onChanged={() => void query.refetch()}
        />
      ) : null}
    </div>
  );
}

function DeskRow({
  row,
  onRec,
  onDraft,
}: {
  row: CompDeskRow;
  onRec: () => void;
  onDraft: () => void;
}) {
  const bandLabel =
    row.bandMinPaise != null && row.bandMaxPaise != null
      ? `${paiseToLpa(row.bandMinPaise)} – ${paiseToLpa(row.bandMaxPaise)}`
      : "—";
  return (
    <Tr>
      <Td className="font-medium text-neutral-900">{row.candidateName}</Td>
      <Td label="Role" className="text-neutral-600">
        {row.roleTitle}
      </Td>
      <Td label="Expected" className="tabular-nums text-neutral-700">
        {paiseToLpa(row.expectedSalaryInrPaise) ?? <span className="text-neutral-400">—</span>}
      </Td>
      <Td label="Band (min–max)" className="tabular-nums text-neutral-600">
        {bandLabel}
      </Td>
      <Td label="Suggested" className="tabular-nums font-medium text-neutral-900">
        {paiseToLpa(row.suggestedPaise) ?? <span className="text-neutral-400">—</span>}
      </Td>
      <Td label="Verdict">
        <VerdictChip verdict={row.verdict} />
      </Td>
      <Td label="Offer">
        <OfferStatusChip status={row.offerStatus} />
      </Td>
      <Td label="Approval">
        <ApprovalStatusChip status={row.approvalStatus} />
      </Td>
      <Td numeric label="Actions">
        <div className="flex justify-end gap-1.5">
          <Button variant="secondary" size="sm" onClick={onRec}>
            Rec
          </Button>
          <Button variant="primary" size="sm" onClick={onDraft}>
            Draft
          </Button>
        </div>
      </Td>
    </Tr>
  );
}

function DeskDrawer({
  row,
  mode,
  onClose,
  onModeChange,
  onChanged,
}: {
  row: CompDeskRow;
  mode: DrawerMode;
  onClose: () => void;
  onModeChange: (m: DrawerMode) => void;
  onChanged: () => void;
}) {
  const requestApproval = trpc.requestOfferApproval.useMutation();
  const [notice, setNotice] = useState<string | null>(null);

  async function doRequestApproval(offerId: string) {
    setNotice(null);
    try {
      await requestApproval.mutateAsync({ offerId });
      setNotice("Sent to the HR head for approval.");
      onChanged();
    } catch (err) {
      handleTRPCError(err, { onMessage: (m) => setNotice(m) });
    }
  }

  return (
    <div className="fixed inset-0 z-modal flex justify-end" role="dialog" aria-modal="true">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-neutral-900/40 transition-opacity"
      />
      <aside className="relative ml-auto flex h-full w-[46vw] min-w-[420px] max-w-2xl flex-col overflow-hidden bg-neutral-50 shadow-3">
        <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-neutral-900">{row.candidateName}</h2>
            <p className="text-xs text-neutral-500">{row.roleTitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-neutral-200 p-0.5">
              <TabButton
                active={mode.kind === "analysis"}
                onClick={() => onModeChange({ kind: "analysis" })}
              >
                Analysis
              </TabButton>
              <TabButton
                active={mode.kind === "composer"}
                onClick={() =>
                  onModeChange({ kind: "composer", suggestedPaise: row.suggestedPaise })
                }
              >
                Compose offer
              </TabButton>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {notice ? (
            <p className="mb-3 rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-700">{notice}</p>
          ) : null}
          {mode.kind === "analysis" ? (
            <CompAnalysisPanel
              applicationId={row.applicationId}
              onDraftOffer={(suggestedPaise) => onModeChange({ kind: "composer", suggestedPaise })}
              onRequestApproval={doRequestApproval}
            />
          ) : (
            <OfferComposerPanel
              applicationId={row.applicationId}
              suggestedPaise={mode.suggestedPaise}
              onSaved={onChanged}
              onCancel={() => onModeChange({ kind: "analysis" })}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
        active ? "bg-brand-600 text-white" : "text-neutral-600 hover:bg-neutral-100"
      }`}
    >
      {children}
    </button>
  );
}
