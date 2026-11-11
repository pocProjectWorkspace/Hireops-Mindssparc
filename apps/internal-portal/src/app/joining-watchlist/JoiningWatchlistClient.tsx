"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { JoiningWatchlistRow, ListJoiningWatchlistOutput } from "@hireops/api-types";
import { Badge, Card, EmptyState, TableShell, Tbody, Td, Th, Thead, Tr, cn } from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc } from "@/lib/trpc-client";

/**
 * PC-16 — watchlist table. Sortable by the facts (joining date, days to join,
 * last contact, open signals, missed check-ins); filterable by business unit,
 * "has open signals", "last check-in not Yes" and free text. Nothing here is
 * a score — sorting by "open signals" counts things the candidate said.
 */

type SortKey = "joining" | "lastSent" | "lastReceived" | "signals" | "missed" | "name";

const PULSE_LABEL: Record<string, string> = { yes: "Yes", unsure: "Not sure", no: "No" };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function fmtDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function cmp(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export function JoiningWatchlistClient({
  initial,
  canConfigure,
}: {
  initial: ListJoiningWatchlistOutput;
  canConfigure: boolean;
}) {
  const q = trpc.listJoiningWatchlist.useQuery({}, { initialData: initial });
  const data = q.data ?? initial;
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "joining", dir: 1 });
  const [bu, setBu] = useState("");
  const [onlySignals, setOnlySignals] = useState(false);
  const [notYes, setNotYes] = useState(false);
  const [text, setText] = useState("");

  const businessUnits = useMemo(
    () => [...new Set(data.rows.map((r) => r.businessUnit).filter((b): b is string => !!b))].sort(),
    [data.rows],
  );

  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    const filtered = data.rows.filter(
      (r) =>
        (!bu || r.businessUnit === bu) &&
        (!onlySignals || r.openSignals.length > 0) &&
        (!notYes || (r.lastPulseAnswer !== null && r.lastPulseAnswer !== "yes")) &&
        (!t || `${r.candidateName} ${r.role}`.toLowerCase().includes(t)),
    );
    const by: Record<SortKey, (a: JoiningWatchlistRow, b: JoiningWatchlistRow) => number> = {
      joining: (a, b) => a.joiningDate.localeCompare(b.joiningDate),
      lastSent: (a, b) => cmp(a.lastSentAt, b.lastSentAt),
      lastReceived: (a, b) => cmp(a.lastReceivedAt, b.lastReceivedAt),
      signals: (a, b) => a.openSignals.length - b.openSignals.length,
      missed: (a, b) => a.missedPulses - b.missedPulses,
      name: (a, b) => a.candidateName.localeCompare(b.candidateName),
    };
    return [...filtered].sort((a, b) => by[sort.key](a, b) * sort.dir);
  }, [data.rows, bu, onlySignals, notYes, text, sort]);

  const header = (key: SortKey, label: string, numeric = false) => (
    <Th numeric={numeric}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-neutral-900"
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((s.dir * -1) as 1 | -1) : 1 }))}
      >
        {label}
        {sort.key === key ? <span aria-hidden>{sort.dir === 1 ? "▲" : "▼"}</span> : null}
      </button>
    </Th>
  );

  return (
    <PageContainer className="space-y-4">
      {!data.engagementEnabled ? (
        <Card className="border-status-warning-200 bg-status-warning-50 text-sm text-status-warning-800">
          Pre-joining engagement is off for this organisation, so no check-ins are being sent.
          Accepted candidates are still listed.{" "}
          {canConfigure ? (
            <Link href="/admin/pre-joining" className="underline">
              Turn it on
            </Link>
          ) : (
            "An admin or TA lead can turn it on."
          )}
        </Card>
      ) : null}

      <p className="text-sm text-neutral-600">
        Candidates who accepted an offer and have not joined yet. Every column is a fact — what was
        sent, what they replied, what they answered. Signals are things the candidate said, shown in
        their words; nothing here predicts who will join.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search name or role"
          className="h-9 w-56 rounded-md border border-neutral-200 px-3 text-sm"
        />
        <select
          value={bu}
          onChange={(e) => setBu(e.target.value)}
          className="h-9 rounded-md border border-neutral-200 px-2 text-sm"
          aria-label="Business unit"
        >
          <option value="">All business units</option>
          {businessUnits.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={onlySignals}
            onChange={(e) => setOnlySignals(e.target.checked)}
          />
          Has open signals
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input type="checkbox" checked={notYes} onChange={(e) => setNotYes(e.target.checked)} />
          Last check-in not "Yes"
        </label>
        <span className="ml-auto text-xs text-neutral-500">
          {rows.length} of {data.rows.length}
        </span>
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No one on the watchlist"
            hint="Candidates appear here once they accept an offer, until their joining date."
          />
        </Card>
      ) : (
        <TableShell>
          <table className="w-full text-sm">
            <Thead>
              <tr>
                {header("name", "Candidate")}
                <Th>Role · BU</Th>
                {header("joining", "Joining")}
                {header("lastSent", "Last sent")}
                {header("lastReceived", "Last reply")}
                <Th>Last check-in</Th>
                {header("signals", "Open signals")}
                {header("missed", "Missed check-ins", true)}
              </tr>
            </Thead>
            <Tbody>
              {rows.map((r) => (
                <Tr key={r.applicationId}>
                  <Td>
                    <Link
                      href={`/joining-watchlist/${r.applicationId}`}
                      className="font-medium text-neutral-900 hover:underline"
                    >
                      {r.candidateName}
                    </Link>
                    {r.recruiterName ? (
                      <div className="text-xs text-neutral-500">{r.recruiterName}</div>
                    ) : null}
                  </Td>
                  <Td>
                    <div>{r.role}</div>
                    <div className="text-xs text-neutral-500">{r.businessUnit ?? "—"}</div>
                  </Td>
                  <Td>
                    <div>{fmtDay(r.joiningDate)}</div>
                    <div className="text-xs text-neutral-500">
                      {r.daysToJoining >= 0
                        ? `in ${r.daysToJoining} days`
                        : `${-r.daysToJoining} days ago`}
                    </div>
                  </Td>
                  <Td>{fmtDate(r.lastSentAt)}</Td>
                  <Td>{fmtDate(r.lastReceivedAt)}</Td>
                  <Td>
                    {r.lastPulseAnswer ? (
                      <Badge
                        tone={
                          r.lastPulseAnswer === "yes"
                            ? "success"
                            : r.lastPulseAnswer === "no"
                              ? "error"
                              : "warning"
                        }
                      >
                        {PULSE_LABEL[r.lastPulseAnswer]} · {fmtDate(r.lastPulseAt)}
                      </Badge>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {r.openSignals.length === 0 ? (
                        <span className="text-neutral-400">—</span>
                      ) : (
                        r.openSignals.map((s) => (
                          <span
                            key={s.id}
                            title={s.quote ? `“${s.quote}”` : undefined}
                            className="rounded-full bg-status-warning-50 px-2 py-0.5 text-[11px] font-medium text-status-warning-800"
                          >
                            {s.label}
                          </span>
                        ))
                      )}
                    </div>
                  </Td>
                  <Td numeric>
                    <span
                      className={cn(r.missedPulses > 0 && "font-medium text-status-warning-800")}
                    >
                      {r.missedPulses}
                    </span>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </table>
        </TableShell>
      )}

      {data.reneged.length > 0 ? (
        <section className="space-y-2 pt-4">
          <h2 className="text-sm font-semibold text-neutral-900">Reneged (history)</h2>
          <TableShell>
            <table className="w-full text-sm">
              <Thead>
                <tr>
                  <Th>Candidate</Th>
                  <Th>Role · BU</Th>
                  <Th>Was joining</Th>
                  <Th>Reason</Th>
                  <Th>Recorded</Th>
                </tr>
              </Thead>
              <Tbody>
                {data.reneged.map((r) => (
                  <Tr key={r.applicationId}>
                    <Td>
                      <Link
                        href={`/joining-watchlist/${r.applicationId}`}
                        className="hover:underline"
                      >
                        {r.candidateName}
                      </Link>
                    </Td>
                    <Td>
                      {r.role}
                      <div className="text-xs text-neutral-500">{r.businessUnit ?? "—"}</div>
                    </Td>
                    <Td>{r.joiningDate ? fmtDay(r.joiningDate) : "—"}</Td>
                    <Td>
                      {r.reasonLabel}
                      {r.notes ? <div className="text-xs text-neutral-500">{r.notes}</div> : null}
                    </Td>
                    <Td>{fmtDate(r.recordedAt)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </table>
          </TableShell>
        </section>
      ) : null}
    </PageContainer>
  );
}
