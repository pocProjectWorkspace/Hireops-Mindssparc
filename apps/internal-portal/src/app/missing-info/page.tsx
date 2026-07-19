import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { MissingInfoClient } from "./MissingInfoClient";

export const dynamic = "force-dynamic"; // Role-gated + reads the live pipeline.

/**
 * RECR-03 — the recruiter's Missing Info Tracker.
 *
 * Header stat cards (Pending / Requested / Received / Verified) + a table of
 * every in-flight application's missing tracked fields. "Required vs Optional"
 * and "Blocks Advance to <stage>" are DETERMINISTIC rule outputs — there is
 * deliberately NO "score impact / capped at X%" column (the prototype's
 * fiction is refused; a hard gate is a deterministic knockout, not a magic
 * score cap). "Request" uses the REAL candidate-notification flow.
 *
 * Persona-gated to recruiter + admin, matching the RECRUITER_SURFACE_ROLES API
 * gate. A direct hit by another role gets a calm in-shell notice.
 */

const READ_ROLES = ["recruiter", "admin"];

export default async function MissingInfoPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Missing info"
        isAdmin={isAdmin}
        roles={session.roles}
        active="missing-info"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Missing Info isn't available for your role"
          hint="This tracker is for recruiters. If you need access, ask an administrator to add the recruiter role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listMissingInfo({});

  return (
    <AppShell
      title="Missing info"
      isAdmin={isAdmin}
      roles={session.roles}
      active="missing-info"
      user={sessionUserChip(session)}
    >
      <MissingInfoClient initial={initial} />
    </AppShell>
  );
}
