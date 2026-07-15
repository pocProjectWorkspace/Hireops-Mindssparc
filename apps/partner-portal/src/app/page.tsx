import { TRPCError } from "@trpc/server";
import { requireAuth } from "@/lib/auth";
import { createPartnerServerTRPCCaller } from "@/lib/trpc-server";
import { PartnerShell } from "@/components/PartnerShell";
import { PartnerDashboard } from "@/components/dashboard/PartnerDashboard";
import { NotAPartner } from "@/components/dashboard/NotAPartner";

// Session-dependent reads — never prerender.
export const dynamic = "force-dynamic";

function roleLabel(role: "partner_admin" | "partner_user"): string {
  return role === "partner_admin" ? "Org admin" : "Recruiter";
}

/**
 * Partner dashboard (`/`) — the built face of the PARTNER-01 shell.
 *
 * requireAuth proves a Supabase session; partnerGetMe then decides whether the
 * identity is actually a partner. A FORBIDDEN there (no active partner_users
 * row — e.g. an internal recruiter) renders the honest "not a partner account"
 * state instead of the shell.
 */
export default async function DashboardPage() {
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

  const [reqs, submissions] = await Promise.all([
    caller.partnerListAssignedRequisitions(),
    caller.partnerListMySubmissions(),
  ]);

  return (
    <PartnerShell
      orgName={me.orgName}
      user={{ label: me.displayName, role: roleLabel(me.role) }}
      active="dashboard"
    >
      <PartnerDashboard me={me} reqs={reqs.items} submissions={submissions.items} />
    </PartnerShell>
  );
}
