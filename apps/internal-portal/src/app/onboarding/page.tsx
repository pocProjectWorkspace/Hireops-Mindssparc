import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { OnboardingList } from "@/components/onboarding/OnboardingList";

export const dynamic = "force-dynamic"; // Auth-gated + reads live case state.

/**
 * The onboarding pillar's list surface — the August-demo "phase 2" screen.
 *
 * One row per accepted hire: candidate, requisition, status, geography,
 * expected start, and checklist progress. Server-renders the first
 * (unfiltered) page via the in-process tRPC caller so the screen lands with
 * data; the client OnboardingList owns the status filter and keeps the list
 * live.
 *
 * Recruiter-accessible (not admin-gated) — same visibility model as /triage
 * and /approvals: the API authorises by role, and the demo has the recruiter
 * working onboarding.
 */
export default async function OnboardingPage() {
  const session = await requireAuth();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listOnboardingCases({ limit: 100 });

  return (
    <AppShell
      title="Onboarding"
      isAdmin={session.roles.includes("admin")}
      roles={session.roles}
      active="onboarding"
      user={sessionUserChip(session)}
    >
      <OnboardingList initial={initial} />
    </AppShell>
  );
}
