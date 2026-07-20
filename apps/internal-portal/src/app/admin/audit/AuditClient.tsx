"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  type ListAuditEventsOutput,
  type AuditSeverity,
  AUDIT_SEVERITIES,
  AUDIT_SEVERITY_META,
  auditEventSeverity,
} from "@hireops/api-types";
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
  type BadgeTone,
} from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

// Derive the row type from the procedure output, relaxing the two jsonb
// columns to optional — zod infers `unknown` fields as required on the
// schema side but the tRPC client re-infers them as optional, so the prop
// type must accept the client's (optional) shape.
type AuditEventRow = Omit<ListAuditEventsOutput["items"][number], "before_data" | "after_data"> & {
  before_data?: unknown;
  after_data?: unknown;
};

/**
 * The admin audit-trail list (AD10) — elevated to prototype density.
 *
 * Server-side filters (agent preset → entity_type set, DML action) drive a
 * keyset-paginated tRPC infinite query, seeded from the server render. On top
 * of the accumulated rows the client applies three refinements — a free-text
 * search, a derived-severity chip filter, and an actor filter — and offers an
 * Export CSV that regenerates from the SAME server query via
 * `exportAuditEvents` and applies the identical client refinements before
 * building the blob.
 *
 * Severity is DERIVED, never stored: `auditEventSeverity(action, entity_type)`
 * is a pure classifier shared with the API-types package. It reflects the DML
 * verb and whether the touched table is security/state-sensitive — nothing
 * about people. This is a real audit log, not a "D&I compliance report".
 *
 * Actor is the truncated actor_user_id (or "system"). We deliberately do NOT
 * join users/memberships for display names: their RLS is self-select-only, so
 * the join would silently null for other actors.
 */

// The agent-runtime tables — the "Agent activity" preset. Hardcoded because
// audit_logs.entity_type is just a source-table name; there's no server-side
// grouping to lean on.
const AGENT_TABLES = [
  "automation_agents",
  "agent_triggers",
  "agent_actions",
  "agent_approval_rules",
  "agent_runs",
  "agent_run_actions",
  "agent_approval_requests",
] as const;

type ActionFilter = "insert" | "update" | "delete";

const SEVERITY_TONE: Record<AuditSeverity, BadgeTone> = {
  info: "neutral",
  warning: "warning",
  critical: "error",
};

