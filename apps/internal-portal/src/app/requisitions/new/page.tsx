import { requireAuth, sessionCan, sessionUserChip } from "@/lib/auth";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { RequisitionWizard } from "@/components/requisitions/RequisitionWizard";

export const dynamic = "force-dynamic"; // Auth-gated.

/**
 * REQ-02 — the requisition creation wizard (Basics → JD → Skills & knockouts
 * → Review & submit). Gated to hiring_manager / admin (the requirement-owner
 * personas that can create); recruiters see the calm role notice — they can
 * read requisitions but request them via a later flow. The draft persists via
 * the REQ-02 mutations; the URL ?rid= carries the draft id so a reload resumes.
 */

export default async function NewRequisitionPage({
  searchParams,
}: {
  searchParams: Promise<{ rid?: string }>;
}) {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = sessionCan(session, "requisitions.write");
  const { rid } = await searchParams;

  return (
    <AppShell
      title="New requisition"
      isAdmin={isAdmin}
      roles={session.roles}
      active="requisitions"
      user={sessionUserChip(session)}
    >
      {allowed ? (
        <RequisitionWizard
          initialRid={rid ?? null}
          isAdmin={sessionCan(session, "organisation.write")}
        />
      ) : (
        <RoleNotice
          title="Requisition creation isn't available for your role"
          hint="Creating a requisition is for hiring managers. Recruiters can view requisitions but request new ones through a separate flow. Ask an administrator to add the hiring_manager role if you need to create them."
        />
      )}
    </AppShell>
  );
}
