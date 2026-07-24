import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { SlaThresholdsClient } from "./SlaThresholdsClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin SLA thresholds (T4.1) — the per-stage SLA hours config surface.
 *
 * The per-stage SLA thresholds that decide when an application "breaches" lived
 * ONLY in a code constant (SLA_THRESHOLDS_HOURS). This page lets a tenant tune
 * them. The saved hours are REAL config: they drive the triage breach filter +
 * sort, recruiter urgency, the governance / executive-audit compliance numbers,
 * AND the imminent-breach alert emails the worker sends. An unconfigured tenant
 * resolves to the code defaults, so it behaves exactly as before.
 *
 * Gated to {admin, hr_head} — SLA / compliance is HR-head territory alongside
 * admin. Double-gated: this redirect AND the get/updateSlaThresholds procedures
 * (SLA_CONFIG_ROLES) enforce the same roles server-side.
 */
export default async function SlaThresholdsPage() {
  const session = await requireAuth();
  if (!session.roles.includes("admin") && !session.roles.includes("hr_head")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getSlaThresholds({});

  return (
    <AppShell
      title="SLA thresholds"
      isAdmin
      active="sla-thresholds"
      user={sessionUserChip(session)}
    >
      <SlaThresholdsClient initial={initial} />
    </AppShell>
  );
}
