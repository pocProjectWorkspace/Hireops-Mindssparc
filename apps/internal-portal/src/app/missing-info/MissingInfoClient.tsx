"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
} from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import { RecruiterBriefDrawer } from "@/components/recruiter/RecruiterBriefDrawer";
import {
  MISSING_INFO_STATUSES,
  type ListMissingInfoOutput,
  type MissingInfoStatus,
} from "@hireops/api-types";

/**
 * RECR-03 — Missing Info Tracker (client). Stat cards + a filterable table.
 * "Required/Optional" + "Blocks Advance to <stage>" are deterministic; there is
 * no score-impact column. "Request" hits the real candidate-notification flow;
 * clicking a candidate opens the shared recruiter AI Brief drawer.
 */

const STATUS_TONE: Record<MissingInfoStatus, "neutral" | "warning" | "info" | "success"> = {
  pending: "warning",
  requested: "info",
  received: "info",
  verified: "success",
  dismissed: "neutral",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function MissingInfoClient({ initial }: { initial: ListMissingInfoOutput }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<MissingInfoStatus | "">("");
  const [search, setSearch] = useState("");
  const [drawerAppId, setDrawerAppId] = useState<string | null>(null);

  const input = useMemo(
    () => ({
      ...(status ? { status } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
    }),
    [status, search],
  );
  const isDefault = !status && !search.trim();

  const query = trpc.listMissingInfo.useQuery(input, {
    initialData: isDefault ? initial : undefined,
    placeholderData: (prev) => prev,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [["listMissingInfo"]] });
  const requestInfo = trpc.requestMissingInfo.useMutation({ onSuccess: invalidate });
  const resolve = trpc.resolveMissingInfo.useMutation({ onSuccess: invalidate });

  const data = query.data ?? initial;
  const busyKey = requestInfo.isPending
    ? `${requestInfo.variables?.applicationId}:${requestInfo.variables?.fieldKey}`
    : resolve.isPending
      ? `${resolve.variables?.applicationId}:${resolve.variables?.fieldKey}`
      : null;

  return (
    <div className="mx-auto max-w-[92rem] px-8 py-6">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          Missing Info Tracker
        </h2>
        <Badge tone="neutral">{data.rows.length} items</Badge>
      </div>
      <p className="mb-5 text-sm text-neutral-500">
        Missing info is flagged honestly. Hard gates are deterministic stage-gates — never a
        fabricated score cap.
      </p>

      {/* Stat cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Pending" value={data.stats.pending} tone="warning" />
        <StatTile label="Requested" value={data.stats.requested} tone="info" />
        <StatTile label="Received" value={data.stats.received} tone="info" />
        <StatTile label="Verified" value={data.stats.verified} tone="positive" />
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search candidate or role…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64 rounded-md border border-neutral-200 px-3 py-1.5 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-brand-400 focus:outline-none"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as MissingInfoStatus | "")}
          className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 focus:border-brand-400 focus:outline-none"
        >
          <option value="">All statuses</option>
          {MISSING_INFO_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {data.rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No missing info"
            hint="Every in-flight application has its tracked fields on file, or your filters hid them."
          />
        </Card>
      ) : (
        <TableShell>
          <Thead>
            <Th>Candidate</Th>
            <Th>Role</Th>
            <Th>Missing field</Th>
            <Th>Required</Th>
            <Th>Status</Th>
            <Th>Last contact</Th>
            <Th>Blocks advance</Th>
            <Th className="text-right">Actions</Th>
          </Thead>
          <Tbody>
            {data.rows.map((row) => {
              const key = `${row.applicationId}:${row.fieldKey}`;
              const busy = busyKey === key;
              return (
                <Tr key={key}>
                  <Td>
                    <button
                      type="button"
                      onClick={() => setDrawerAppId(row.applicationId)}
                      className="text-left font-medium text-brand-700 hover:underline"
                    >
                      {row.candidateName}
                    </button>
                    {row.candidateRef ? (
                      <p className="text-[11px] text-neutral-400">{row.candidateRef}</p>
                    ) : null}
                  </Td>
                  <Td className="text-neutral-600">{row.roleTitle}</Td>
                  <Td className="font-medium text-neutral-800">{row.fieldLabel}</Td>
                  <Td>
                    <Badge tone={row.requiredness === "required" ? "warning" : "neutral"}>
                      {row.requiredness}
                    </Badge>
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                  </Td>
                  <Td className="text-neutral-500 tabular-nums">{fmtDate(row.lastContactAt)}</Td>
                  <Td>
                    {row.blocksAdvanceLabel ? (
                      <span className="text-xs text-status-warning-800">
                        {row.blocksAdvanceLabel}
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-300">—</span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex items-center justify-end gap-2 text-xs">
                      {row.status === "pending" || row.status === "requested" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            requestInfo.mutate({
                              applicationId: row.applicationId,
                              fieldKey: row.fieldKey,
                            })
                          }
                          className="font-medium text-brand-700 hover:underline disabled:opacity-50"
                        >
                          {busy ? "…" : "Request"}
                        </button>
                      ) : null}
                      {row.status !== "verified" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            resolve.mutate({
                              applicationId: row.applicationId,
                              fieldKey: row.fieldKey,
                              action: "verified",
                            })
                          }
                          className="text-neutral-500 hover:text-neutral-800 hover:underline disabled:opacity-50"
                        >
                          Mark verified
                        </button>
                      ) : null}
                      {row.status !== "dismissed" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            resolve.mutate({
                              applicationId: row.applicationId,
                              fieldKey: row.fieldKey,
                              action: "dismissed",
                            })
                          }
                          className="text-neutral-400 hover:text-neutral-700 hover:underline disabled:opacity-50"
                        >
                          N/A
                        </button>
                      ) : null}
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </TableShell>
      )}

      <RecruiterBriefDrawer applicationId={drawerAppId} onClose={() => setDrawerAppId(null)} />
    </div>
  );
}
