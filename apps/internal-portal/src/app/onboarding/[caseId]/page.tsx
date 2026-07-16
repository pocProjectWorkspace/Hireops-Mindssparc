import { notFound } from "next/navigation";
import type { GetOnboardingCaseDetailOutput } from "@hireops/api-types";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { OnboardingCaseView } from "@/components/onboarding/OnboardingCaseView";

export const dynamic = "force-dynamic"; // Auth-gated + reads live case state.

/**
 * Onboarding case detail — deep-linkable from the list. Server-renders the
 * case + its checklist + documents via the in-process tRPC caller; the
 * client OnboardingCaseView owns the task/status mutations and keeps the
 * surface live.
 *
 * A missing / cross-tenant case surfaces as a 404 (the procedure throws
 * NOT_FOUND, RLS-scoped) rather than a raw error screen.
 */
export default async function OnboardingCaseDetailPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  const session = await requireAuth();
  const caller = createServerTRPCCaller(session);

  let initial: GetOnboardingCaseDetailOutput;
  try {
    initial = await caller.getOnboardingCaseDetail({ caseId });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "NOT_FOUND") {
      notFound();
    }
    throw err;
  }

  return (
    <AppShell
      title="Onboarding"
      isAdmin={session.roles.includes("admin")}
      roles={session.roles}
      active="onboarding"
      user={sessionUserChip(session)}
    >
      <OnboardingCaseView caseId={caseId} initial={initial} />
    </AppShell>
  );
}
