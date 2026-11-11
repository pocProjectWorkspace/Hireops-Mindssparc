import { requireAuth, sessionUserChip } from "@/lib/auth";
import { AppShell } from "@/components/nav/AppShell";
import { AvailabilityClient } from "./AvailabilityClient";

export const dynamic = "force-dynamic"; // Auth-gated + reads live availability.

/**
 * PC-8 — "My availability". Any internal member who can sit on an interview
 * panel declares their weekly windows and out-of-office ranges here; that is
 * what "Find common slots" and the candidate's pick-a-time page are computed
 * from (no external calendar is read). Recruiters, hiring managers and admins
 * can also look up another member (read-only unless admin). The API enforces
 * the same gates.
 */
export default async function AvailabilityPage() {
  const session = await requireAuth();
  const canViewOthers = ["recruiter", "hiring_manager", "admin"].some((r) =>
    session.roles.includes(r),
  );
  return (
    <AppShell
      title="My availability"
      isAdmin={session.roles.includes("admin")}
      roles={session.roles}
      active="availability"
      user={sessionUserChip(session)}
    >
      <AvailabilityClient canViewOthers={canViewOthers} />
    </AppShell>
  );
}
