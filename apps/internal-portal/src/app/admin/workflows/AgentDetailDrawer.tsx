"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import type { AgentListRow } from "@hireops/api-types";
import {
  Badge,
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
 *
 * DESIGN-03: at the DESIGN-02 drawer quality bar — shadow-3 floating panel,
 * Esc-to-close + backdrop-close, a clean icon close button, sectioned body.
 * The action list reads as a pipeline: each step carries its approval-rule
 * badge (draft → gate → send), and run history is a TableShell with status
 * Badges.
 */
export function AgentDetailDrawer({
  agent,
  onClose,
}: {
  agent: AgentListRow;
  onClose: () => void;
}) {
  const detail = trpc.getAgentDetail.useQuery({ agentId: agent.id }, { staleTime: 5_000 });

  // Esc-to-close + body scroll lock while open (matches the triage drawer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const rulesByActionId = new Map((detail.data?.approvalRules ?? []).map((r) => [r.action_id, r]));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Agent detail"
      className="fixed inset-0 z-modal flex justify-end"
    >
      <button
        type="button"
        aria-label="Close detail"
        onClick={onClose}
        className="absolute inset-0 bg-neutral-900/40 transition-opacity"
      />
      <aside className="relative ml-auto flex h-full w-[52vw] max-w-xl flex-col overflow-hidden bg-neutral-50 shadow-3">
        {/* Header */}
        <header className="flex items-start justify-between gap-4 border-b border-neutral-200 bg-white px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold tracking-tight text-neutral-900">
              {agent.name}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Badge tone="accent">{humanize(agent.agent_type)}</Badge>
              <Badge tone="neutral">v{agent.version}</Badge>
              <Badge tone={agent.enabled ? "success" : "neutral"}>
                {agent.enabled ? "Enabled" : "Paused"}
              </Badge>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {detail.isLoading ? (
            <p className="text-sm text-neutral-500">Loading detail…</p>
          ) : detail.isError || !detail.data ? (
            <p className="text-sm text-status-error-700">
              Couldn&rsquo;t load this agent&rsquo;s detail.
            </p>
          ) : (
            <>
              {detail.data.agent.description ? (
                <p className="text-sm text-neutral-700">{detail.data.agent.description}</p>
              ) : null}

              {/* Triggers */}
              <Section title="Trigger">
                {detail.data.triggers.length === 0 ? (
                  <Card>
                    <Empty>No triggers configured.</Empty>
                  </Card>
                ) : (
                  <ul className="space-y-3">
                    {detail.data.triggers.map((t) => (
                      <li key={t.id}>
                        <Card padded={false} className="overflow-hidden">
                          <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-2.5">
                            <Badge tone="info">{humanize(t.trigger_type)}</Badge>
                          </div>
                          <ConfigBlock value={t.trigger_config} />
                        </Card>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* Actions + attached approval rules — the pipeline. */}
              <Section title="Actions">
                {detail.data.actions.length === 0 ? (
                  <Card>
                    <Empty>No actions configured.</Empty>
                  </Card>
                ) : (
                  <ol className="space-y-3">
                    {detail.data.actions.map((a) => {
                      const rule = rulesByActionId.get(a.id);
                      return (
                        <li key={a.id}>
                          <Card padded={false} className="overflow-hidden">
                            <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-4 py-2.5">
                              <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-neutral-800">
                                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[11px] font-semibold tabular-nums text-neutral-500">
                                  {a.action_order}
                                </span>
                                <span className="truncate font-mono text-xs">{a.action_type}</span>
                              </span>
                              <ApprovalBadge
                                mode={rule?.approval_mode ?? null}
                                role={rule?.approver_role ?? null}
                              />
                            </div>
                            <ConfigBlock value={a.action_config} />
                          </Card>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </Section>

              {/* Recent runs */}
              <Section title="Run history">
                {detail.data.recentRuns.length === 0 ? (
                  <Card padded={false}>
                    <EmptyState
                      title="No runs yet"
                      hint="Runs appear here once this agent fires."
                    />
                  </Card>
                ) : (
                  <TableShell>
                    <Thead>
                      <Th>Status</Th>
                      <Th>Triggered by</Th>
                      <Th>Triggered at</Th>
                      <Th>Completed</Th>
                    </Thead>
                    <Tbody>
                      {detail.data.recentRuns.map((run) => (
                        <Tr key={run.id}>
                          <Td>
                            <RunStatusBadge status={run.status} />
                            {run.error ? (
                              <span
                                className="ml-2 truncate align-middle text-xs text-status-error-700"
                                title={run.error}
                              >
                                {run.error}
                              </span>
                            ) : null}
                          </Td>
                          <Td className="text-neutral-600">{run.triggered_by}</Td>
                          <Td className="tabular-nums text-neutral-600">
                            {run.triggered_at.slice(0, 16).replace("T", " ")}
                          </Td>
                          <Td className="tabular-nums text-neutral-600">
                            {run.completed_at
                              ? run.completed_at.slice(0, 16).replace("T", " ")
                              : "—"}
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </TableShell>
                )}
              </Section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-xs text-neutral-400">{children}</p>;
}

function ConfigBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <p className="px-4 py-2.5 text-[11px] text-neutral-400">no config</p>;
  }
  return (
    <pre className="overflow-x-auto px-4 py-2.5 font-mono text-[11px] leading-relaxed text-neutral-700">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ApprovalBadge({ mode, role }: { mode: string | null; role: string | null }) {
  if (!mode) {
    return <Badge tone="neutral">no rule · auto</Badge>;
  }
  const tone: BadgeTone =
    mode === "human_required" ? "warning" : mode === "human_optional" ? "info" : "success";
  return (
    <Badge tone={tone}>
      {humanize(mode)}
      {role ? ` · ${role}` : ""}
    </Badge>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const tone: BadgeTone =
    status === "completed"
      ? "success"
      : status === "failed" || status === "rejected"
        ? "error"
        : status === "awaiting_approval"
          ? "warning"
          : "neutral";
  return <Badge tone={tone}>{humanize(status)}</Badge>;
}

/** snake_case → "Sentence case". */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