export function AuditClient({ initial }: { initial: ListAuditEventsOutput }) {
  const [agentPreset, setAgentPreset] = useState(false);
  const [actionFilter, setActionFilter] = useState<ActionFilter | null>(null);
  const [severityFilter, setSeverityFilter] = useState<AuditSeverity | null>(null);
  const [actorFilter, setActorFilter] = useState<string>(""); // "" = all, "system", or actor id
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const utils = trpc.useUtils();

  const serverFiltersActive = agentPreset || actionFilter !== null;

  const input = {
    limit: 50,
    ...(agentPreset ? { entityTypes: [...AGENT_TABLES] } : {}),
    ...(actionFilter ? { action: actionFilter } : {}),
  };

  const query = trpc.listAuditEvents.useInfiniteQuery(input, {
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    initialData: serverFiltersActive
      ? undefined
      : { pages: [initial], pageParams: [undefined] },
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });

  const rows = useMemo<AuditEventRow[]>(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );

  // Distinct actors present in the loaded rows — powers the actor <select>.
  const actorOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.actor_user_id ?? "system");
    return [...set].sort();
  }, [rows]);

  // The single client-refinement predicate — used by both the table and the
  // CSV export so "the current filtered view" means exactly one thing.
  const refine = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (r: AuditEventRow): boolean => {
      if (severityFilter && auditEventSeverity(r.action, r.entity_type) !== severityFilter) {
        return false;
      }
      if (actorFilter) {
        const actor = r.actor_user_id ?? "system";
        if (actor !== actorFilter) return false;
      }
      if (needle) {
        const hay = [
          r.entity_type,
          r.entity_id,
          r.action,
          r.actor_user_id ?? "system",
          r.actor_membership_id ?? "",
          r.source,
          r.request_id ?? "",
          ...(r.changed_columns ?? []),
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    };
  }, [search, severityFilter, actorFilter]);

  const items = useMemo(() => rows.filter(refine), [rows, refine]);

  const clientRefined = severityFilter !== null || actorFilter !== "" || search.trim() !== "";

  async function onExport() {
    setExporting(true);
    setExportNote(null);
    try {
      const res = await utils.exportAuditEvents.fetch({
        limit: 5000,
        ...(agentPreset ? { entityTypes: [...AGENT_TABLES] } : {}),
        ...(actionFilter ? { action: actionFilter } : {}),
      });
      const filtered = (res.items as AuditEventRow[]).filter(refine);
      const csv = buildCsv(filtered);
      downloadCsv(csv, `audit-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`);
      setExportNote(
        `Exported ${filtered.length.toLocaleString()} event${filtered.length === 1 ? "" : "s"}` +
          (res.truncated ? " (capped at 5,000 — narrow the filters for a complete export)" : "") +
          ".",
      );
    } catch (err) {
      setExportNote(err instanceof Error ? `Export failed: ${err.message}` : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-neutral-600">
          Every tenant-scoped data change — proposed, approved, sent — with the before/after diff.
          Newest first. Severity is derived from the change itself (the action and whether the
          record is security- or governed-state-sensitive); nothing here infers anything about
          people. This is the audit log itself; reads here are never themselves audited.
        </p>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button variant="secondary" onClick={onExport} disabled={exporting}>
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          {exportNote ? (
            <span
              className={`text-xs ${
                exportNote.startsWith("Export failed")
                  ? "text-status-error-600"
                  : "text-neutral-500"
              }`}
            >
              {exportNote}
            </span>
          ) : null}
        </div>
      </div>

      {/* Server-side filters. */}
      <section className="mb-3 flex flex-wrap items-center gap-2">
        <FilterChip
          label="Agent activity"
          active={agentPreset}
          onClick={() => setAgentPreset((v) => !v)}
        />
        <span aria-hidden className="mx-1 h-4 w-px bg-neutral-200" />
        <FilterChip
          label="All actions"
          active={actionFilter === null}
          onClick={() => setActionFilter(null)}
        />
        {(["insert", "update", "delete"] as ActionFilter[]).map((a) => (
          <FilterChip
            key={a}
            label={humanize(a)}
            active={actionFilter === a}
            onClick={() => setActionFilter(a)}
          />
        ))}
      </section>

      {/* Client refinements: severity chips + actor select + search. */}
      <section className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          Severity
        </span>
        <FilterChip
          label="All"
          active={severityFilter === null}
          onClick={() => setSeverityFilter(null)}
        />
        {AUDIT_SEVERITIES.map((s) => (
          <FilterChip
            key={s}
            label={AUDIT_SEVERITY_META[s].label}
            active={severityFilter === s}
            onClick={() => setSeverityFilter((cur) => (cur === s ? null : s))}
          />
        ))}
        <span aria-hidden className="mx-1 h-4 w-px bg-neutral-200" />
        <select
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          aria-label="Filter by actor"
          className="h-8 rounded-full border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">All actors</option>
          {actorOptions.map((a) => (
            <option key={a} value={a}>
              {a === "system" ? "system" : `${a.slice(0, 8)}…`}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search entity, id, actor, columns…"
          aria-label="Search audit events"
          className="h-8 w-64 rounded-full border border-neutral-300 bg-white px-3.5 text-xs text-neutral-800 placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </section>

      {query.isLoading ? (
        <Card>
          <p className="text-sm text-neutral-500">Loading…</p>
        </Card>
      ) : items.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title={
              clientRefined || serverFiltersActive
                ? "No audit events match"
                : "No audit events yet"
            }
            hint={
              clientRefined || serverFiltersActive
                ? "Clear the filters above to see all activity."
                : "Activity will appear here as records change."
            }
          />
        </Card>
      ) : (
        <TableShell>
          <Thead>
            <Th>When</Th>
            <Th>Entity</Th>
            <Th>Action</Th>
            <Th>Severity</Th>
            <Th>Entity ID</Th>
            <Th>Actor</Th>
            <Th className="w-8" aria-label="Expand" />
          </Thead>
          <Tbody>
            {items.map((row) => (
              <AuditRow
                key={row.id}
                row={row}
                expanded={expandedId === row.id}
                onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
              />
            ))}
          </Tbody>
        </TableShell>
      )}

      {query.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <Button
            variant="secondary"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AuditRow({
  row,
  expanded,
  onToggle,
}: {
  row: AuditEventRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const severity = auditEventSeverity(row.action, row.entity_type);
  return (
    <>
      <Tr onClick={onToggle} className="cursor-pointer" aria-expanded={expanded}>
        <Td className="whitespace-nowrap">
          <span className="block text-neutral-800 tabular-nums">{absolute(row.created_at)}</span>
          <span className="block text-xs text-neutral-400">{relative(row.created_at)}</span>
        </Td>
        <Td>
          <Badge tone="neutral" className="font-mono">
            {row.entity_type}
          </Badge>
        </Td>
        <Td>
          <ActionBadge action={row.action} />
        </Td>
        <Td>
          <Badge tone={SEVERITY_TONE[severity]}>{AUDIT_SEVERITY_META[severity].label}</Badge>
        </Td>
        <Td className="font-mono text-xs text-neutral-500">{row.entity_id.slice(0, 8)}…</Td>
        <Td className="font-mono text-xs text-neutral-500">
          {row.actor_user_id ? `${row.actor_user_id.slice(0, 8)}…` : "system"}
        </Td>
        <Td className="text-right text-neutral-400">{expanded ? "▾" : "▸"}</Td>
      </Tr>
      {expanded ? (
        <tr className="border-b border-neutral-100">
          <td colSpan={7} className="bg-neutral-50 px-6 py-5">
            <div className="space-y-4">
              <dl className="grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-3">
                <MetaRow label="Severity">
                  <span>{AUDIT_SEVERITY_META[severity].description}</span>
                </MetaRow>
                <MetaRow label="Source">
                  <span className="font-mono">{row.source}</span>
                </MetaRow>
                <MetaRow label="Request ID">
                  <span className="font-mono">{row.request_id ?? "—"}</span>
                </MetaRow>
                <MetaRow label="Entity ID">
                  <span className="font-mono">{row.entity_id}</span>
                </MetaRow>
                <MetaRow label="Actor user">
                  <span className="font-mono">{row.actor_user_id ?? "system"}</span>
                </MetaRow>
                <MetaRow label="Actor membership">
                  <span className="font-mono">{row.actor_membership_id ?? "—"}</span>
                </MetaRow>
              </dl>

              {row.changed_columns && row.changed_columns.length > 0 ? (
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Changed columns
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {row.changed_columns.map((c) => (
                      <Badge key={c} tone="info" className="font-mono">
                        {c}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <DiffCard label="Before" tone="error" data={row.before_data} />
                <DiffCard label="After" tone="success" data={row.after_data} />
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <dt className="shrink-0 font-medium uppercase tracking-wide text-neutral-400">{label}</dt>
      <dd className="min-w-0 truncate text-neutral-700">{children}</dd>
    </div>
  );
}

function DiffCard({
  label,
  tone,
  data,
}: {
  label: string;
  tone: "error" | "success";
  data: unknown;
}) {
  const dotClass = tone === "error" ? "bg-status-error-400" : "bg-status-positive-400";
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-2">
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {label}
        </span>
      </div>
      <pre className="max-h-80 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed text-neutral-700">
        {data ? JSON.stringify(data, null, 2) : "—"}
      </pre>
    </Card>
  );
}

function ActionBadge({ action }: { action: string }) {
  const tone: BadgeTone =
    action === "insert"
      ? "success"
      : action === "update"
        ? "warning"
        : action === "delete"
          ? "error"
          : "neutral";
  return <Badge tone={tone}>{humanize(action)}</Badge>;
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${
        active
          ? "bg-brand-600 text-white"
          : "border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50"
      }`}
    >
      {label}
    </button>
  );
}

// ─────────────────────────── CSV helpers ───────────────────────────

const CSV_HEADERS = [
  "created_at",
  "severity",
  "action",
  "entity_type",
  "entity_id",
  "actor_user_id",
  "actor_membership_id",
  "source",
  "request_id",
  "changed_columns",
] as const;

/** RFC-4180 field quoting: wrap in quotes, double any embedded quote. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function buildCsv(rows: AuditEventRow[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) {
    const cells = [
      r.created_at,
      auditEventSeverity(r.action, r.entity_type),
      r.action,
      r.entity_type,
      r.entity_id,
      r.actor_user_id ?? "",
      r.actor_membership_id ?? "",
      r.source,
      r.request_id ?? "",
      (r.changed_columns ?? []).join("; "),
    ];
    lines.push(cells.map((c) => csvField(String(c))).join(","));
  }
  return lines.join("\r\n");
}

function downloadCsv(csv: string, filename: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** snake_case → "Sentence case". */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function absolute(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${Math.max(sec, 0)}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
