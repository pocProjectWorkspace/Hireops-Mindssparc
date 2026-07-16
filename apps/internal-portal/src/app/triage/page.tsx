import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
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
      <AppShell
        title="Triage"
        isAdmin={session.roles.includes("admin")}
        roles={session.roles}
        active="triage"
        user={sessionUserChip(session)}
        fill
      >
        <FilterChipsBar />
        {/* UX-01: one scroll container for the whole feed. Both section
            headers pin as `sticky top-0` inside THIS scroller — the classic
            stacked-sticky-group handoff (Hot Zone pins, then Momentum pushes
            it away and pins). No per-section overflow. The filter bar above
            and the drawer (fixed) sit outside the scroller. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <HotZone initial={breaches} />
          <MomentumFeed initial={momentum} />
        </div>
        <CandidateDetailDrawer />
      </AppShell>
    </UndoToastProvider>
  );
}
