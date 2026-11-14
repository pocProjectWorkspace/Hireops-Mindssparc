import { requireAuth, sessionCan, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { PageContainer } from "@/components/nav/PageContainer";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { MarketIntelligenceView } from "@/components/market/MarketIntelligenceView";

export const dynamic = "force-dynamic"; // Auth-gated + reads live benchmark data.

/**
 * HRHEAD-02 — Market Intelligence (honest, curated benchmarks).
 *
 * The prototype's benchmark table FAKES its numbers. This is real, curated,
 * tenant-editable reference data (market_benchmarks), clearly labelled via each
 * row's source_note. hr_head + admin + hiring_manager read; admin edits inline.
 * A direct hit by another role gets a calm in-shell notice.
 */

export default async function MarketIntelligencePage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = sessionCan(session, "market_intel.read");

  if (!allowed) {
    return (
      <AppShell
        title="Market intel"
        isAdmin={isAdmin}
        roles={session.roles}
        active="market-intelligence"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Market intelligence isn't available for your role"
          hint="This surface is for the HR head and hiring managers. If you need access, ask an administrator to update your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listMarketBenchmarks({});

  return (
    <AppShell
      title="Market intel"
      isAdmin={isAdmin}
      roles={session.roles}
      active="market-intelligence"
      user={sessionUserChip(session)}
    >
      <PageContainer>
        <MarketIntelligenceView initial={initial} canEdit={isAdmin} />
      </PageContainer>
    </AppShell>
  );
}
