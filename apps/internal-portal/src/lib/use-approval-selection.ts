"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Selection state for the approval queue, backed by `?approvalId=` — same
 * URL-as-state approach as the triage drawer (use-drawer-routing). This
 * makes a selected approval deep-linkable and survives a refresh, which
 * matters for the demo (present the queue, click a candidate, the URL is
 * shareable).
 */
export function useApprovalSelection() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const selectedId = searchParams.get("approvalId");

  const select = useCallback(
    (id: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("approvalId", id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const clear = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("approvalId");
    router.replace(params.size > 0 ? `${pathname}?${params.toString()}` : pathname, {
      scroll: false,
    });
  }, [router, pathname, searchParams]);

  return { selectedId, select, clear };
}
