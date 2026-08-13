import type {
  GetPartnerOrgOutput,
  ListPartnerOrgClaimsOutput,
  RequisitionSummary,
} from "@hireops/api-types";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { PartnerOrgDetailClient } from "./PartnerOrgDetailClient";

export const dynamic = "force-dynamic"; // Auth-gated + reads live partner state.

/**
 * P0.1B — one partner organisation, as internal staff administer it: the org
 * header (tier, active state), its portal users, its live invitations, the
 * full requisition-assignment history, and (P0.3) its candidate ownership
 * claims.
 *
 * Role-gated to admin / hr_ops, matching the PARTNER_ADMIN_ROLES gate on the
 * procedures themselves. A missing / cross-tenant org answers NOT_FOUND from
 * getPartnerOrg; we render that as a calm in-shell notice rather than a 404
 * shell, because arriving here means a stale link, not a wrong URL.
 *
 * The assign-requisition picker needs a requisition list, and the only list
 * read available is listRequisitionSummaries — gated to admin / hiring_manager
 * / recruiter / hr_head, which does NOT include hr_ops. So the prefetch is
 * tolerant: an hr_ops operator gets the whole surface minus the picker, with
 * an honest note, instead of a 500. (Widening that gate is an API change and
 * out of scope for this ticket.)
 */

const READ_ROLES = ["admin", "hr_ops"];

export default async function PartnerOrgDetailPage({
  params,
}: {
  params: Promise<{ partnerOrgId: string }>;
}) {
  const { partnerOrgId } = await params;
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Partners"
        isAdmin={isAdmin}
        roles={session.roles}
        active="partners"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Partner administration isn't available for your role"
          hint="This surface is for administrators and the HR Ops team. Ask an administrator to add the hr_ops role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  let initial: GetPartnerOrgOutput;
  try {
    initial = await caller.getPartnerOrg({ partnerOrgId });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "NOT_FOUND") {
      return (
        <AppShell
          title="Partners"
          isAdmin={isAdmin}
          roles={session.roles}
          active="partners"
          user={sessionUserChip(session)}
        >
          <RoleNotice
            title="That partner organisation isn't here"
            hint="It may have been removed, or the link belongs to another tenant. Go back to Partners to pick one from the list."
          />
        </AppShell>
      );
    }
    throw err;
  }

  // Same gate as getPartnerOrg (PARTNER_ADMIN_ROLES) and the same NOT_FOUND
  // condition, which the block above has already ruled out — so this read is
  // not made tolerant the way the requisition picker below is.
  const initialClaims: ListPartnerOrgClaimsOutput = await caller.listPartnerOrgClaims({
    partnerOrgId,
  });

  let requisitionOptions: RequisitionSummary[] | null = null;
  try {
    const reqs = await caller.listRequisitionSummaries({ limit: 100 });
    requisitionOptions = reqs.rows;
  } catch {
    requisitionOptions = null;
  }

  return (
    <AppShell
      title="Partners"
      isAdmin={isAdmin}
      roles={session.roles}
      active="partners"
      user={sessionUserChip(session)}
    >
      <PartnerOrgDetailClient
        partnerOrgId={partnerOrgId}
        initial={initial}
        initialClaims={initialClaims}
        requisitionOptions={requisitionOptions}
      />
    </AppShell>
  );
}
