import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { InterviewTemplatesClient } from "./InterviewTemplatesClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live tenant config.

/**
 * Admin Interview templates (T2.2 / G07) — the tenant's DEFAULT interview loop
 * plus its CUSTOM scorecard rubrics.
 *
 * Two configs:
 *  (A) Round templates — the org's default ordered interview loop. A new
 *      requisition can APPLY this loop (applyInterviewRoundTemplate seeds the
 *      req's interview_plans from it); a tenant with no loop builds the plan
 *      from scratch exactly as today.
 *  (B) Custom scorecards — rubrics beyond the 4 built-ins (technical, manager,
 *      hr, general). A custom rubric's criteria are RESOLVED and snapshot onto an
 *      interview at schedule time, so they genuinely drive the panel scorecard.
 *
 * Admin-gated twice: requireAdmin (page redirect) AND the list/upsert/delete
 * procedures (server-side admin role).
 */
export default async function InterviewTemplatesPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const [rounds, scorecards] = await Promise.all([
    caller.listInterviewRoundTemplates({}),
    caller.listScorecardTemplates({}),
  ]);

  return (
    <AppShell
      title="Interview templates"
      isAdmin
      active="interview-templates"
      user={sessionUserChip(session)}
    >
      <InterviewTemplatesClient initialRounds={rounds} initialScorecards={scorecards} />
    </AppShell>
  );
}
