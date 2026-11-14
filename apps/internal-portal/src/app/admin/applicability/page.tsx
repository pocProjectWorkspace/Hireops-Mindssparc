import { redirect } from "next/navigation";
import { requireAuth, sessionCan, sessionUserChip } from "@/lib/auth";
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
 * Gated on capabilities (C2-F1): `settings.applicability_read` to see the page
 * (default admin + hr_head), `settings.applicability_write` to edit (default
 * admin). The procedures enforce the same capabilities server-side.
 */
export default async function ApplicabilityPage() {
  const session = await requireAuth();
  if (!sessionCan(session, "settings.applicability_read")) {
    redirect("/triage");
  }
  const canEdit = sessionCan(session, "settings.applicability_write");
  const caller = createServerTRPCCaller(session);
  const [initial, architecture] = await Promise.all([
    caller.listTemplateAssignments({}),
    caller.getOrgAndJobArchitecture({ includeInactive: true }),
  ]);

  return (
    <AppShell title="Applicability" active="applicability" user={sessionUserChip(session)}>
      <ApplicabilityClient initial={initial} architecture={architecture} canEdit={canEdit} />
    </AppShell>
  );
}
