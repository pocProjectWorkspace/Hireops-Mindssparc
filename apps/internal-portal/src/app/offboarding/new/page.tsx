import { requireAuth, sessionUserChip } from "@/lib/auth";
import { AppShell } from "@/components/nav/AppShell";
import { EmptyState } from "@/components/ui";
import { NewOffboardingForm } from "@/components/offboarding/NewOffboardingForm";

export const dynamic = "force-dynamic"; // Auth-gated.

const OFFBOARD_ROLES = ["hr_ops", "people_ops", "admin"];

/**
 * Initiate-offboarding form route. Server component gates by role (HR-only,
 * mirroring the API) and renders the client form, which loads the hired-
 * employee picker + memberships and calls initiateOffboarding.
 */
export default async function NewOffboardingPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const canAccess = isAdmin || OFFBOARD_ROLES.some((r) => session.roles.includes(r));

  return (
    <AppShell
      title="Offboarding"
      isAdmin={isAdmin}
      roles={session.roles}
      active="offboarding"
      user={sessionUserChip(session)}
    >
      {canAccess ? (
        <NewOffboardingForm />
      ) : (
        <div className="mx-auto w-full max-w-2xl px-8 py-16">
          <EmptyState
            title="You don't have access to offboarding"
            hint="Offboarding is managed by HR Ops and People Ops. Ask an admin if you need access."
          />
        </div>
      )}
    </AppShell>
  );
}
