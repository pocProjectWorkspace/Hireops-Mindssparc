"use client";

import { useState } from "react";
import type { ListAuditEventsOutput } from "@hireops/api-types";
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
 * The admin audit-trail list — filter chips + inline diff expand + cursor
 * "Load more". Seeded from the server render (`initial`) for the default,
 * unfiltered view and kept live by a tRPC infinite query.
 *
 * The "Agent activity" preset narrows entity_type to the seven agent-runtime
 * tables (hardcoded below — the audit log is polymorphic over table names, so
 * the client owns this grouping). Action chips (insert/update/delete) narrow
 * the DML verb. Default: no filters — all activity, newest first.
 *
 * Actor is shown as the truncated actor_user_id (or "system" when null). We
 * deliberately do NOT join users / memberships for display names: their RLS
 * is self-select-only, so the join would silently null for other actors.
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

export function AuditClient({ initial }: { initial: ListAuditEventsOutput }) {
  const [agentPreset, setAgentPreset] = useState(false);
  const [actionFilter, setActionFilter] = useState<ActionFilter | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtersActive = agentPreset || actionFilter !== null;

  const input = {
    limit: 50,
    ...(agentPreset ? { entityTypes: [...AGENT_TABLES] } : {}),
    ...(actionFilter ? { action: actionFilter } : {}),
  };

  const query = trpc.listAuditEvents.useInfiniteQuery(input, {
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Seed page 1 from the server prefetch only for the default view; a
    // filtered query has a different key and fetches fresh.
    initialData: filtersActive
      ? undefined
      : { pages: [initial], pageParams: [undefined] },
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <p className="mb-6 text-sm text-neutral-600">
        Every tenant-scoped data change — proposed, approved, sent — with the before/after diff.
        Newest first. This is the audit log itself; reads here are never themselves audited.
      </p>

      <section className="mb-4 flex flex-wrap items-center gap-2">
        <FilterChip
          label="Agent activity"
          active={agentPreset}
          onClick={() => setAgentPreset((v) => !v)}
        />
        <span className="mx-1 text-neutral-300">|</span>
        <FilterChip
          label="all actions"
          active={actionFilter === null}
          onClick={() => setActionFilter(null)}
        />
        {(["insert", "update", "delete"] as ActionFilter[]).map((a) => (
          <FilterChip
            key={a}
            label={a}
            active={actionFilter === a}
            onClick={() => setActionFilter(a)}
          />
        ))}
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white">
        {query.isLoading ? (
          <p className="p-6 text-sm text-neutral-500">Loading…</p>
        ) : items.length === 0 ? (
          <p className="p-6 text-sm text-neutral-500">No audit events match.</p>
        ) : (
          <ul>
            {items.map((row) => (
              <AuditRow
                key={row.id}
                row={row}
                expanded={expandedId === row.id}
                onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
              />
            ))}
          </ul>
        )}
      </section>

      {query.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
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
  return (
    <li className="border-b border-neutral-100 last:border-0">
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-12 items-center gap-3 px-4 py-3 text-left text-sm hover:bg-neutral-50"
      >
        <span className="col-span-3 text-xs text-neutral-600">
          <span className="block text-neutral-800">{absolute(row.created_at)}</span>
          <span className="block text-neutral-400">{relative(row.created_at)}</span>
        </span>
        <span className="col-span-3">
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-mono text-[11px] font-medium text-neutral-700">
            {row.entity_type}
          </span>
        </span>
        <span className="col-span-2">
          <ActionBadge action={row.action} />
        </span>
        <span className="col-span-2 font-mono text-xs text-neutral-500">
          {row.entity_id.slice(0, 8)}…
        </span>
        <span className="col-span-1 truncate font-mono text-[11px] text-neutral-500">
          {row.actor_user_id ? `${row.actor_user_id.slice(0, 8)}…` : "system"}
        </span>
        <span className="col-span-1 text-right text-xs text-neutral-400">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded ? (
        <div className="space-y-4 bg-neutral-50 px-6 py-4 text-xs">
          <div className="flex flex-wrap gap-4 text-neutral-500">
            <span>
              source: <span className="font-mono text-neutral-700">{row.source}</span>
            </span>
            <span>
              request_id:{" "}
              <span className="font-mono text-neutral-700">{row.request_id ?? "—"}</span>
            </span>
            <span>
              actor_membership_id:{" "}
              <span className="font-mono text-neutral-700">
                {row.actor_membership_id ?? "—"}
              </span>
            </span>
          </div>

          {row.changed_columns && row.changed_columns.length > 0 ? (
            <div>
              <p className="mb-1 font-semibold uppercase tracking-wide text-neutral-600">
                Changed columns
              </p>
              <div className="flex flex-wrap gap-1.5">
                {row.changed_columns.map((c) => (
                  <span
                    key={c}
                    className="rounded-full bg-status-info-100 px-2 py-0.5 font-mono text-[11px] text-status-info-800"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1 font-semibold uppercase tracking-wide text-neutral-600">Before</p>
              <pre className="max-h-80 overflow-auto rounded bg-white p-2 text-neutral-800">
                {row.before_data ? JSON.stringify(row.before_data, null, 2) : "—"}
              </pre>
            </div>
            <div>
              <p className="mb-1 font-semibold uppercase tracking-wide text-neutral-600">After</p>
              <pre className="max-h-80 overflow-auto rounded bg-white p-2 text-neutral-800">
                {row.after_data ? JSON.stringify(row.after_data, null, 2) : "—"}
              </pre>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function ActionBadge({ action }: { action: string }) {
  const cls =
    action === "insert"
      ? "bg-green-100 text-green-800"
      : action === "update"
        ? "bg-amber-100 text-amber-900"
        : action === "delete"
          ? "bg-status-error-100 text-status-error-800"
          : "bg-neutral-100 text-neutral-800";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{action}</span>
  );
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
      className={`rounded-full px-3 py-1 text-xs ${
        active
          ? "bg-neutral-900 text-white"
          : "border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50"
      }`}
    >
      {label}
    </button>
  );
}

function absolute(iso: string): string {
  // Match the house "YYYY-MM-DD HH:MM" rendering used elsewhere.
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
