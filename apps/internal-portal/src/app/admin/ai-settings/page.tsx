import { PageContainer } from "@/components/nav/PageContainer";
import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { PageHeader } from "@/components/patterns";
import { AiModelOverview } from "./AiModelOverview";
import { AiSettingsClient } from "./AiSettingsClient";
import { BiasLexiconClient } from "./BiasLexiconClient";
import { ScoringWeightsClient } from "./ScoringWeightsClient";
import { IrisPolicyClient } from "./IrisPolicyClient";

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
  const [settings, usage, lexicon, weights, irisPolicy] = await Promise.all([
    caller.getTenantAiSettings({}),
    caller.getAiUsageSummary({ from }),
    caller.getBiasLexicon({}),
    caller.getScoringWeights({}),
    // Resilient: if the API build predates getIrisPolicy the whole page must
    // not 500 — degrade to a muted "unavailable" note instead.
    caller.getIrisPolicy({}).catch(() => null),
  ]);

  return (
    <AppShell title="AI settings" isAdmin active="ai-settings" user={sessionUserChip(session)}>
      <PageContainer variant="measure" className="pt-8">
        <PageHeader
          title="AI settings"
          subtitle="Model, scoring emphasis, bias gate and compliance: every control here is consumed by the real AI call path."
        />
      </PageContainer>
      <AiModelOverview usage={usage} />
      <AiSettingsClient initialSettings={settings} usage={usage} />
      <ScoringWeightsClient initialWeights={weights} />
      {irisPolicy ? (
        <IrisPolicyClient initial={irisPolicy} />
      ) : (
        <PageContainer variant="measure">
          <p className="text-sm text-neutral-500">Iris action policy is unavailable right now.</p>
        </PageContainer>
      )}
      <BiasLexiconClient initialLexicon={lexicon} />
    </AppShell>
  );
}
