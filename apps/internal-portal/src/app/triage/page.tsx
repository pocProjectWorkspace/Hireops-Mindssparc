import { requireAuth } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { PortalHeader } from "@/components/nav/PortalHeader";
import { UndoToastProvider } from "@/components/triage/UndoToastProvider";
import { FilterChipsBar } from "@/components/triage/FilterChipsBar";
import { HotZone } from "@/components/triage/HotZone";
import { MomentumFeed } from "@/components/triage/MomentumFeed";
import { CandidateDetailDrawer } from "@/components/triage/CandidateDetailDrawer";

export const dynamic = "force-dynamic"; // Auth-gated + reads searchParams.

/**
 * Module 1b — the real recruiter triage screen.
 *
 * Server-renders two parallel listCandidates calls (Hot Zone for SLA
 * breaches; Momentum Feed for fresh applications sorted by AI score)
 * via Promise.all so the page lands with data — no client-side
 * loading flash on first paint.
 *
 * Client components downstream re-fetch via React Query when filter
 * chips change (URL-driven state). The drawer mounts/unmounts off
 * ?candidateId; everything else (toast, filters) is sibling to it.
 *
 * The UndoToastProvider must wrap both the list (which fires
 * mutations) and the toast itself; placing it at the top of /triage
 * keeps that contract local — Module 1a's RootErrorBoundary +
 * TRPCProvider stay in the global layout.
 */
export default async function TriagePage() {
  const session = await requireAuth();
  const caller = createServerTRPCCaller(session);

  const [breaches, momentum] = await Promise.all([
    caller.listCandidates({
      filters: { slaBreachOnly: true },
      pagination: { limit: 20 },
      sort: "sla_breach",
    }),
    caller.listCandidates({
      filters: { stage: "application_received" },
      pagination: { limit: 50 },
      sort: "ai_score_desc",
    }),
  ]);

  return (
    <UndoToastProvider>
      <main className="flex h-screen flex-col">
        <PortalHeader title="Triage" isAdmin={session.roles.includes("admin")} active="triage" />
        <FilterChipsBar />
        <HotZone initial={breaches} />
        <MomentumFeed initial={momentum} />
        <CandidateDetailDrawer />
      </main>
    </UndoToastProvider>
  );
}
