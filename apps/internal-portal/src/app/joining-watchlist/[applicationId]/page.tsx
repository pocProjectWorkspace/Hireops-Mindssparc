import { notFound, redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { requireAuth, sessionCan, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { EngagementTimelineClient } from "./EngagementTimelineClient";

export const dynamic = "force-dynamic";

/**
 * PC-16 — one candidate's engagement timeline: every touchpoint (sent,
 * scheduled, skipped, cancelled), check-in answers, replies, signals (with
 * the candidate's words) and any renege. Recruiters can acknowledge a signal
 * and record a renege here.
 */
export default async function EngagementTimelinePage({
  params,
}: {
  params: { applicationId: string };
}) {
  const session = await requireAuth();
  if (!sessionCan(session, "onboarding.prejoining_watchlist")) redirect("/triage");
  const caller = createServerTRPCCaller(session);
  let timeline;
  try {
    timeline = await caller.getEngagementTimeline({ applicationId: params.applicationId });
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "NOT_FOUND" || err.code === "BAD_REQUEST")) {
      notFound();
    }
    throw err;
  }
  const watch = await caller.listJoiningWatchlist({});
  return (
    <AppShell
      title={`Engagement · ${timeline.candidateName}`}
      isAdmin={session.roles.includes("admin")}
      roles={session.roles}
      active="joining-watchlist"
      user={sessionUserChip(session)}
    >
      <EngagementTimelineClient initial={timeline} renegeReasons={watch.renegeReasons} />
    </AppShell>
  );
}
