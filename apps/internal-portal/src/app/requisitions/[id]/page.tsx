import { notFound } from "next/navigation";
import type { GetRequisitionDetailOutput } from "@hireops/api-types";
import { requireAuth, sessionCan, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { RequisitionDetailView } from "@/components/requisitions/RequisitionDetailView";

export const dynamic = "force-dynamic"; // Auth-gated + reads live requisition state.

/**
 * REQ-02 — requisition detail. Server-renders the full requisition (summary,
 * JD, skills, knockouts, approval state) via the in-process tRPC caller; the
 * client RequisitionDetailView owns the Submit-for-approval action while the
 * requisition is a draft.
 *
 * Read-gated to hiring_manager / recruiter / admin (the procedure enforces the
 * same). Submit is hiring_manager / admin only. A missing / cross-tenant req
 * 404s (the procedure throws NOT_FOUND under RLS).
 */

// REQ-03: the HR head decides (approve / send back / reject); the recruiter /
// hiring-manager side posts an approved req live.
// INT-02: interview plan editing — hiring_manager / recruiter / admin.
// PC-2: bulk CV upload — the Candidates-surface roles (the API enforces the same).

export default async function RequisitionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = sessionCan(session, "requisitions.read");
  const canWrite = sessionCan(session, "requisitions.write");
  const canDecide = sessionCan(session, "requisitions.approve");
  const canPost = sessionCan(session, "requisitions.post");
  const canManageInterviews = sessionCan(session, "interviews.manage");
  const canUploadCvs = sessionCan(session, "candidates.bulk_upload");

  if (!allowed) {
    return (
      <AppShell
        title="Requisition"
        isAdmin={isAdmin}
        roles={session.roles}
        active="requisitions"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Requisitions isn't available for your role"
          hint="This surface is for hiring managers and recruiters. Ask an administrator to add the hiring_manager role to your membership if you need access."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  let initial: GetRequisitionDetailOutput;
  try {
    initial = await caller.getRequisitionDetail({ requisitionId: id });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "NOT_FOUND") {
      notFound();
    }
    throw err;
  }

  return (
    <AppShell
      title={initial.title}
      isAdmin={isAdmin}
      roles={session.roles}
      active="requisitions"
      user={sessionUserChip(session)}
    >
      <RequisitionDetailView
        requisitionId={id}
        initial={initial}
        canWrite={canWrite}
        canDecide={canDecide}
        canPost={canPost}
        canManageInterviews={canManageInterviews}
        canViewDiverseSlate={sessionCan(session, "governance.diversity_slate_view")}
        canUploadCvs={canUploadCvs}
      />
    </AppShell>
  );
}
