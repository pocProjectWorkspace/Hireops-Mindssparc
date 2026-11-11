import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { JobArchitectureClient } from "./JobArchitectureClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin Job architecture (C1-F3 — Plan A F3, §15 P1/P2).
 *
 * Readable by admin + hr_head (hr_head sees it read-only); every write is
 * admin-only and is enforced server-side as well. Server-prefetches the full
 * organisation + job architecture (inactive rows included) so the page lands
 * populated.
 */
export default async function JobArchitecturePage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  if (!isAdmin && !session.roles.includes("hr_head")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getOrgAndJobArchitecture({ includeInactive: true });

  return (
    <AppShell
      title="Job architecture"
      isAdmin
      active="job-architecture"
      user={sessionUserChip(session)}
    >
      <JobArchitectureClient initial={initial} canEdit={isAdmin} />
    </AppShell>
  );
}
