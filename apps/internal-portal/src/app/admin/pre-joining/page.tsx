import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { PreJoiningSettingsClient } from "./PreJoiningSettingsClient";

export const dynamic = "force-dynamic";

/**
 * PC-14 — pre-joining engagement configuration: on/off, cadence, which steps
 * send, quiet hours + time zone, sender name, first-day info, which signals
 * are recorded / alert, renege reasons, and the company updates the journey
 * sends. Platform feature + platform defaults (off) + tenant settings.
 *
 * admin + hr_head (TA lead). Double-gated with PRE_JOINING_ADMIN_ROLES.
 */
export default async function PreJoiningAdminPage() {
  const session = await requireAuth();
  if (!session.roles.includes("admin") && !session.roles.includes("hr_head")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const [settings, updates] = await Promise.all([
    caller.getPreJoiningSettings({}),
    caller.listPreJoiningCompanyUpdates({}),
  ]);
  return (
    <AppShell
      title="Pre-joining engagement"
      isAdmin={session.roles.includes("admin")}
      roles={session.roles}
      active="pre-joining"
      user={sessionUserChip(session)}
    >
      <PreJoiningSettingsClient initialSettings={settings} initialUpdates={updates.items} />
    </AppShell>
  );
}
