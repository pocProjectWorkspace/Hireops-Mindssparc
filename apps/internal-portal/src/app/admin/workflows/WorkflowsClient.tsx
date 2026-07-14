"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentListRow, ListAgentsOutput } from "@hireops/api-types";
import { Avatar, Badge, Card, EmptyState, SkeletonRows } from "@/components/ui";
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
 *
 * DESIGN-03: each agent is a Card — an identity glyph + accent type Badge,
 * the name prominent, description secondary, a labelled stat trio (version /
 * runs / pending) in tabular-nums, and the refined enabled toggle at right.
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
        <SkeletonRows count={3} />
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
              <Card className="transition-colors hover:border-neutral-300">
                <div className="flex items-start justify-between gap-4">
                  <button
                    type="button"
                    onClick={() => setSelectedId(agent.id)}
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
                          {agent.enabled ? null : <Badge tone="neutral">Paused</Badge>}
                        </div>
                        {agent.description ? (
                          <p className="mt-0.5 truncate text-xs text-neutral-500">
                            {agent.description}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 pl-[52px]">
                      <Stat label="Version" value={`v${agent.version}`} />
                      <Stat label="Runs" value={agent.total_runs.toLocaleString()} />
                      <Stat label="Pending" value={agent.pending_approval_count.toLocaleString()} />
                      <Stat
                        label="Last run"
                        value={
                          agent.last_run_at ? agent.last_run_at.slice(0, 16).replace("T", " ") : "—"
                        }
                      />
                      <span className="text-xs font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
                        View detail →
                      </span>
                    </div>
                  </button>

                  <div className="shrink-0 pt-1">
                    <Toggle
                      enabled={agent.enabled}
                      busy={pendingToggleId === agent.id}
                      onToggle={() => onToggle(agent)}
                      label={`${agent.enabled ? "Disable" : "Enable"} ${agent.name}`}
                    />
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {selected ? <AgentDetailDrawer agent={selected} onClose={() => setSelectedId(null)} /> : null}
    </div>
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

/** snake_case agent_type → "Sentence case". */
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
