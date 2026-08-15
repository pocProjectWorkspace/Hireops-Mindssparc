import { TRPCError } from "@trpc/server";
import { requireAuth } from "@/lib/auth";
import { createPartnerServerTRPCCaller } from "@/lib/trpc-server";
import { PartnerShell } from "@/components/PartnerShell";
import { NotAPartner } from "@/components/dashboard/NotAPartner";
import { TeamClient } from "@/components/team/TeamClient";
import { Card } from "@/components/ui";

// Session-dependent reads — never prerender.
export const dynamic = "force-dynamic";

function roleLabel(role: "partner_admin" | "partner_user"): string {
  return role === "partner_admin" ? "Org admin" : "Recruiter";
}

/**
 * /team — the partner org admin's team management (P1.3, partner-wireflows
 * §3.12): who has portal access, who has been invited, invite, suspend,
 * reactivate.
 *
 * Two guards, in order. partnerGetMe FORBIDDEN means the signed-in identity
 * isn't a partner at all → the honest NotAPartner state, exactly as every other
 * page does. A partner who simply isn't an admin gets a CALM in-shell notice
 * rather than an error boundary: they are legitimately here, this page just
 * isn't theirs. Neither is the real gate — the three procedures behind this
 * page enforce partner_admin server-side, so a hand-typed /team leaks nothing.
 */
export default async function TeamPage() {
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

  const shellProps = {
    orgName: me.orgName,
    user: { label: me.displayName, role: roleLabel(me.role) },
    active: "team" as const,
    canManageTeam: me.role === "partner_admin",
  };

  if (me.role !== "partner_admin") {
    return (
      <PartnerShell {...shellProps}>
        <div className="flex flex-col gap-6">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Team</h1>
          <Card className="flex flex-col gap-2">
            <h2 className="text-base font-semibold text-neutral-900">
              Team management is for your organisation&rsquo;s admin
            </h2>
            <p className="text-sm text-neutral-500">
              Ask the admin at {me.orgName} to invite a colleague or change someone&rsquo;s access.
              Everything else in the portal is open to you as usual.
            </p>
            <div className="pt-1">
              <a
                href="/"
                className="inline-flex items-center rounded-button bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-700"
              >
                Back to dashboard
              </a>
            </div>
          </Card>
        </div>
      </PartnerShell>
    );
  }

  const team = await caller.partnerListTeam();

  return (
    <PartnerShell {...shellProps}>
      <TeamClient initialTeam={team} orgName={me.orgName} />
    </PartnerShell>
  );
}
