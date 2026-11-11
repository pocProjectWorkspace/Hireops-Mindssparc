"use client";

/**
 * Role DISPLAY labels in the portal (PC-23) — the one client helper the user
 * chip, user admin and role pickers go through. Reads the tenant's
 * `roleLabels` (getRoleLabels, cached 5 min) and resolves through the shared
 * `roleLabel` helper in @hireops/api-types; until the query lands (or if it
 * fails) every label is the platform default, which is what the portal showed
 * before PC-23. Presentation only — role keys and permissions never change.
 */

import { useCallback } from "react";
import { DEFAULT_ROLE_LABELS, roleLabel, type RoleLabels } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";

const FIVE_MINUTES = 5 * 60 * 1000;

/** The effective tenant labels (platform default while loading). */
export function useRoleLabels(): RoleLabels {
  const q = trpc.getRoleLabels.useQuery(
    {},
    { staleTime: FIVE_MINUTES, retry: false, refetchOnWindowFocus: false },
  );
  return (q.data?.labels as RoleLabels | undefined) ?? DEFAULT_ROLE_LABELS;
}

/** `(roleKey) => display label`, tenant-aware. */
export function useRoleLabel(): (role: string | null | undefined) => string {
  const labels = useRoleLabels();
  return useCallback((role) => roleLabel(role, labels), [labels]);
}

/** Inline role name for server-rendered shells (the sidebar user chip). */
export function RoleName({ role, fallback }: { role?: string; fallback?: string }) {
  const label = useRoleLabel();
  const text = role ? label(role) : (fallback ?? "");
  return <>{text}</>;
}
