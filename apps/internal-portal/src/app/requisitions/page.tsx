import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { RequisitionsListV2 } from "@/components/requirements/RequisitionsListV2";

export const dynamic = "force-dynamic"; // Auth-gated + reads live requisition state.

/**
 * RO-01 — My Requisitions v2 (requirement-owner list, rebuilt).
 *
 * Server-renders the enriched rows (health composite + difficulty per row from
 * the deterministic rule engine, budget band, status) via listMyRequisitionsV2;
 * the client RequisitionsListV2 owns search, the status filter, and the
 * submit-for-approval row action. Persona-gated to hiring_manager / recruiter /
 * admin (same set as REQ-01), enforced by the API too; a direct hit by another
 * role gets a calm in-shell notice. `?status=` deep-links the filter (the
 * dashboard stat strip uses it).
 */

const READ_ROLES = ["hiring_manager", "recruiter", "admin"];

/** Anchor styled as the house primary button. */
function LinkButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex h-9 items-center justify-center rounded-button bg-brand-600 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-brand-700 active:bg-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
    >
      {children}
    </a>
  );
}

export default async function RequisitionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Requisitions"
        isAdmin={isAdmin}
        roles={session.roles}
        active="requisitions"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Requisitions isn't available for your role"
          hint="This surface is for hiring managers and recruiters. If you need access, ask an administrator to add the hiring_manager role to your membership."
        />
      </AppShell>
    );
  }

  const { status } = await searchParams;
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listMyRequisitionsV2({ limit: 100 });

  return (
    <AppShell
      title="Requisitions"
      isAdmin={isAdmin}
      roles={session.roles}
      active="requisitions"
      user={sessionUserChip(session)}
      actions={<LinkButton href="/requisitions/new">New requisition</LinkButton>}
    >
      <RequisitionsListV2 initial={initial} initialStatus={status ?? "all"} />
    </AppShell>
  );
}
