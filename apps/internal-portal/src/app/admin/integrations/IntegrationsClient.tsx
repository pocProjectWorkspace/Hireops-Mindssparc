"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { ListWorkdaySyncsOutput } from "@hireops/api-types";
import {
  Badge,
  Button,
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
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc } from "@/lib/trpc-client";
import { humanizeSentence } from "@/lib/labels";
import { downloadCsv } from "@/lib/csv";

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
    <PageContainer>
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
          <strong className="font-semibold">Integration mode: Simulated</strong>, awaiting Workday
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

      <HandoffExport rows={rows} />

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
    </PageContainer>
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
    note: "Real transactional email, candidate confirmations, agent follow-ups, notifications. (Test mode caps delivery to the demo inbox.)",
  },
  {
    name: "Workday, Hire",
    detail: "HR system of record",
    status: "simulated",
    note: "Outbound hire events are built and queued below in simulated mode. Flips to live dispatch the moment tenant Workday credentials are provisioned.",
  },
  {
    name: "Microsoft Teams",
    detail: "Interview video",
    status: "deferred",
    note: "Live interview links + join telemetry. Post-deal connector work package, not built; scheduling today records the meeting details manually.",
  },
  {
    name: "Zoom",
    detail: "Interview video",
    status: "deferred",
    note: "Alternative video provider. Post-deal connector work package, not built.",
  },
  {
    name: "Calendar",
    detail: "Google / Outlook",
    status: "deferred",
    note: "Two-way availability + invite sync for panel scheduling. Post-deal connector work package, not built.",
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
        <Td label="Event" className="font-mono text-xs text-neutral-700">
          {row.eventType}
        </Td>
        <Td
          label="Business key"
          className="max-w-[16rem] truncate font-mono text-xs text-neutral-500"
        >
          {row.businessKey}
        </Td>
        <Td label="Status">
          <StatusBadge status={row.status} />
        </Td>
        <Td label="Created" className="whitespace-nowrap tabular-nums text-xs text-neutral-500">
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

/**
 * PC-13 — bulk Workday handoff file. One CSV of every queued hire record,
 * narrowed by status bucket, queued-date range and/or requisition. The
 * requisition options come from the hire payloads already loaded below
 * (position.requisition_external_id + title). The server builds the CSV with
 * the platform-default Workday column list (exportWorkdayHandoffs).
 */
function HandoffExport({ rows }: { rows: SyncRowData[] }) {
  const utils = trpc.useUtils();
  const [status, setStatus] = useState<"all" | "pending" | "sent" | "failed">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [requisitionId, setRequisitionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reqOptions = requisitionOptions(rows);

  async function exportCsv() {
    setBusy(true);
    setMessage(null);
    try {
      const out = await utils.exportWorkdayHandoffs.fetch({
        status,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(requisitionId ? { requisitionId } : {}),
      });
      if (out.rowCount === 0) {
        setMessage("No handoff records match these filters.");
        return;
      }
      downloadCsv(out.filename, out.csv);
      setMessage(
        out.truncated
          ? `Downloaded the first ${out.rowCount.toLocaleString()} records. Narrow the date range for the rest.`
          : `Downloaded ${out.rowCount.toLocaleString()} record${out.rowCount === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6">
      <h3 className="text-sm font-semibold text-neutral-900">Workday handoff file</h3>
      <p className="mb-3 mt-1 text-xs text-neutral-600">
        Download the hire records handed back to Workday as one CSV (Workday-friendly column names).
        Until the live connector is wired, this file is the handoff.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs font-medium text-neutral-700">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            className="mt-1 block rounded border border-neutral-300 p-1.5 text-sm"
          >
            <option value="all">All</option>
            <option value="pending">Pending (ready)</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-neutral-700">Queued from</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 block rounded border border-neutral-300 p-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-neutral-700">Queued to</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="mt-1 block rounded border border-neutral-300 p-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-neutral-700">Requisition</span>
          <select
            value={requisitionId}
            onChange={(e) => setRequisitionId(e.target.value)}
            className="mt-1 block max-w-[16rem] rounded border border-neutral-300 p-1.5 text-sm"
          >
            <option value="">All requisitions</option>
            {reqOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void exportCsv()}>
          {busy ? "Preparing…" : "Download CSV"}
        </Button>
      </div>
      {message ? <p className="mt-2 text-xs text-neutral-600">{message}</p> : null}
    </Card>
  );
}

/** Distinct requisitions referenced by the loaded hire payloads. */
function requisitionOptions(rows: SyncRowData[]): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    if (r.eventType !== "hire_employee") continue;
    const pos = (r.payload as { position?: { requisition_external_id?: unknown; title?: unknown } })
      ?.position;
    const id =
      typeof pos?.requisition_external_id === "string" ? pos.requisition_external_id : null;
    if (!id || seen.has(id)) continue;
    const title = typeof pos?.title === "string" ? pos.title : "Requisition";
    seen.set(id, `${title} · ${id.slice(0, 8)}`);
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
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
  return humanizeSentence(value);
}
