import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { WelcomeContentClient } from "./WelcomeContentClient";

export const dynamic = "force-dynamic";

/**
 * PC-18 — welcome content per business unit (plus an organisation default):
 * the tenant writes the source material, the AI drafts a guide strictly from
 * it, a person reviews, edits and publishes. Only published guides reach
 * candidates (candidate portal → Welcome).
 *
 * admin + hr_head. Double-gated with PRE_JOINING_ADMIN_ROLES in the API.
 */
export default async function WelcomeContentAdminPage() {
  const session = await requireAuth();
  if (!session.roles.includes("admin") && !session.roles.includes("hr_head")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const scopes = await caller.listWelcomeScopes({});
  return (
    <AppShell
      title="Welcome content"
      isAdmin={session.roles.includes("admin")}
      roles={session.roles}
      active="welcome-content"
      user={sessionUserChip(session)}
    >
      <WelcomeContentClient initialScopes={scopes} />
    </AppShell>
  );
}
