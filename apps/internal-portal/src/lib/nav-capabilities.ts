import { hasAnyCapability, type Capability, type CapabilityBundle } from "@hireops/api-types";

/**
 * C2-F1 — the nav's capability rule, pure (no "use client") so server and
 * client modules can both import it. No gate → visible; otherwise the member
 * holds ANY of `gate`. `held === null` (signed out) shows only un-gated items.
 */
export function capsAllow(
  held: CapabilityBundle | null,
  gate: readonly Capability[] | undefined,
): boolean {
  if (!gate || gate.length === 0) return true;
  if (!held) return false;
  return hasAnyCapability({ caps: held }, gate);
}
