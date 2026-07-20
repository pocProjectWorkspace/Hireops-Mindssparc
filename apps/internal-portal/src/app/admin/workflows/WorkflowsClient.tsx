"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentListRow, ListAgentsOutput } from "@hireops/api-types";
import { Avatar, Badge, Card, EmptyState, SkeletonRows, type BadgeTone } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { AgentDetailDrawer } from "./AgentDetailDrawer";

/**
 * The admin agent-workflows list — the tenant's automation agents, each an
 * elevated card (AD8): identity glyph, type + trigger badges, the enabled
 * toggle, and a REAL observability strip (trigger type / last-run status /
 * run counts / pending approvals). Clicking a card opens the detail drawer.
 *
 * HONESTY (AD8): every metric is real. `trigger_type`, `last_run_status`,
 * `succeeded_runs`, `failed_runs` all come straight off agent_triggers /
 * agent_runs. There is deliberately NO synthetic "success %" — the prototype
 * showed invented percentages and latencies; we show the honest last-run
 * status and real terminal-outcome counts instead. Disabled agents stay in
 * the list (paused, not deleted) so HR can see what's off.
 *
 * The toggle dispatches the agent_type-matching mutation
 * (toggleFollowUpAgent / toggleSchedulingAgent / toggleCandidateQaAgent).
 * All three hooks are instantiated up front (hooks can't be conditional) and
 * picked at click time.
 */
export function WorkflowsClient({ initial }: { initial: ListAgentsOutput }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingToggleId, setPendingToggleId] = useState<string | null>(null);

  const query = trpc.listAgents.useQuery(undefined, {
    initialData: initial,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });

  const agents = query.data?.agents ?? [];
  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const activeCount = agents.filter((a) => a.enabled).length;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [["listAgents"]] });
    queryClient.invalidateQueries({ queryKey: [["getAgentDetail"]] });
  };

  const toggleFollowUp = trpc.toggleFollowUpAgent.useMutation();
  const toggleScheduling = trpc.toggleSchedulingAgent.useMutation();
  const toggleCandidateQa = trpc.toggleCandidateQaAgent.useMutation();

  function mutationFor(agentType: string) {
    if (agentType === "scheduling") return toggleScheduling;
    if (agentType === "candidate_qa") return toggleCandidateQa;
    return toggleFollowUp;
  }

  async function onToggle(agent: AgentListRow) {
    setPendingToggleId(agent.id);
    try {
      await mutationFor(agent.agent_type).mutateAsync({
        agentId: agent.id,
        enabled: !agent.enabled,
      });
      invalidate();
    } catch (err) {
      handleTRPCError(err);
    } finally {
      setPendingToggleId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <PageHeader
        title="Workflows"
        subtitle="Automation agents for this tenant — what the platform does automatically, always with a human-in-the-loop gate. Pause an agent to stop it firing without deleting its history."
        right={
          <Badge tone={activeCount > 0 ? "success" : "neutral"}>
            {activeCount} of {agents.length} active
          </Badge>
        }
      />

      <p className="mt-3 text-xs text-neutral-500">
        Run metrics below are real — trigger type, last-run status and outcome counts come straight
        from this tenant&apos;s run history. Success rates are not estimated.
      </p>

      <div className="mt-6">
        {query.isLoading ? (
          <SkeletonRows count={3} barClassName="h-28" />
        ) : agents.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title="No agents configured"
              hint="When HR configures an automation agent, it will appear here."
            />
          </Card>
        ) : (
          <ul className="space-y-3">
            {agents.map((agent) => (
              <li key={agent.id}>
                <AgentCard
                  agent={agent}
                  busy={pendingToggleId === agent.id}
                  onOpen={() => setSelectedId(agent.id)}
                  onToggle={() => onToggle(agent)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected ? <AgentDetailDrawer agent={selected} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}

function AgentCard({
  agent,
  busy,
  onOpen,
  onToggle,
}: {
  agent: AgentListRow;
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  return (
    <Card className="transition-colors hover:border-neutral-300">
      <div className="flex items-start justify-between gap-4">
        <button
          type="button"
          onClick={onOpen}
          className="group -m-2 min-w-0 flex-1 rounded-md p-2 text-left transition-colors hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        >
          <div className="flex items-center gap-3">
            <Avatar name={agent.name} seed={agent.id} size="md" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-semibold text-neutral-900">
                  {agent.name}
                </span>
                <Badge tone="accent">{humanize(agent.agent_type)}</Badge>
                {agent.trigger_type ? (
                  <Badge tone="info">{triggerLabel(agent.trigger_type)}</Badge>
                ) : null}
                {agent.enabled ? null : <Badge tone="neutral">Paused</Badge>}
              </div>
              {agent.description ? (
                <p className="mt-0.5 truncate text-xs text-neutral-500">{agent.description}</p>
              ) : null}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 pl-[52px]">
            <StatWithBadge label="Last run">
              {agent.last_run_status ? (
                <RunStatusBadge status={agent.last_run_status} />
              ) : (
                <span className="text-sm font-medium text-neutral-400">Never run</span>
              )}
              {agent.last_run_at ? (
                <span className="text-xs tabular-nums text-neutral-400">
                  {agent.last_run_at.slice(0, 16).replace("T", " ")}
                </span>
              ) : null}
            </StatWithBadge>
            <Stat label="Runs" value={runOutcomeSummary(agent)} />
            <Stat label="Pending" value={agent.pending_approval_count.toLocaleString()} />
            <Stat label="Version" value={`v${agent.version}`} />
            <span className="text-xs font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
              View detail →
            </span>
          </div>
        </button>

        <div className="shrink-0 pt-1">
          <Toggle
            enabled={agent.enabled}
            busy={busy}
            onToggle={onToggle}
            label={`${agent.enabled ? "Disable" : "Enable"} ${agent.name}`}
          />
        </div>
      </div>
    </Card>
  );
}

/** A labelled numeric — small-caps label above a tabular value. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="text-sm font-medium tabular-nums text-neutral-800">{value}</p>
    </div>
  );
}

/** A labelled slot for a badge + optional caption (last-run status). */
function StatWithBadge({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{label}</p>
      <div className="mt-0.5 flex items-center gap-2">{children}</div>
    </div>
  );
}

/** "142 runs · 138 ok · 4 failed" — real counts, no estimated success rate. */
function runOutcomeSummary(agent: AgentListRow): string {
  if (agent.total_runs === 0) return "0";
  const parts = [`${agent.total_runs.toLocaleString()} total`];
  if (agent.succeeded_runs > 0) parts.push(`${agent.succeeded_runs.toLocaleString()} ok`);
  if (agent.failed_runs > 0) parts.push(`${agent.failed_runs.toLocaleString()} failed`);
  return parts.join(" · ");
}

/**
 * Honest trigger label from the REAL configured trigger_type. Reflects how the
 * agent actually fires — a stage-staleness scan is periodic; a stage change or
 * inbound message is event-driven.
 */
function triggerLabel(triggerType: string): string {
  switch (triggerType) {
    case "stage_stale":
      return "Scheduled scan";
    case "time_scheduled":
      return "Scheduled";
    case "stage_entered":
      return "On stage change";
    case "message_received":
      return "On message";
    case "manual":
      return "Manual";
    default:
      return humanize(triggerType);
  }
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

function Toggle({
  enabled,
  busy,
  onToggle,
  label,
}: {
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={onToggle}
      disabled={busy}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed disabled:opacity-50 ${
        enabled ? "bg-brand-600" : "bg-neutral-300"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-1 transition-transform ${
          enabled ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
