/**
 * C1-BUGS BUG-10 — offer expiry.
 *
 * An `extended` offer whose `expiry_at` has passed is EXPIRED, whether or not
 * the worker's offer-expiry scan has flipped the row yet (it runs every 15
 * minutes). Every read that shows an offer status goes through
 * `effectiveOfferStatus`, so a recruiter or candidate never sees "extended" on
 * an offer that can no longer be accepted. Pure.
 */
export function effectiveOfferStatus<S extends string>(
  status: S,
  expiryAt: Date | string | null | undefined,
  now: Date = new Date(),
): S | "expired" {
  if (status !== "extended" || expiryAt === null || expiryAt === undefined) return status;
  const t = expiryAt instanceof Date ? expiryAt.getTime() : new Date(expiryAt).getTime();
  if (Number.isNaN(t)) return status;
  return t <= now.getTime() ? "expired" : status;
}
