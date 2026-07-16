import { TRPCError } from "@trpc/server";
import { requireAuth } from "@/lib/auth";
import { createPartnerServerTRPCCaller } from "@/lib/trpc-server";
import { PartnerShell } from "@/components/PartnerShell";
import { NotAPartner } from "@/components/dashboard/NotAPartner";
import { SubmitCandidateForm } from "@/components/submit/SubmitCandidateForm";

// Session-dependent reads — never prerender.
export const dynamic = "force-dynamic";

function roleLabel(role: "partner_admin" | "partner_user"): string {
  return role === "partner_admin" ? "Org admin" : "Recruiter";
}

/**
 * Submit-candidate page (`/submit`) — PARTNER-02. Server component resolves
 * the partner session + assigned reqs, then hands them to the client form
 * which drives the upload-then-submit flow. A non-partner identity gets the
 * same honest "not a partner account" state the dashboard renders.
 */
export default async function SubmitPage() {
  const session = await requireAuth();
  const caller = createPartnerServerTRPCCaller(session);

  let me;
  try {
    me = await caller.partnerGetMe();
  } catch (err) {
    if (err instanceof TRPCError && err.code === "FORBIDDEN") {
      return <NotAPartner email={session.email} />;
    }
    throw err;
  }

  const reqs = await caller.partnerListAssignedRequisitions();

  return (
    <PartnerShell
      orgName={me.orgName}
      user={{ label: me.displayName, role: roleLabel(me.role) }}
      active="submit"
    >
      <SubmitCandidateForm reqs={reqs.items} />
    </PartnerShell>
  );
}
