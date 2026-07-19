/**
 * Shared INR paise formatters for the Comp & offer desk (HROPS-02). All comp
 * money crosses the wire as INR paise (minor units); this is the display
 * boundary. Currency is INR-only for the demo tenant (the prototype's AED is
 * deliberately ignored — HANDOVER: use the existing INR convention).
 */

/** paise → "₹24.0 LPA" (lakhs per annum), the compact desk label. */
export function paiseToLpa(paise: number | null): string | null {
  if (paise == null) return null;
  const lpa = paise / 100 / 100_000;
  return `₹${lpa.toFixed(1).replace(/\.0$/, "")} LPA`;
}

/** paise → "₹24,00,000" (full grouped rupees). */
export function paiseToInr(paise: number | null): string | null {
  if (paise == null) return null;
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

/** MINOR benchmark median (paise) → "₹24.0 LPA". */
export function minorToLpa(minor: number | null): string | null {
  return paiseToLpa(minor);
}
