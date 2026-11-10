import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { DiversitySlateClient } from "./DiversitySlateClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin diverse slate (PC-26) — the tenant `diversitySlate` block: whether
 * voluntary self-ID is collected and slates are checked, the default minimum,
 * which stages make up "the slate", and which self-ID answers count.
 *
 * Gated to {admin, hr_head}; the get/updateDiversitySlateSettings procedures
 * enforce the same roles server-side (DIVERSE_SLATE_ADMIN_ROLES).
 */
export default async function DiversitySlatePage() {
  const session = await requireAuth();
  if (!session.roles.includes("admin") && !session.roles.includes("hr_head")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getDiversitySlateSettings();

  return (
    <AppShell
      title="Diverse slate"
      isAdmin
      active="diversity-slate"
      user={sessionUserChip(session)}
    >
      <DiversitySlateClient initial={initial} />
    </AppShell>
  );
}
