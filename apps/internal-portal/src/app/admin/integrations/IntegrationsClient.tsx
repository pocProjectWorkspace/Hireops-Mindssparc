"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { ListWorkdaySyncsOutput } from "@hireops/api-types";
import {
  Badge,
  Card,
  EmptyState,
  StatTile,
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
// columns to optional — the tRPC client re-infers `unknown` zod fields as
// optional, so the prop type must accept the client's (optional) shape.
type SyncRowData = Omit<ListWorkdaySyncsOutput["rows"][number], "payload" | "simulatedResponse"> & {
  payload?: unknown;
  simulatedResponse?: unknown;
};

const STATUS_OPTIONS = ["pending", "processing", "simulated", "sent", "failed"];
const EVENT_OPTIONS = ["hire_employee"];

/**
 * The admin integration-health surface — outbound sync events to external
 * systems (currently only Workday Hire, in SIMULATED mode). Summary tiles +
 * status/event filter chips + a TableShell whose rows expand to the payload,
 * simulated response, and any error.
 *
 * DESIGN-03: the SIMULATED banner is warning-toned (informative, not alarming);
 * tiles → StatTile; rows + payload accordion in the TableShell/Card idiom with
 * status Badges.
 */
export function IntegrationsClient() {
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [eventFilter, setEventFilter] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = trpc.listWorkdaySyncs.useQuery({
    filters: {
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(eventFilter ? { eventType: eventFilter } : {}),
    },
    pagination: { limit: 50 },
  });

  const rows = query.data?.rows ?? [];
  const totals = summarise(rows);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-5 flex items-start gap-3 rounded-md border border-status-warning-200 bg-status-warning-50 px-4 py-3 text-sm text-status-warning-800">
        <span aria-hidden className="mt-0.5 shrink-0">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 1.5L15 14H1L8 1.5z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <path d="M8 6.5v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
          </svg>
        </span>
        <p>
          <strong className="font-semibold">Integration mode: Simulated</strong> — awaiting Workday
          tenant credentials. All sync events below are mock dispatches; each simulated_response
          carries an explicit notes field saying so.
        </p>
      </div>

      <ConnectorRoadmap />

      <h2 className="mb-1 text-sm font-semibold text-neutral-900">Workday Hire · sync outbox</h2>
      <p className="mb-6 text-sm text-neutral-600">
        Outbound sync events to Workday. Running in simulated mode until tenant credentials land —
        every dispatch below is a mock the connector will replay for real once wired.
      </p>

      <section className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Total events" value={totals.total.toLocaleString()} />
        <StatTile label="Simulated" value={totals.simulated.toLocaleString()} tone="positive" />
        <StatTile label="Pending" value={totals.pending.toLocaleString()} tone="info" />
        <StatTile
          label="Failed"
          value={totals.failed.toLocaleString()}
          tone={totals.failed > 0 ? "error" : "neutral"}
        />
      </section>

      <section className="mb-4 flex flex-wrap items-center gap-2">
        <FilterChip
          label="All statuses"
          active={statusFilter === null}
          onClick={() => setStatusFilter(null)}
        />
        {STATUS_OPTIONS.map((s) => (
          <FilterChip
            key={s}
            label={humanize(s)}
            active={statusFilter === s}
            onClick={() => setStatusFilter(s)}
          />
        ))}
        <span aria-hidden className="mx-1 h-4 w-px bg-neutral-200" />
        <FilterChip
          label="All events"
          active={eventFilter === null}
          onClick={() => setEventFilter(null)}
        />
        {EVENT_OPTIONS.map((e) => (
          <FilterChip
            key={e}
            label={humanize(e)}
            active={eventFilter === e}
            onClick={() => setEventFilter(e)}
          />
        ))}
      </section>

      {query.isLoading ? (
        <Card>
          <p className="text-sm text-neutral-500">Loading…</p>
        </Card>
      ) : rows.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title="No events match the current filters"
            hint="Sync events appear here as hires are dispatched to Workday."
          />
        </Card>
      ) : (
        <TableShell>
          <Thead>
            <Th>Event</Th>
            <Th>Business key</Th>
            <Th>Status</Th>
            <Th>Created</Th>
            <Th className="w-8" aria-label="Expand" />
          </Thead>
          <Tbody>
            {rows.map((row) => (
              <SyncRow
                key={row.id}
                row={row}
                expanded={expanded === row.id}
                onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
              />
            ))}
          </Tbody>
        </TableShell>
      )}
    </div>
  );
}

/**
 * The connector roadmap (AD9) — an honest, labelled inventory of every
 * integration seam. Nothing here is faked as live: email (Resend) is genuinely
 * wired and sending; Workday is built but simulated (awaiting credentials);
 * the meeting/calendar connectors are declared post-deal work packages, marked
 * Deferred. This is the same "seam is built, the connector is a work package"
 * story the Workday sync tells — stated plainly so nobody mistakes a roadmap
 * item for a shipped one.
 */
type ConnectorStatus = "live" | "simulated" | "deferred";

interface Connector {
  name: string;
  detail: string;
  status: ConnectorStatus;
  note: string;
}

