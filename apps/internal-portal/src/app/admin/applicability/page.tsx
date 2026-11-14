import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { ApplicabilityClient } from "./ApplicabilityClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin Applicability (C2-F12 — Plan A §15 P3).
 *
 * One place to say which template applies to which requisition: per template
 * kind, rules over legal entity / country / business unit (incl. sub-units) /
 * location / job function / level range / job profile / employment and
 * requisition type. Most specific match wins, then priority, then newest; no
 * match keeps today's tenant default. A "Test against a requisition" panel
 * shows the resolved configuration and why.
 *
 * Readable by admin + hr_head (hr_head read-only); writes are admin-only and
 * enforced server-side as well.
 */
export default async function ApplicabilityPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  if (!isAdmin && !session.roles.includes("hr_head")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const [initial, architecture] = await Promise.all([
    caller.listTemplateAssignments({}),
    caller.getOrgAndJobArchitecture({ includeInactive: true }),
  ]);

  return (
    <AppShell title="Applicability" isAdmin active="applicability" user={sessionUserChip(session)}>
      <ApplicabilityClient initial={initial} architecture={architecture} canEdit={isAdmin} />
    </AppShell>
  );
}
