import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { LabelsClient } from "./LabelsClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin display labels (CFG-LITE) — the tenant's WORDING for pipeline stages
 * (per audience: staff portal, candidate emails, partner portal) and for the
 * interview recommendation scale. Only wording changes: the canonical stage and
 * recommendation keys, and everything that reads them (stage logic, analytics,
 * governance gates), are untouched. Unset = platform default wording.
 *
 * Admin-only. Double-gated: this redirect AND get/updateTenantLabels.
 */
export default async function LabelsPage() {
  const session = await requireAuth();
  if (!session.roles.includes("admin")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getTenantLabels({});

  return (
    <AppShell title="Labels" isAdmin active="labels" user={sessionUserChip(session)}>
      <LabelsClient initial={initial} />
    </AppShell>
  );
}
