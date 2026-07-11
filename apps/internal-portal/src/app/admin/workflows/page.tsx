import { requireAdmin } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
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
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-4">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-semibold text-neutral-900">Agent Workflows</h1>
          <a href="/triage" className="text-sm text-neutral-500 underline hover:text-neutral-900">
            Triage
          </a>
        </div>
        <a href="/logout" className="text-sm text-neutral-600 underline hover:text-neutral-900">
          Sign out
        </a>
      </header>
      <WorkflowsClient initial={initial} />
    </main>
  );
}
