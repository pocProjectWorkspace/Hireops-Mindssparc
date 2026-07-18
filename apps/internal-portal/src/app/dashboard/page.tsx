import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { PersonaDashboard } from "@/components/dashboard/PersonaDashboard";
import { HrHeadDashboard } from "@/components/dashboard/HrHeadDashboard";

export const dynamic = "force-dynamic"; // Auth-gated, per-session data.

/**
 * DASH-01 / HRHEAD-01 — the persona landing dashboard (`/dashboard`).
 *
 * The authenticated home surface: `/` redirects here. getMyDashboard (in-process
 * caller) returns the KPI + recommended-action payload for the caller's persona.
 * HRHEAD-01: an hr_head caller additionally gets the bespoke HR-head surface
 * (getHrHeadDashboardExtras — hero KPI + funnel + inline approvals + risk rail),
 * with the getMyDashboard hr_head actions feeding its "Tasks due today" strip.
 * Every other persona (incl. admin) keeps the DASH-01 PersonaDashboard.
 * Server-rendered — the page lands with real data, no client loading flash.
 */
export default async function DashboardPage() {
  const session = await requireAuth();
  const caller = createServerTRPCCaller(session);
  const data = await caller.getMyDashboard();

  // hr_head (but not the admin superset) gets the bespoke surface.
  const isHrHead = session.roles.includes("hr_head") && !session.roles.includes("admin");

  return (
    <AppShell
      title="Home"
      isAdmin={session.roles.includes("admin")}
      roles={session.roles}
      active="home"
      user={sessionUserChip(session)}
    >
      {isHrHead ? (
        <HrHeadDashboard
          initialExtras={await caller.getHrHeadDashboardExtras()}
          tasks={data.actions}
          displayName={session.email?.split("@")[0] ?? "there"}
        />
      ) : (
        <PersonaDashboard data={data} />
      )}
    </AppShell>
  );
}
