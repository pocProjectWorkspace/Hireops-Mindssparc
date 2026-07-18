import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { AiSettingsClient } from "./AiSettingsClient";
import { BiasLexiconClient } from "./BiasLexiconClient";
import { ScoringWeightsClient } from "./ScoringWeightsClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live tenant config.

/**
 * Admin AI settings (CONF-01) — the per-tenant governance surface for the
 * three real AI consumers (candidate scoring, JD generation, agent drafts)
 * plus the global PII-masking switch. Every control here is consumed by the
 * real ai-client call path; nothing on this page is cosmetic.
 *
 * Admin-gated twice: requireAdmin (page redirect) AND the procedures
 * themselves (getTenantAiSettings / updateTenantAiSettings enforce the
 * admin role server-side). Server-prefetches the effective settings and the
 * last-30-day usage rollup so each feature card lands with its live usage
 * context.
 */
export default async function AiSettingsPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [settings, usage, lexicon, weights] = await Promise.all([
    caller.getTenantAiSettings({}),
    caller.getAiUsageSummary({ from }),
    caller.getBiasLexicon({}),
    caller.getScoringWeights({}),
  ]);

  return (
    <AppShell title="AI settings" isAdmin active="ai-settings" user={sessionUserChip(session)}>
      <AiSettingsClient initialSettings={settings} usage={usage} />
      <ScoringWeightsClient initialWeights={weights} />
      <BiasLexiconClient initialLexicon={lexicon} />
    </AppShell>
  );
}
