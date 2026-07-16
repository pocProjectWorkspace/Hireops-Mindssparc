import { requireAuth, sessionUserChip } from "@/lib/auth";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";

export const dynamic = "force-dynamic"; // Auth-gated.

/**
 * REQ-01 (Wave A) — honest placeholder for requisition creation.
 *
 * The 6-step creation wizard (basics → JD via the real ai-client →
 * skills/knockouts → submit for approval) is REQ-02. This page holds the
 * route the "New requisition" button points at so the affordance isn't a
 * dead link, and tells the user plainly what's coming rather than showing a
 * half-built form. Same persona gate as the list.
 */

const READ_ROLES = ["hiring_manager", "recruiter", "admin"];

export default async function NewRequisitionPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  return (
    <AppShell
      title="New requisition"
      isAdmin={isAdmin}
      roles={session.roles}
      active="requisitions"
      user={sessionUserChip(session)}
    >
      {allowed ? (
        <div className="mx-auto w-full max-w-2xl px-8 py-16">
          <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center">
            <h2 className="text-lg font-semibold text-neutral-900">
              Requisition creation arrives with REQ-02
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-neutral-600">
              The guided flow — role basics, an AI-drafted job description, skill weights and
              knockouts, then submit for HR-head approval — is being built next. Once it ships, this
              is where a hiring manager opens a new requisition.
            </p>
            <a
              href="/requisitions"
              className="mt-6 inline-flex h-9 items-center justify-center rounded-button border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 hover:border-neutral-400"
            >
              Back to requisitions
            </a>
          </div>
        </div>
      ) : (
        <RoleNotice
          title="Requisition creation isn't available for your role"
          hint="This surface is for hiring managers and recruiters. Ask an administrator to add the hiring_manager role to your membership if you need access."
        />
      )}
    </AppShell>
  );
}
