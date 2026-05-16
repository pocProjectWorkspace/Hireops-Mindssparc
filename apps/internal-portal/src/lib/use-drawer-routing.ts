"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

/**
 * Shallow-route control for the candidate drawer. URL pattern:
 *   /triage?candidateId=<cid>&applicationId=<aid>
 *
 * candidateId drives "which person is in the drawer"; applicationId
 * is what Advance/Reject operate on (one candidate can have multiple
 * applications). The ticket specified only candidateId but the triage
 * card is application-centric, so we carry both — deep-link safe +
 * mutation-ready.
 *
 * Filter chip params (requisitionId / stage / source) coexist in the
 * URL and are preserved across open/close.
 *
 * Browser back: when the URL changes (popstate), Next re-evaluates
 * search params and the drawer unmounts. No explicit popstate
 * listener needed.
 */

export function useDrawerRouting() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const candidateId = searchParams.get("candidateId");
  const applicationId = searchParams.get("applicationId");

  const open = useCallback(
    (ids: { candidateId: string; applicationId: string }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("candidateId", ids.candidateId);
      params.set("applicationId", ids.applicationId);
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const close = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("candidateId");
    params.delete("applicationId");
    router.push(params.size > 0 ? `${pathname}?${params.toString()}` : pathname, {
      scroll: false,
    });
  }, [router, pathname, searchParams]);

  return { candidateId, applicationId, open, close };
}
