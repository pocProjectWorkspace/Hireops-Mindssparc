import { notFound } from "next/navigation";
import type { GetHrCaseDetailOutput } from "@hireops/api-types";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { HrCaseDetail } from "@/components/hr-ops/HrCaseDetail";

export const dynamic = "force-dynamic"; // Auth-gated + reads live case state.

/**
 * HROPS-01 — HR case detail. The repo's first tabbed entity record: Summary |
 * Interview feedback | HR round. Server-renders the case via the in-process
 * caller; the client HrCaseDetail owns the tab shell + the HR-round assessment
 * mutation. Compensation / Offer / Documents tabs are wired by parallel tickets
 * at reconciliation — the tab bar is built so adding tabs is trivial.
 *
 * A missing / cross-tenant / out-of-window case surfaces as a 404 (the
 * procedure throws NOT_FOUND, RLS-scoped).
 */

const READ_ROLES = ["hr_ops", "admin"];

export default async function HrCaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="HR cases"
        isAdmin={isAdmin}
        roles={session.roles}
        active="hr-cases"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="HR cases isn't available for your role"
          hint="This workspace is for the HR Ops team. Ask an administrator to add the hr_ops role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  let initial: GetHrCaseDetailOutput;
  try {
    initial = await caller.getHrCaseDetail({ applicationId: id });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "NOT_FOUND") {
      notFound();
    }
    throw err;
  }

  return (
    <AppShell
      title="HR cases"
      isAdmin={isAdmin}
      roles={session.roles}
      active="hr-cases"
      user={sessionUserChip(session)}
    >
      <HrCaseDetail applicationId={id} initial={initial} />
    </AppShell>
  );
}
