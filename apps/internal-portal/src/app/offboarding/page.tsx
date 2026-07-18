import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { EmptyState } from "@/components/ui";
import { OffboardingList } from "@/components/offboarding/OffboardingList";

export const dynamic = "force-dynamic"; // Auth-gated + reads live case state.

/** hr_ops / people_ops / admin only — mirrors the OFFBOARD_MANAGE_ROLES gate. */
const OFFBOARD_ROLES = ["hr_ops", "people_ops", "admin"];

/**
 * The offboarding pillar's list surface — one row per departure: employee,
 * initiation type, status, notice + last working day, and clearance progress.
 * Server-renders the first (unfiltered) page via the in-process tRPC caller;
 * the client OffboardingList owns the filter and keeps the list live.
 *
 * Unlike /onboarding (recruiter-open), offboarding is HR-only. The API gates
 * every procedure; the page adds a friendly no-access state so a recruiter who
 * deep-links here sees a clear message rather than an error boundary.
 */
export default async function OffboardingPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const canAccess = isAdmin || OFFBOARD_ROLES.some((r) => session.roles.includes(r));

  if (!canAccess) {
    return (
      <AppShell
        title="Offboarding"
        isAdmin={isAdmin}
        roles={session.roles}
        active="offboarding"
        user={sessionUserChip(session)}
      >
        <div className="mx-auto w-full max-w-2xl px-8 py-16">
          <EmptyState
            title="You don't have access to offboarding"
            hint="Offboarding is managed by HR Ops and People Ops. Ask an admin if you need access."
          />
        </div>
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listOffboardingCases({ limit: 100 });

  return (
    <AppShell
      title="Offboarding"
      isAdmin={isAdmin}
      roles={session.roles}
      active="offboarding"
      user={sessionUserChip(session)}
    >
      <OffboardingList initial={initial} />
    </AppShell>
  );
}
