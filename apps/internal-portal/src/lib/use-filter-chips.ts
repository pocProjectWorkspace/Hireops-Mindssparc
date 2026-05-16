"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { ApplicationStage, ApplicationSource } from "@hireops/api-types";

/**
 * URL-backed filter state for the triage screen. State lives in
 * search params so:
 *   - Filters survive drawer open/close (drawer adds ?candidateId
 *     alongside).
 *   - Filter URLs are shareable (a recruiter can DM a colleague
 *     "look at the iOS req filtered list" with a single link).
 *   - Browser back/forward navigates filter history naturally.
 *
 * Setting a filter to null/undefined removes the param. Returning
 * the merged URLSearchParams object lets callers compose with
 * existing params (notably candidateId).
 */

export interface TriageFilters {
  requisitionId: string | null;
  stage: ApplicationStage | null;
  source: ApplicationSource | null;
}

const KEYS = ["requisitionId", "stage", "source"] as const;

export function useFilterChips() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filters = useMemo<TriageFilters>(
    () => ({
      requisitionId: searchParams.get("requisitionId"),
      stage: searchParams.get("stage") as ApplicationStage | null,
      source: searchParams.get("source") as ApplicationSource | null,
    }),
    [searchParams],
  );

  const set = useCallback(
    (next: Partial<TriageFilters>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const k of KEYS) {
        const v = next[k];
        if (v === undefined) continue;
        if (v === null) params.delete(k);
        else params.set(k, String(v));
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const clearAll = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const k of KEYS) params.delete(k);
    router.push(params.size > 0 ? `${pathname}?${params.toString()}` : pathname, {
      scroll: false,
    });
  }, [router, pathname, searchParams]);

  const isAnyActive =
    filters.requisitionId !== null || filters.stage !== null || filters.source !== null;

  return { filters, set, clearAll, isAnyActive };
}
