"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";

const STATUS_OPTIONS = ["pending", "processing", "simulated", "sent", "failed"];
const EVENT_OPTIONS = ["hire_employee"];

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
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>Integration mode: SIMULATED</strong> — awaiting Workday tenant credentials.
        All sync events below are mock dispatches; the simulated_response carries an explicit
        notes field saying so.
      </div>

      <p className="mb-6 text-sm text-neutral-600">
        Outbound sync events to external systems. Currently only Workday Hire is wired.
      </p>

      <section className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label="Total events" value={totals.total} />
        <Tile label="Simulated" value={totals.simulated} tone="success" />
        <Tile label="Pending" value={totals.pending} tone="info" />
        <Tile label="Failed" value={totals.failed} tone={totals.failed > 0 ? "warning" : "neutral"} />
      </section>

      <section className="mb-4 flex flex-wrap gap-2">
        <FilterChip label="all statuses" active={statusFilter === null} onClick={() => setStatusFilter(null)} />
        {STATUS_OPTIONS.map((s) => (
          <FilterChip
            key={s}
            label={s}
            active={statusFilter === s}
            onClick={() => setStatusFilter(s)}
          />
        ))}
        <span className="mx-2 text-neutral-300">|</span>
        <FilterChip label="all events" active={eventFilter === null} onClick={() => setEventFilter(null)} />
        {EVENT_OPTIONS.map((e) => (
          <FilterChip
            key={e}
            label={e}
            active={eventFilter === e}
            onClick={() => setEventFilter(e)}
          />
        ))}
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white">
        {query.isLoading ? (
          <p className="p-6 text-sm text-neutral-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-neutral-500">No events match the current filters.</p>
        ) : (
          <ul>
            {rows.map((row) => (
              <li key={row.id} className="border-b border-neutral-100 last:border-0">
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                  className="grid w-full grid-cols-12 items-center gap-3 px-4 py-3 text-left text-sm hover:bg-neutral-50"
                >
                  <span className="col-span-3 font-mono text-xs text-neutral-700">
                    {row.eventType}
                  </span>
                  <span className="col-span-4 truncate font-mono text-xs text-neutral-500">
                    {row.businessKey}
                  </span>
                  <span className="col-span-2">
                    <StatusBadge status={row.status} />
                  </span>
                  <span className="col-span-2 text-xs text-neutral-500">
                    {row.createdAt.slice(0, 16).replace("T", " ")}
                  </span>
                  <span className="col-span-1 text-right text-xs text-neutral-400">
                    {expanded === row.id ? "▾" : "▸"}
                  </span>
                </button>
                {expanded === row.id ? (
                  <div className="space-y-3 bg-neutral-50 px-6 py-4 text-xs">
                    <div>
                      <p className="mb-1 font-semibold uppercase tracking-wide text-neutral-600">
                        Payload
                      </p>
                      <pre className="overflow-x-auto rounded bg-white p-2 text-neutral-800">
                        {JSON.stringify(row.payload, null, 2)}
                      </pre>
                    </div>
                    {row.simulatedResponse ? (
                      <div>
                        <p className="mb-1 font-semibold uppercase tracking-wide text-neutral-600">
                          Simulated response
                        </p>
                        <pre className="overflow-x-auto rounded bg-white p-2 text-neutral-800">
                          {JSON.stringify(row.simulatedResponse, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                    {row.lastError ? (
                      <div>
                        <p className="mb-1 font-semibold uppercase tracking-wide text-neutral-600">
                          Last error
                        </p>
                        <p className="rounded bg-status-error-50 p-2 text-status-error-800">
                          {row.lastError}
                        </p>
                      </div>
                    ) : null}
                    <p className="text-neutral-500">
                      Attempts: {row.attemptCount} · Simulated at:{" "}
                      {row.simulatedAt ? row.simulatedAt.slice(0, 16).replace("T", " ") : "—"}
                    </p>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
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

function Tile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "info" | "success" | "warning";
}) {
  const toneClass =
    tone === "success"
      ? "border-green-200 bg-green-50 text-green-800"
      : tone === "info"
        ? "border-status-info-200 bg-status-info-50 text-status-info-800"
        : tone === "warning"
          ? "border-status-warning-200 bg-status-warning-50 text-status-warning-800"
          : "border-neutral-200 bg-white text-neutral-800";
  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <p className="text-xs uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
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

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "simulated" || status === "sent"
      ? "bg-green-100 text-green-800"
      : status === "pending" || status === "processing"
        ? "bg-status-info-100 text-status-info-800"
        : status === "failed"
          ? "bg-status-error-100 text-status-error-800"
          : "bg-neutral-100 text-neutral-800";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>
  );
}
