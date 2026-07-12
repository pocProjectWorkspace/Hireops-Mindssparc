import { requireAdmin } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { PortalHeader } from "@/components/nav/PortalHeader";
import { WorkflowsClient } from "./WorkflowsClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live agent state.

/**
 * Admin agent-workflows surface — "HR configures what the platform does
 * automatically" (demo Act 2, steps 7–8).
 *
 * Admin-gated (requireAdmin redirects non-admins to /triage). Server-
 * prefetches the agent list via the in-process tRPC caller so the screen
 * lands with data; the client WorkflowsClient keeps it live, owns the
 * enable/disable toggle, and the getAgentDetail drill-in.
 */
export default async function WorkflowsPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listAgents();

  return (
    <main className="flex min-h-screen flex-col">
      <PortalHeader title="Agent Workflows" isAdmin active="workflows" />
      <WorkflowsClient initial={initial} />
    </main>
  );
}
