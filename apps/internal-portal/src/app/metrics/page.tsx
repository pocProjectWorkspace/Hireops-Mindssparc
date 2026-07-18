import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { MetricsClient } from "./MetricsClient";

export const dynamic = "force-dynamic"; // Role-gated + reads live pipeline/AI/offer data.

/**
 * METRICS-01 — the HR analytics surface.
 *
 * One rich analytics page: a KPI header row + a two-column chart grid
 * (pipeline funnel, time in stage, source mix, offer funnel, AI spend,
 * score distribution), all from ONE server-side aggregate read
 * (getHrMetrics). Charts are client-side recharts; the numbers are
 * server-fetched. DESIGN-05 tokens only.
 *
 * Persona-gated to hr_head + admin: the nav only surfaces it to those roles
 * and the API enforces the same set (recruiter/hiring_manager/panel_member
 * get FORBIDDEN). A direct hit by another role gets a calm in-shell notice
 * rather than a bare 403.
 */

const READ_ROLES = ["hr_head", "admin"];

export default async function MetricsPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Metrics"
        isAdmin={isAdmin}
        roles={session.roles}
        active="metrics"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Metrics isn't available for your role"
          hint="This analytics surface is for the HR head. If you need access, ask an administrator to add the hr_head role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.getHrMetrics();

  return (
    <AppShell
      title="Metrics"
      isAdmin={isAdmin}
      roles={session.roles}
      active="metrics"
      user={sessionUserChip(session)}
    >
      <MetricsClient initial={initial} />
    </AppShell>
  );
}
