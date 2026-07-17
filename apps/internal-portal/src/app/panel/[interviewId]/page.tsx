import { notFound } from "next/navigation";
import type { GetPanelInterviewBriefOutput } from "@hireops/api-types";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { PanelInterviewBrief } from "@/components/panel/PanelInterviewBrief";

export const dynamic = "force-dynamic"; // Auth-gated + reads live interview state.

/**
 * INT-03 — panel interview detail: the candidate brief + the scorecard form.
 * Server-renders the brief via the in-process tRPC caller (which ENFORCES
 * panelist-on-this-interview — a non-panelist gets FORBIDDEN); the client
 * PanelInterviewBrief owns the draft/submit mutations and keeps the surface
 * live.
 *
 * FORBIDDEN → a calm in-shell notice (signed in, wrong interview). A missing /
 * cross-tenant interview → 404.
 */
export default async function PanelInterviewDetailPage({
  params,
}: {
  params: Promise<{ interviewId: string }>;
}) {
  const { interviewId } = await params;
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const caller = createServerTRPCCaller(session);

  let initial: GetPanelInterviewBriefOutput;
  try {
    initial = await caller.getPanelInterviewBrief({ interviewId });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code === "NOT_FOUND") notFound();
    if (code === "FORBIDDEN") {
      return (
        <AppShell
          title="My interviews"
          isAdmin={isAdmin}
          roles={session.roles}
          active="panel"
          user={sessionUserChip(session)}
        >
          <RoleNotice
            title="This interview isn't on your panel"
            hint="You can only open briefs and scorecards for interviews you're a panellist on."
          />
        </AppShell>
      );
    }
    throw err;
  }

  return (
    <AppShell
      title="My interviews"
      isAdmin={isAdmin}
      roles={session.roles}
      active="panel"
      user={sessionUserChip(session)}
    >
      <PanelInterviewBrief interviewId={interviewId} initial={initial} />
    </AppShell>
  );
}
