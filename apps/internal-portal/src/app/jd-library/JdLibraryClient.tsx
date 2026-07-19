"use client";

import { useEffect, useMemo, useState } from "react";
import type { ListJdLibraryOutput, JdVersionHistoryItem } from "@hireops/api-types";
import { Badge, EmptyState, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * RO-03 — the /jd-library client. A searchable table over the current JD of
 * each of my requisitions, with a per-req version-history expando (version
 * list + a read-only JD-text view modal). All data is real (jd_skills /
 * aiMetadata keywords, jd_versions.status). No detached JD authoring.
 */

const JD_STATUS_TONE: Record<string, BadgeTone> = {
  draft: "neutral",
  approved: "success",
  archived: "warning",
};
const REQ_STATUS_TONE: Record<string, BadgeTone> = {
  draft: "neutral",
  pending_approval: "warning",
  approved: "success",
  on_hold: "warning",
  posted: "info",
  filled: "success",
  cancelled: "error",
  closed: "neutral",
};

function label(v: string): string {
  return v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

type Row = ListJdLibraryOutput["rows"][number];

export function JdLibraryClient({ initial }: { initial: ListJdLibraryOutput }) {
  const query = trpc.listJdLibrary.useQuery(
    { limit: 100 },
    { initialData: initial, refetchOnWindowFocus: false, staleTime: 5_000 },
  );
  const rows = query.data?.rows ?? initial.rows;

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [modal, setModal] = useState<{ title: string; version: JdVersionHistoryItem } | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [r.title ?? "", r.department ?? "", ...r.keywords, r.reqStatus, r.jdStatus]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search]);

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <p className="mb-4 text-sm text-neutral-600">
        Every job description across your requisitions. Keyword chips come from the JD&rsquo;s
        skills (or its AI-extracted keywords) — real data, never invented. Expand a row for its
        version history.
      </p>

      <div className="mb-4">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search role, department or keyword…"
          className="h-9 w-full max-w-md rounded-button border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-500"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? "No requisitions yet" : "No JDs match your search"}
          hint={
            rows.length === 0
              ? "When you create a requisition, its JD appears here. Start one with “Create new JD”."
              : "Try a different role, department or keyword."
          }
        />
      ) : (
        <TableShell>
          <Thead>
            <Th>Role</Th>
            <Th>Department</Th>
            <Th>Keywords</Th>
            <Th>JD status</Th>
            <Th>Requisition</Th>
            <Th>Created</Th>
            <Th>{""}</Th>
          </Thead>
          <Tbody>
            {filtered.map((r) => (
              <RowGroup
                key={r.requisitionId}
                row={r}
                expanded={expanded === r.requisitionId}
                onToggle={() =>
                  setExpanded((cur) => (cur === r.requisitionId ? null : r.requisitionId))
                }
                onView={(title, version) => setModal({ title, version })}
              />
            ))}
          </Tbody>
        </TableShell>
      )}

      {modal ? (
        <JdViewModal title={modal.title} version={modal.version} onClose={() => setModal(null)} />
      ) : null}
    </div>
  );
}

function RowGroup({
  row,
  expanded,
  onToggle,
  onView,
}: {
  row: Row;
  expanded: boolean;
  onToggle: () => void;
  onView: (title: string, v: JdVersionHistoryItem) => void;
}) {
  return (
    <>
      <Tr>
        <Td className="font-medium text-neutral-900">
          <a href={`/requisitions/${row.requisitionId}`} className="text-brand-700 hover:underline">
            {row.title ?? "Untitled role"}
          </a>
        </Td>
        <Td>{row.department ?? "—"}</Td>
        <Td>
          {row.keywords.length === 0 ? (
            <span className="text-neutral-400">—</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {row.keywords.slice(0, 5).map((k) => (
                <span
                  key={k}
                  className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px] text-neutral-600"
                >
                  {k}
                </span>
              ))}
              {row.keywords.length > 5 ? (
                <span className="text-[11px] text-neutral-400">+{row.keywords.length - 5}</span>
              ) : null}
            </span>
          )}
        </Td>
        <Td>
          <Badge tone={JD_STATUS_TONE[row.jdStatus] ?? "neutral"}>{label(row.jdStatus)}</Badge>
        </Td>
        <Td>
          <Badge tone={REQ_STATUS_TONE[row.reqStatus] ?? "neutral"}>{label(row.reqStatus)}</Badge>
        </Td>
        <Td>{formatDate(row.createdAt)}</Td>
        <Td>
          <button
            type="button"
            onClick={onToggle}
            className="text-xs font-medium text-brand-700 hover:underline"
            aria-expanded={expanded}
          >
            {expanded ? "Hide history" : "Version history"}
          </button>
        </Td>
      </Tr>
      {expanded ? (
        <Tr>
          <Td className="bg-neutral-50" colSpan={7}>
            <VersionHistory requisitionId={row.requisitionId} onView={onView} />
          </Td>
        </Tr>
      ) : null}
    </>
  );
}

function VersionHistory({
  requisitionId,
  onView,
}: {
  requisitionId: string;
  onView: (title: string, v: JdVersionHistoryItem) => void;
}) {
  const q = trpc.getJdVersionHistory.useQuery(
    { requisitionId },
    { refetchOnWindowFocus: false, staleTime: 10_000 },
  );

  if (q.isLoading) return <p className="py-2 text-sm text-neutral-500">Loading versions…</p>;
  if (q.error)
    return <p className="py-2 text-sm text-status-error-600">Couldn&rsquo;t load versions.</p>;
  const versions = q.data?.versions ?? [];
  const title = q.data?.title ?? "JD";
  if (versions.length === 0)
    return <p className="py-2 text-sm text-neutral-500">No JD versions yet.</p>;

  return (
    <ol className="space-y-2 py-2">
      {versions.map((v) => (
        <li
          key={v.id}
          className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2"
        >
          <span className="text-sm font-semibold text-neutral-900">v{v.versionNumber}</span>
          <Badge tone={JD_STATUS_TONE[v.status] ?? "neutral"}>{label(v.status)}</Badge>
          {v.isCurrent ? <Badge tone="info">Current</Badge> : null}
          <span className="min-w-0 flex-1 truncate text-sm text-neutral-600">
            {v.summary ?? "No summary"}
          </span>
          <span className="text-xs text-neutral-400">{formatDate(v.createdAt)}</span>
          <button
            type="button"
            onClick={() => onView(title, v)}
            className="text-xs font-medium text-brand-700 hover:underline"
          >
            View JD
          </button>
        </li>
      ))}
    </ol>
  );
}

function JdViewModal({
  title,
  version,
  onClose,
}: {
  title: string;
  version: JdVersionHistoryItem;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop close — a real button so it is keyboard-reachable. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default"
        tabIndex={-1}
      />
      <div className="relative flex max-h-[85vh] w-full max-w-3xl flex-col rounded-card border border-neutral-200 bg-white shadow-2">
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">
              {title} · JD v{version.versionNumber}
            </h2>
            <p className="text-xs text-neutral-500">{label(version.status)} · read-only</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100"
          >
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-neutral-800">
            {version.jdText}
          </pre>
        </div>
      </div>
    </div>
  );
}
