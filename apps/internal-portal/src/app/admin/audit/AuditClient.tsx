"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { ListAuditEventsOutput } from "@hireops/api-types";
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
 *
 * DESIGN-03: the "AI you can audit" screen. Events sit in a TableShell with an
 * action Badge toned by DML verb, entity_type as a neutral mono Badge, actor
 * mono. Expanding a row reveals a forensic diff: a two-column Before/After
 * Card pair, changed-columns as Badge chips, metadata as a definition list.
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
    initialData: filtersActive ? undefined : { pages: [initial], pageParams: [undefined] },
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

      {query.isLoading ? (
        <Card>
          <p className="text-sm text-neutral-500">Loading…</p>
        </Card>
      ) : items.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title="No audit events match"
            hint="Clear the filters above to see all activity."
          />
        </Card>
      ) : (
        <TableShell>
          <Thead>
            <Th>When</Th>
            <Th>Entity</Th>
            <Th>Action</Th>
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
        <Td className="font-mono text-xs text-neutral-500">{row.entity_id.slice(0, 8)}…</Td>
        <Td className="font-mono text-xs text-neutral-500">
          {row.actor_user_id ? `${row.actor_user_id.slice(0, 8)}…` : "system"}
        </Td>
        <Td className="text-right text-neutral-400">{expanded ? "▾" : "▸"}</Td>
      </Tr>
      {expanded ? (
        <tr className="border-b border-neutral-100">
          <td colSpan={6} className="bg-neutral-50 px-6 py-5">
            <div className="space-y-4">
              {/* Metadata — a calm definition list. */}
              <dl className="grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-3">
                <MetaRow label="Source">
                  <span className="font-mono">{row.source}</span>
                </MetaRow>
                <MetaRow label="Request ID">
                  <span className="font-mono">{row.request_id ?? "—"}</span>
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

/** snake_case → "Sentence case". */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
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
