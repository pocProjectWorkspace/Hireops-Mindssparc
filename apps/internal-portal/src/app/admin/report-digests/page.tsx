import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { ReportDigestsClient } from "./ReportDigestsClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live tenant config.

/**
 * R1.5b — the scheduled report-digest admin surface.
 *
 * Configures tenants.settings.reportDigests: whether the executive board-pack
 * headline is emailed on a schedule, how often, to whom, and at what UTC hour.
 * The saved block is consumed by the report_digest_scan worker (30-min tick) —
 * this screen configures a real send, not a preference.
 *
 * Admin-gated (requireAdmin redirects non-admins to /triage). Double-gated: the
 * get/updateReportDigests procedures enforce USERS_ADMIN_ROLES server-side, so
 * the redirect is convenience, not the boundary. Server-prefetches the resolved
 * block via the in-process tRPC caller so the form lands populated.
 */
export default async function ReportDigestsPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getReportDigests({});

  return (
    <AppShell
      title="Report digests"
      isAdmin
      active="report-digests"
      user={sessionUserChip(session)}
    >
      <ReportDigestsClient initial={initial} />
    </AppShell>
  );
}
