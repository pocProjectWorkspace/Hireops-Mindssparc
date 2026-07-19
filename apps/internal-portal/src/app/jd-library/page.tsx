import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { JdLibraryClient } from "./JdLibraryClient";

export const dynamic = "force-dynamic"; // Role-gated + reads live requisition/JD state.

/**
 * RO-03 — /jd-library.
 *
 * A searchable table over MY requisitions' current JD version: role,
 * department, keyword chips (real jd_skills / aiMetadata keywords), the JD
 * status (draft / approved / archived) and the requisition status, created,
 * with a per-req version-history expando. There is NO detached JD authoring —
 * JDs belong to requisitions, so "Create new JD" routes to /requisitions/new.
 *
 * hiring_manager + admin only (nav + API enforce the same). Every read is
 * scoped to the caller's own requisitions server-side.
 */

const READ_ROLES = ["hiring_manager", "admin"];

/** Anchor styled as the house primary button (Button renders a <button>). */
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

export default async function JdLibraryPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="JD library"
        isAdmin={isAdmin}
        roles={session.roles}
        active="jd-library"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="JD library isn't available for your role"
          hint="This surface is for hiring managers. If you need access, ask an administrator to add the hiring_manager role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listJdLibrary({ limit: 100 });

  return (
    <AppShell
      title="JD library"
      isAdmin={isAdmin}
      roles={session.roles}
      active="jd-library"
      user={sessionUserChip(session)}
      actions={<LinkButton href="/requisitions/new">Create new JD</LinkButton>}
    >
      <JdLibraryClient initial={initial} />
    </AppShell>
  );
}
