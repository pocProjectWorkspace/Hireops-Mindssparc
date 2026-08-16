/**
 * Money formatting for MINOR units (paise, cents) — the partner-commercials
 * idiom.
 *
 * Lifted verbatim out of `PartnerOrgDetailClient` (P2.2) when the /reports
 * partner scorecard (R1.3) needed the same rendering: two surfaces showing
 * the same `partner_fees.fee_minor` must agree to the rupee, and a second
 * hand-rolled `Intl.NumberFormat` call is exactly how they stop agreeing.
 *
 * This is NOT `formatCostMicros` (`@/lib/approval-format`). That one renders
 * `ai_usage_logs.cost_micros` — USD at 1,000,000 micros to the dollar, with
 * sub-cent precision for AI spend. Fees are minor units at 100 to the major
 * unit, in the org's own currency. Two different scales; keeping them as two
 * functions is the point.
 */

/**
 * Minor units + ISO currency → a localised money string; null → em dash.
 *
 * The locale is fixed to en-IN (lakh/crore grouping) because the POC's
 * commercial reality is Indian rupees; the currency itself still comes from
 * the row, so a non-INR org renders in its own currency with Indian
 * grouping rather than silently rendering the wrong symbol. An unknown
 * currency code falls back to "<amount> <CODE>" rather than throwing.
 */
export function formatFeeMinor(amountMinor: number | null, currency: string): string {
  if (amountMinor === null) return "—";
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(
      amountMinor / 100,
    );
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}
