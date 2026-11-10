"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { TenantLabels } from "@hireops/api-types";
import { applicationStageLabel, recommendationLabel } from "@/lib/labels";

/**
 * CFG-LITE — carries the tenant's display labels (`tenants.settings.labels`,
 * resolved server-side in lib/tenant-ui-settings.ts) from the root layout to
 * every component that names a pipeline stage or an interview recommendation.
 * Outside the provider (tests, stories, signed-out pages) the value is null and
 * every label is the platform default — byte-identical to before.
 */
const TenantLabelsContext = createContext<TenantLabels | null>(null);

export function TenantLabelsProvider({
  labels,
  children,
}: {
  labels: TenantLabels | null;
  children: ReactNode;
}) {
  return <TenantLabelsContext.Provider value={labels}>{children}</TenantLabelsContext.Provider>;
}

export function useTenantLabels(): TenantLabels | null {
  return useContext(TenantLabelsContext);
}

/** `applicationStageLabel` bound to the tenant's labels. */
export function useApplicationStageLabel(): (stage: string | null | undefined) => string {
  const labels = useTenantLabels();
  return useCallback((stage) => applicationStageLabel(stage, labels), [labels]);
}

/** `recommendationLabel` bound to the tenant's labels. */
export function useRecommendationLabel(): (rec: string | null | undefined) => string {
  const labels = useTenantLabels();
  return useCallback((rec) => recommendationLabel(rec, labels), [labels]);
}

/**
 * Client leaf that prints a recommendation's tenant label. Lets a component
 * that may render on the server (e.g. RecommendationChip inside a server page)
 * still show the tenant's wording — the provider context reaches client leaves
 * anywhere under the root layout.
 */
export function RecommendationText({ rec }: { rec: string }) {
  const label = useRecommendationLabel();
  return <>{label(rec)}</>;
}
