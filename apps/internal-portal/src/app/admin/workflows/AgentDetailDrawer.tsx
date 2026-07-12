"use client";

import type { AgentListRow } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";

/**
 * Right-side drawer showing one agent's full definition via
 * getAgentDetail: its triggers (type + config), the ordered action
 * pipeline with each action's approval rule attached, and the recent
 * run history. Read-only — the only mutation on this surface is the
 * enable/disable toggle in the list.
 *
 * Local-state driven (no URL routing) — use-drawer-routing is triage's
 * candidateId/applicationId scheme and doesn't map onto an agentId
 * drill-in, so a plain overlay is the cheaper fit here.
 */
export function AgentDetailDrawer({
  agent,
  onClose,
}: {
  agent: AgentListRow;
  onClose: () => void;
}) {
  const detail = trpc.getAgentDetail.useQuery({ agentId: agent.id }, { staleTime: 5_000 });

  const rulesByActionId = new Map((detail.data?.approvalRules ?? []).map((r) => [r.action_id, r]));

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close detail"
        onClick={onClose}
        className="absolute inset-0 bg-neutral-900/30"
      />
      {/* Panel */}
      <aside className="relative z-50 flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-neutral-200 bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-neutral-200 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-neutral-900">{agent.name}</h2>
            <p className="text-xs text-neutral-500">
              {agent.agent_type} · v{agent.version} · {agent.enabled ? "enabled" : "paused"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-4 rounded-md px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
          >
            Close
          </button>
        </div>

        <div className="flex-1 space-y-6 px-6 py-5">
          {detail.isLoading ? (
            <p className="text-sm text-neutral-500">Loading detail…</p>
          ) : detail.isError || !detail.data ? (
            <p className="text-sm text-status-error-700">Couldn’t load this agent’s detail.</p>
          ) : (
            <>
              {detail.data.agent.description ? (
                <p className="text-sm text-neutral-700">{detail.data.agent.description}</p>
              ) : null}

              {/* Triggers */}
              <Section title="Triggers">
                {detail.data.triggers.length === 0 ? (
                  <Empty>No triggers configured.</Empty>
                ) : (
                  <ul className="space-y-3">
                    {detail.data.triggers.map((t) => (
                      <li key={t.id} className="rounded-md border border-neutral-200">
                        <div className="border-b border-neutral-100 px-3 py-2 text-xs font-medium text-neutral-700">
                          {t.trigger_type}
                        </div>
                        <ConfigBlock value={t.trigger_config} />
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* Actions + attached approval rules */}
              <Section title="Actions">
                {detail.data.actions.length === 0 ? (
                  <Empty>No actions configured.</Empty>
                ) : (
                  <ol className="space-y-3">
                    {detail.data.actions.map((a) => {
                      const rule = rulesByActionId.get(a.id);
                      return (
                        <li key={a.id} className="rounded-md border border-neutral-200">
                          <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
                            <span className="text-xs font-medium text-neutral-700">
                              <span className="mr-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">
                                {a.action_order}
                              </span>
                              {a.action_type}
                            </span>
                            <ApprovalBadge
                              mode={rule?.approval_mode ?? null}
                              role={rule?.approver_role ?? null}
                            />
                          </div>
                          <ConfigBlock value={a.action_config} />
                        </li>
                      );
                    })}
                  </ol>
                )}
              </Section>

              {/* Recent runs */}
              <Section title="Recent runs">
                {detail.data.recentRuns.length === 0 ? (
                  <Empty>No runs yet.</Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="text-neutral-500">
                        <tr className="border-b border-neutral-200">
                          <th className="py-1.5 pr-3 font-medium">Status</th>
                          <th className="py-1.5 pr-3 font-medium">Triggered by</th>
                          <th className="py-1.5 pr-3 font-medium">Triggered at</th>
                          <th className="py-1.5 pr-3 font-medium">Completed</th>
                          <th className="py-1.5 font-medium">Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.data.recentRuns.map((run) => (
                          <tr key={run.id} className="border-b border-neutral-100 align-top">
                            <td className="py-1.5 pr-3">
                              <RunStatusBadge status={run.status} />
                            </td>
                            <td className="py-1.5 pr-3 text-neutral-600">{run.triggered_by}</td>
                            <td className="py-1.5 pr-3 text-neutral-600">
                              {run.triggered_at.slice(0, 16).replace("T", " ")}
                            </td>
                            <td className="py-1.5 pr-3 text-neutral-600">
                              {run.completed_at
                                ? run.completed_at.slice(0, 16).replace("T", " ")
                                : "—"}
                            </td>
                            <td className="py-1.5 text-status-error-700">{run.error ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-neutral-400">{children}</p>;
}

function ConfigBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <p className="px-3 py-2 text-[11px] text-neutral-400">no config</p>;
  }
  return (
    <pre className="overflow-x-auto px-3 py-2 text-[11px] leading-relaxed text-neutral-700">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ApprovalBadge({ mode, role }: { mode: string | null; role: string | null }) {
  if (!mode) {
    return (
      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500">
        no rule (auto)
      </span>
    );
  }
  const cls =
    mode === "human_required"
      ? "bg-amber-100 text-amber-900"
      : mode === "human_optional"
        ? "bg-status-info-100 text-status-info-800"
        : "bg-green-100 text-green-800";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {mode}
      {role ? ` · ${role}` : ""}
    </span>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const cls =
    status === "completed"
      ? "bg-green-100 text-green-800"
      : status === "failed" || status === "rejected"
        ? "bg-status-error-100 text-status-error-800"
        : status === "awaiting_approval"
          ? "bg-amber-100 text-amber-900"
          : "bg-neutral-100 text-neutral-700";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{status}</span>
  );
}
