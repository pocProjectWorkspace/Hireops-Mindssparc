import { notFound } from "next/navigation";
import type { GetOffboardingCaseDetailOutput } from "@hireops/api-types";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { EmptyState } from "@/components/ui";
import { OffboardingCaseView } from "@/components/offboarding/OffboardingCaseView";

export const dynamic = "force-dynamic"; // Auth-gated + reads live case state.

const OFFBOARD_ROLES = ["hr_ops", "people_ops", "admin"];

/**
 * Offboarding case detail — deep-linkable from the list. Server-renders the
 * case + checklist + assets + exit interview + settlement via the in-process
 * tRPC caller; the client OffboardingCaseView owns the mutations and keeps the
 * surface live.
 *
 * HR-only (mirrors the API gate); a missing / cross-tenant case surfaces as a
 * 404 rather than a raw error screen.
 */
export default async function OffboardingCaseDetailPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const canAccess = isAdmin || OFFBOARD_ROLES.some((r) => session.roles.includes(r));

  if (!canAccess) {
    return (
      <AppShell
        title="Offboarding"
        isAdmin={isAdmin}
        roles={session.roles}
        active="offboarding"
        user={sessionUserChip(session)}
      >
        <div className="mx-auto w-full max-w-2xl px-8 py-16">
          <EmptyState
            title="You don't have access to offboarding"
            hint="Offboarding is managed by HR Ops and People Ops. Ask an admin if you need access."
          />
        </div>
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);

  let initial: GetOffboardingCaseDetailOutput;
  try {
    initial = await caller.getOffboardingCaseDetail({ caseId });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "NOT_FOUND") {
      notFound();
    }
    throw err;
  }

  return (
    <AppShell
      title="Offboarding"
      isAdmin={isAdmin}
      roles={session.roles}
      active="offboarding"
      user={sessionUserChip(session)}
    >
      <OffboardingCaseView caseId={caseId} initial={initial} />
    </AppShell>
  );
}
