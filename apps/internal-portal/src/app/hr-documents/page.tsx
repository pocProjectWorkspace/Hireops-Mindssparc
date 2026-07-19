import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { HrDocumentsView } from "@/components/hr-docs/HrDocumentsView";

export const dynamic = "force-dynamic"; // Auth-gated + reads live document state.

/**
 * HROPS-03 — Documents & verification. Pre-offer document collection for
 * hr_ops: request document types for a candidate in the tech_interview →
 * offer_accepted window, watch uploads land, verify or reject with a reason.
 * hr_ops + admin only (HR_OPS_DOC_ROLES); a direct hit by another role gets a
 * calm in-shell notice.
 */

const ALLOWED_ROLES = ["hr_ops", "admin"];

export default async function HrDocumentsPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => ALLOWED_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Documents"
        isAdmin={isAdmin}
        roles={session.roles}
        active="hr-documents"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Documents & verification isn't available for your role"
          hint="This surface is for HR operations. If you need access, ask an administrator to update your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listApplicationDocumentCandidates({ limit: 100 });

  return (
    <AppShell
      title="Documents"
      isAdmin={isAdmin}
      roles={session.roles}
      active="hr-documents"
      user={sessionUserChip(session)}
    >
      <HrDocumentsView initial={initial} />
    </AppShell>
  );
}
