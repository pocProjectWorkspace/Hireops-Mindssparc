import { redirect } from "next/navigation";
import { requireAuth, sessionCan, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { JoiningWatchlistClient } from "./JoiningWatchlistClient";

export const dynamic = "force-dynamic"; // Gated + reads live engagement state.

/**
 * PC-16 — the joining-risk watchlist: accepted-not-joined candidates during
 * their notice period. FACTS ONLY — last contact each way, last check-in
 * answer, open signals (each a thing the candidate said, with their words),
 * missed check-ins. No score, no ranking, no prediction.
 *
 * recruiter (own applications) + hr_head + admin. Double-gated: this redirect
 * and the listJoiningWatchlist procedure (the onboarding.prejoining_watchlist capability).
 */
export default async function JoiningWatchlistPage() {
  const session = await requireAuth();
  if (!sessionCan(session, "onboarding.prejoining_watchlist")) redirect("/triage");
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listJoiningWatchlist({});
  return (
    <AppShell
      title="Joining watchlist"
      isAdmin={session.roles.includes("admin")}
      roles={session.roles}
      active="joining-watchlist"
      user={sessionUserChip(session)}
    >
      <JoiningWatchlistClient
        initial={initial}
        canConfigure={sessionCan(session, "onboarding.prejoining_settings")}
      />
    </AppShell>
  );
}
