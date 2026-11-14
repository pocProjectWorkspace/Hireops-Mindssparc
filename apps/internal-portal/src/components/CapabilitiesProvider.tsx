"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Capability, CapabilityBundle } from "@hireops/api-types";
import { capsAllow } from "@/lib/nav-capabilities";

/**
 * C2-F1 — the signed-in member's effective capabilities, resolved once per
 * request in app/layout.tsx (lib/permissions.ts) and read by the nav, the
 * onboarding journey and client islands. `null` = signed out: only un-gated
 * items show. Display only: the API enforces every capability.
 */
const CapabilitiesContext = createContext<CapabilityBundle | null>(null);

export function CapabilitiesProvider({
  caps,
  children,
}: {
  caps: CapabilityBundle | null;
  children: ReactNode;
}) {
  return <CapabilitiesContext.Provider value={caps}>{children}</CapabilitiesContext.Provider>;
}

export function useCapabilities(): CapabilityBundle | null {
  return useContext(CapabilitiesContext);
}

/** `(gate) => boolean` for the signed-in member. */
export function useCapabilityFilter(): (gate: readonly Capability[] | undefined) => boolean {
  const held = useContext(CapabilitiesContext);
  return (gate) => capsAllow(held, gate);
}
