"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentListRow, ListAgentsOutput } from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { AgentDetailDrawer } from "./AgentDetailDrawer";

/**
 * The admin agent-workflows list + enable/disable toggle + detail drawer.
 *
 * Seeded from the server render (`initial`) and kept live by a React
 * Query fetch so a toggle reflows the list. Clicking a row opens a
 * right-side drawer that pulls the full definition via getAgentDetail.
 *
 * The toggle dispatches the agent_type-matching mutation
 * (toggleFollowUpAgent / toggleSchedulingAgent / toggleCandidateQaAgent).
 * All three hooks are instantiated up front (hooks can't be conditional)
 * and picked at click time. Disabled agents stay in the list by design —
 * HR can see what's paused.
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
      <p className="mb-6 text-sm text-neutral-600">
        Automation agents configured for this tenant — what the platform does automatically, with
        human-in-the-loop approval. Toggle an agent off to pause it without deleting its history.
      </p>

      {query.isLoading ? (
        <p className="rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
          Loading…
        </p>
      ) : agents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center">
          <p className="text-sm font-medium text-neutral-700">No agents configured</p>
          <p className="mt-1 text-xs text-neutral-500">
            When HR configures an automation agent, it will appear here.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {agents.map((agent) => (
            <li
              key={agent.id}
              className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-4">
                <button
                  type="button"
                  onClick={() => setSelectedId(agent.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-neutral-900">
                      {agent.name}
                    </span>
                    <AgentTypeBadge type={agent.agent_type} />
                    {agent.enabled ? null : (
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500">
                        paused
                      </span>
                    )}
                  </div>
                  {agent.description ? (
                    <p className="mt-1 truncate text-xs text-neutral-500">{agent.description}</p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-500">
                    <span>v{agent.version}</span>
                    <span>{agent.total_runs} runs</span>
                    <span>{agent.pending_approval_count} pending</span>
                    <span>
                      last run{" "}
                      {agent.last_run_at ? agent.last_run_at.slice(0, 16).replace("T", " ") : "—"}
                    </span>
                    <span className="text-brand-600 underline">View detail →</span>
                  </div>
                </button>

                <div className="shrink-0">
                  <Toggle
                    enabled={agent.enabled}
                    busy={pendingToggleId === agent.id}
                    onToggle={() => onToggle(agent)}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {selected ? <AgentDetailDrawer agent={selected} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}

function AgentTypeBadge({ type }: { type: string }) {
  const cls =
    type === "follow_up"
      ? "bg-status-info-100 text-status-info-800"
      : type === "scheduling"
        ? "bg-green-100 text-green-800"
        : type === "candidate_qa"
          ? "bg-amber-100 text-amber-900"
          : "bg-neutral-100 text-neutral-800";
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{type}</span>;
}

function Toggle({
  enabled,
  busy,
  onToggle,
}: {
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={onToggle}
      disabled={busy}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
        enabled ? "bg-brand-600" : "bg-neutral-300"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          enabled ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