const CONNECTORS: Connector[] = [
  {
    name: "Email",
    detail: "Resend",
    status: "live",
    note: "Real transactional email — candidate confirmations, agent follow-ups, notifications. (Test mode caps delivery to the demo inbox.)",
  },
  {
    name: "Workday — Hire",
    detail: "HR system of record",
    status: "simulated",
    note: "Outbound hire events are built and queued below in simulated mode. Flips to live dispatch the moment tenant Workday credentials are provisioned.",
  },
  {
    name: "Microsoft Teams",
    detail: "Interview video",
    status: "deferred",
    note: "Live interview links + join telemetry. Post-deal connector work package — not built; scheduling today records the meeting details manually.",
  },
  {
    name: "Zoom",
    detail: "Interview video",
    status: "deferred",
    note: "Alternative video provider. Post-deal connector work package — not built.",
  },
  {
    name: "Calendar",
    detail: "Google / Outlook",
    status: "deferred",
    note: "Two-way availability + invite sync for panel scheduling. Post-deal connector work package — not built.",
  },
];

const CONNECTOR_STATUS_META: Record<
  ConnectorStatus,
  { label: string; tone: BadgeTone; dot: string }
> = {
  live: { label: "Live", tone: "success", dot: "bg-status-success-500" },
  simulated: { label: "Simulated", tone: "warning", dot: "bg-status-warning-500" },
  deferred: { label: "Deferred", tone: "neutral", dot: "bg-neutral-400" },
};

function ConnectorRoadmap() {
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-sm font-semibold text-neutral-900">Connectors</h2>
      <p className="mb-4 text-sm text-neutral-600">
        Every integration seam and its honest status. Live connectors are sending real traffic;
        deferred ones are post-deal work packages, not shipped features.
      </p>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CONNECTORS.map((c) => {
          const meta = CONNECTOR_STATUS_META[c.status];
          return (
            <li key={c.name}>
              <Card className="h-full">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                    <div>
                      <p className="text-sm font-semibold text-neutral-900">{c.name}</p>
                      <p className="text-xs text-neutral-500">{c.detail}</p>
                    </div>
                  </div>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </div>
                <p className="mt-2.5 text-xs leading-relaxed text-neutral-600">{c.note}</p>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SyncRow({
  row,
  expanded,
  onToggle,
}: {
  row: SyncRowData;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <Tr onClick={onToggle} className="cursor-pointer" aria-expanded={expanded}>
        <Td className="font-mono text-xs text-neutral-700">{row.eventType}</Td>
        <Td className="max-w-[16rem] truncate font-mono text-xs text-neutral-500">
          {row.businessKey}
        </Td>
        <Td>
          <StatusBadge status={row.status} />
        </Td>
        <Td className="whitespace-nowrap tabular-nums text-xs text-neutral-500">
          {row.createdAt.slice(0, 16).replace("T", " ")}
        </Td>
        <Td className="text-right text-neutral-400">{expanded ? "▾" : "▸"}</Td>
      </Tr>
      {expanded ? (
        <tr className="border-b border-neutral-100">
          <td colSpan={5} className="bg-neutral-50 px-6 py-5">
            <div className="space-y-4">
              <PayloadBlock label="Payload" value={row.payload} />
              {row.simulatedResponse ? (
                <PayloadBlock label="Simulated response" value={row.simulatedResponse} />
              ) : null}
              {row.lastError ? (
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Last error
                  </p>
                  <p className="rounded-md bg-status-error-50 px-3 py-2 text-xs text-status-error-800">
                    {row.lastError}
                  </p>
                </div>
              ) : null}
              <p className="text-xs text-neutral-500">
                Attempts: <span className="tabular-nums text-neutral-700">{row.attemptCount}</span>{" "}
                · Simulated at:{" "}
                <span className="tabular-nums text-neutral-700">
                  {row.simulatedAt ? row.simulatedAt.slice(0, 16).replace("T", " ") : "—"}
                </span>
              </p>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function PayloadBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </p>
      <Card padded={false}>
        <pre className="max-h-80 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed text-neutral-700">
          {JSON.stringify(value, null, 2)}
        </pre>
      </Card>
    </div>
  );
}

interface Totals {
  total: number;
  simulated: number;
  pending: number;
  failed: number;
}

function summarise(rows: { status: string }[]): Totals {
  const t: Totals = { total: rows.length, simulated: 0, pending: 0, failed: 0 };
  for (const r of rows) {
    if (r.status === "simulated" || r.status === "sent") t.simulated += 1;
    else if (r.status === "pending" || r.status === "processing") t.pending += 1;
    else if (r.status === "failed") t.failed += 1;
  }
  return t;
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

function StatusBadge({ status }: { status: string }): ReactNode {
  const tone: BadgeTone =
    status === "simulated" || status === "sent"
      ? "success"
      : status === "pending" || status === "processing"
        ? "info"
        : status === "failed"
          ? "error"
          : "neutral";
  return <Badge tone={tone}>{humanize(status)}</Badge>;
}

/** snake_case → "Sentence case". */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
