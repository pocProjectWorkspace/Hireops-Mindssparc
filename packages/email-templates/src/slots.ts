import type { ReactNode } from "react";
import { interpolateSlot } from "./catalog";

/**
 * Slot-override plumbing shared by every template (T1.4 / G09).
 *
 * A template exposes each static text run through `resolveSlot`: when the
 * tenant has NO override for that slot the template's own JSX fallback is
 * returned UNCHANGED (so the render is byte-identical to today, inline
 * emphasis/links and all). When an override string IS present it is
 * token-interpolated against the template's data and rendered as plain text —
 * never as HTML, so an override can style copy but cannot inject markup or
 * break a data binding.
 */
export type SlotOverrides = Record<string, string>;

/**
 * @param override  the tenant's override string for this slot (or undefined)
 * @param tokens    the template's data values, keyed by token name
 * @param fallback  the template's shipped JSX for this text run
 */
export function resolveSlot(
  override: string | undefined,
  tokens: Record<string, string>,
  fallback: ReactNode,
): ReactNode {
  if (override === undefined) return fallback;
  return interpolateSlot(override, tokens);
}
