import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { SchedulingSettingsClient } from "./SchedulingSettingsClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin → Interview scheduling (PC-8). The tenant's scheduling settings:
 * duration presets, working window + time zone, buffer, minimum notice, slot
 * horizon and grid, slots offered to a candidate, pick-link lifetime and the
 * candidate's reschedule allowance. Platform defaults apply until saved.
 * Admin-only here AND in updateSchedulingSettings.
 */
export default async function SchedulingSettingsPage() {
  const session = await requireAdmin("settings.scheduling");
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getSchedulingSettings({});
  return (
    <AppShell
      title="Interview scheduling"
      isAdmin
      active="scheduling-settings"
      user={sessionUserChip(session)}
    >
      <SchedulingSettingsClient initial={initial} />
    </AppShell>
  );
}
