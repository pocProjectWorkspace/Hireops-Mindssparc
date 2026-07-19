import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { CompDeskView } from "@/components/comp/CompDeskView";

export const dynamic = "force-dynamic"; // Auth-gated + reads live pipeline / offers.

/**
 * HROPS-02 — Comp & offer desk.
 *
 * The hr_ops comp operator's surface: every late-stage candidate with its
 * DETERMINISTIC comp verdict, offer status, and out-of-band approval posture.
 * hr_ops + admin. A direct hit by another role gets a calm in-shell notice.
 */

const ROLES = ["hr_ops", "admin"];

export default async function CompOffersPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Comp & offers"
        isAdmin={isAdmin}
        roles={session.roles}
        active="comp-offers"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="The comp desk isn't available for your role"
          hint="This surface is for HR ops. If you need access, ask an administrator to add the hr_ops role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listCompDesk({});

  return (
    <AppShell
      title="Comp & offers"
      isAdmin={isAdmin}
      roles={session.roles}
      active="comp-offers"
      user={sessionUserChip(session)}
    >
      <CompDeskView initial={initial} />
    </AppShell>
  );
}
