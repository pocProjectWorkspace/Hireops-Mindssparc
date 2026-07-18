import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { PersonaDashboard } from "@/components/dashboard/PersonaDashboard";

export const dynamic = "force-dynamic"; // Auth-gated, per-session data.

/**
 * DASH-01 — the persona landing dashboard (`/dashboard`).
 *
 * The authenticated home surface: `/` redirects here. A single getMyDashboard
 * read (in-process caller) returns the KPI + recommended-action payload for the
 * caller's persona (admin = condensed superset). Server-rendered — the page
 * lands with real data, no client loading flash. Deep-links throughout point at
 * existing surfaces.
 */
export default async function DashboardPage() {
  const session = await requireAuth();
  const caller = createServerTRPCCaller(session);
  const data = await caller.getMyDashboard();

  return (
    <AppShell
      title="Home"
      isAdmin={session.roles.includes("admin")}
      roles={session.roles}
      active="home"
      user={sessionUserChip(session)}
    >
      <PersonaDashboard data={data} />
    </AppShell>
  );
}
