"use client";

import { useState } from "react";
import type {
  ListCaseAuditCasesOutput,
  CaseAuditCaseRow,
  CaseAuditEvent,
} from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { Button, EmptyState, StatTile } from "@/components/ui";
import { HeroStatCard, PageHeader } from "@/components/patterns";
import { cn } from "@/components/ui/cn";

/**
 * /case-audit (HROPS-03) — the per-case audit trail. Hero stats + search +
 * one accordion card per application in the HR-ops window; expanding a case
 * lazily loads its full audit timeline (stage transitions, offer events,
 * document events, HR notes) as a dot-line vertical timeline, newest first.
 * "Add audit note" writes a REAL hr_case_notes row whose audit trigger
 * produces the timeline event.
 */

const STAGE_LABEL: Record<string, string> = {
  tech_interview: "Tech interview",
  hr_round: "HR round",
  offer_drafted: "Offer drafted",
  offer_accepted: "Offer accepted",
};

const KIND_DOT: Record<CaseAuditEvent["kind"], string> = {
  stage: "bg-brand-500",
  offer: "bg-status-positive-500",
  document: "bg-status-info-500",
  note: "bg-status-warning-500",
  other: "bg-neutral-400",
};

function formatTs(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function CaseAuditView({ initial }: { initial: ListCaseAuditCasesOutput }) {
  const [search, setSearch] = useState("");

  const query = trpc.listCaseAuditCases.useQuery(
    { search: search || undefined, limit: 100 },
    {
      initialData: !search ? initial : undefined,
      placeholderData: (prev) => prev,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
  );

  const items = query.data?.items ?? [];
  const stats = query.data?.stats ?? initial.stats;

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      <PageHeader
        title="Case audit trail"
        subtitle="The complete, append-only audit history for every active case — stage moves, offer events, document verification, and HR notes."
        className="mb-5"
      />

      <div className="mb-6 grid grid-cols-3 gap-3">
        <HeroStatCard label="Cases tracked" value={stats.cases} caption="in the HR-ops window" />
        <StatTile label="Total events" value={stats.events} tone="info" />
        <StatTile label="Audit notes" value={stats.notes} tone="warning" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search candidate or role…"
          aria-label="Search cases"
          className="w-64 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-800 transition-colors hover:border-neutral-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        <span className="ml-auto text-xs tabular-nums text-neutral-400">
          {items.length} case{items.length === 1 ? "" : "s"}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-neutral-200 bg-white">
          <EmptyState
            className="py-14"
            title="No cases in the audit window"
            hint="Cases appear here once a candidate reaches the technical-interview stage. Every stage change, offer event, and document decision is recorded automatically."
          />
        </div>
      ) : (
        <ul className="space-y-2.5">
          {items.map((row) => (
            <li key={row.applicationId}>
              <CaseCard row={row} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CaseCard({ row }: { row: CaseAuditCaseRow }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-2 px-5 py-4 text-left transition-colors hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <p className="truncate text-sm font-semibold text-neutral-900">
            {row.candidateName ?? "Candidate"}
          </p>
          <span className="truncate text-sm text-neutral-500">{row.roleTitle ?? ""}</span>
          <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500">
            {row.caseRef}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">
            {STAGE_LABEL[row.stage] ?? row.stage}
          </span>
          <span className="text-xs tabular-nums text-neutral-500">
            {row.eventCount} event{row.eventCount === 1 ? "" : "s"}
          </span>
          {row.lastActivityAt ? (
            <span className="text-xs text-neutral-400">last {formatTs(row.lastActivityAt)}</span>
          ) : null}
        </div>
      </button>
      {open ? <CaseTimeline applicationId={row.applicationId} /> : null}
    </div>
  );
}

function CaseTimeline({ applicationId }: { applicationId: string }) {
  const utils = trpc.useUtils();
  const timeline = trpc.getCaseAuditTimeline.useQuery({ applicationId });
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const addNote = trpc.addCaseAuditNote.useMutation({
    onSuccess: () => {
      setNote("");
      void utils.getCaseAuditTimeline.invalidate({ applicationId });
      void utils.listCaseAuditCases.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  return (
    <div className="border-t border-neutral-100 px-5 py-4">
      {/* Add note */}
      <div className="mb-4 flex items-start gap-2">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Add an audit note — recorded permanently in this case's trail…"
          aria-label="Audit note"
          className="min-h-[2.25rem] flex-1 rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={addNote.isPending || note.trim().length === 0}
          onClick={() => {
            setError(null);
            addNote.mutate({ applicationId, note: note.trim() });
          }}
        >
          {addNote.isPending ? "Adding…" : "Add note"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-xs text-status-error-700">
          {error}
        </p>
      ) : null}

      {timeline.isLoading ? (
        <p className="py-2 text-sm text-neutral-500">Loading timeline…</p>
      ) : !timeline.data || timeline.data.events.length === 0 ? (
        <p className="py-2 text-sm text-neutral-500">No audit events recorded for this case yet.</p>
      ) : (
        <ol className="relative ml-2 border-l border-neutral-200 pl-5">
          {timeline.data.events.map((ev) => (
            <TimelineEvent key={ev.id} ev={ev} />
          ))}
        </ol>
      )}
    </div>
  );
}

function TimelineEvent({ ev }: { ev: CaseAuditEvent }) {
  return (
    <li className={cn("relative pb-4 last:pb-0", ev.isNote && "rounded-md")}>
      <span
        aria-hidden
        className={cn(
          "absolute -left-[1.65rem] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white",
          KIND_DOT[ev.kind],
        )}
      />
      <div
        className={cn(
          ev.isNote &&
            "-ml-2 rounded-md border border-status-warning-200 bg-status-warning-50 p-2.5",
        )}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-neutral-900">{ev.title}</p>
          <span className="text-xs tabular-nums text-neutral-400">{formatTs(ev.timestamp)}</span>
        </div>
        {ev.description ? (
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-neutral-600">{ev.description}</p>
        ) : null}
        <p className="mt-0.5 text-xs text-neutral-500">
          {ev.isNote ? `Note by ${ev.actorName ?? "HR ops"}` : (ev.actorName ?? "System")}
        </p>
      </div>
    </li>
  );
}
