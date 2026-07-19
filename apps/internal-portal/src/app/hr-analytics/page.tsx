import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { HrAnalyticsClient } from "./HrAnalyticsClient";

export const dynamic = "force-dynamic"; // Role-gated + reads live pipeline / offer / band data.

/**
 * HROPS-02 — HR analytics.
 *
 * Five real recharts over real queries (getHrAnalytics): time-to-hire by
 * department, drop-off by stage, offer acceptance, hiring demand by department,
 * average offer vs band midpoint. hr_ops + admin (matches the API gate). A
 * direct hit by another role gets a calm in-shell notice.
 */

const ROLES = ["hr_ops", "admin"];

export default async function HrAnalyticsPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="HR analytics"
        isAdmin={isAdmin}
        roles={session.roles}
        active="hr-analytics"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="HR analytics isn't available for your role"
          hint="This surface is for HR ops. If you need access, ask an administrator to add the hr_ops role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.getHrAnalytics();

  return (
    <AppShell
      title="HR analytics"
      isAdmin={isAdmin}
      roles={session.roles}
      active="hr-analytics"
      user={sessionUserChip(session)}
    >
      <HrAnalyticsClient initial={initial} />
    </AppShell>
  );
}
