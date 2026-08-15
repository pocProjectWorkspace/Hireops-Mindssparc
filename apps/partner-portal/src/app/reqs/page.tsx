import { TRPCError } from "@trpc/server";
import { requireAuth } from "@/lib/auth";
import { createPartnerServerTRPCCaller } from "@/lib/trpc-server";
import { PartnerShell } from "@/components/PartnerShell";
import { NotAPartner } from "@/components/dashboard/NotAPartner";
import { AssignedReqCard } from "@/components/reqs/AssignedReqCard";
import { Card, EmptyState } from "@/components/ui";

// Session-dependent reads — never prerender.
export const dynamic = "force-dynamic";

function roleLabel(role: "partner_admin" | "partner_user"): string {
  return role === "partner_admin" ? "Org admin" : "Recruiter";
}

/**
 * /reqs — every requisition open to the partner's organisation (P1.1,
 * partner-wireflows §3.3). The dashboard shows the same cards as one section
 * among many; this is the dedicated surface, and the way through to a req's
 * detail page.
 *
 * Same read as the dashboard (partnerListAssignedRequisitions), so assignment
 * scoping is enforced server-side and a partner can only ever see their own
 * org's assignments. A non-partner identity gets the honest "not a partner
 * account" state rather than an empty list.
 */
export default async function ReqsPage() {
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
      active="reqs"
      isOrgAdmin={me.role === "partner_admin"}
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
              Requisitions open to you
            </h1>
            <p className="mt-1 text-sm text-neutral-500">
              Roles assigned to {me.orgName}. Open one to read the full job description and its
              screening questions.
            </p>
          </div>
          <span className="text-sm text-neutral-500">
            {reqs.items.length} {reqs.items.length === 1 ? "req" : "reqs"}
          </span>
        </div>

        {reqs.items.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title="No requisitions assigned yet"
              hint="When Kyndryl opens a role to your organisation, it will appear here. Check back soon or contact your Kyndryl point of contact."
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {reqs.items.map((req) => (
              <AssignedReqCard key={req.assignmentId} req={req} />
            ))}
          </div>
        )}

        {reqs.capped ? (
          <p className="text-sm text-neutral-500">
            Showing the most recent assignments. Contact your Kyndryl point of contact if you expect
            to see more.
          </p>
        ) : null}
      </div>
    </PartnerShell>
  );
}
