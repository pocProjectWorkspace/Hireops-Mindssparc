/**
 * C1-BUGS BUG-12 — candidate-ownership exclusivity SCOPE.
 *
 * `partner_msa.exclusivity_scope` was stored but never read. Its meaning
 * (requirements.md "What ownership grants", architecture.md §7.8):
 *
 *   - org_wide (default) — the claiming partner owns the candidate across the
 *     whole tenant for the window: any other partner's submission of that
 *     person, against ANY requisition, is blocked.
 *   - req_only — the MSA narrows the claim to the requisition it was made
 *     against: another partner may still submit the same person to a
 *     DIFFERENT requisition (and owns that submission); only a submission
 *     against the claimed requisition is blocked.
 *
 * The scope is snapshotted onto the claim at creation
 * (`candidate_ownership_claims.exclusivity_scope` + `requisition_id`,
 * migration 0132), exactly as the window is snapshotted into `expires_at`:
 * changing an MSA later never rewrites claims already made.
 *
 * Pure — no DB. The router reads the person's active claims and asks
 * `resolveClaimForSubmission` what the submission is.
 */

export type ExclusivityScope = "org_wide" | "req_only";

export interface ActiveClaimView {
  id: string;
  partnerOrgId: string;
  exclusivityScope: ExclusivityScope | string;
  /** The requisition a req_only claim is limited to; null for org_wide. */
  requisitionId: string | null;
}

/** Does an active claim's exclusivity cover a submission to `requisitionId`? */
export function claimCoversRequisition(claim: ActiveClaimView, requisitionId: string): boolean {
  if (claim.exclusivityScope === "req_only") return claim.requisitionId === requisitionId;
  // org_wide — and anything unrecognised fails CLOSED to the wider scope.
  return true;
}

export type ClaimSubmissionDecision<C extends ActiveClaimView> =
  /** Another partner's claim covers this requisition → duplicate_blocked. */
  | { kind: "blocked"; claim: C }
  /** The submitting partner's own claim covers it → add under that claim. */
  | { kind: "own"; claim: C }
  /** Nothing covers it → a new claim for the submitting partner. */
  | { kind: "new" };

/**
 * Decide a partner submission of a person against `requisitionId`, given the
 * person's ACTIVE claims. Another org's covering claim wins over the
 * submitter's own (the first valid submission owns it); among several, the
 * order supplied (oldest first) decides which one is reported.
 */
export function resolveClaimForSubmission<C extends ActiveClaimView>(
  activeClaims: readonly C[],
  partnerOrgId: string,
  requisitionId: string,
): ClaimSubmissionDecision<C> {
  const blocking = activeClaims.find(
    (c) => c.partnerOrgId !== partnerOrgId && claimCoversRequisition(c, requisitionId),
  );
  if (blocking) return { kind: "blocked", claim: blocking };
  const own = activeClaims.find(
    (c) => c.partnerOrgId === partnerOrgId && claimCoversRequisition(c, requisitionId),
  );
  if (own) return { kind: "own", claim: own };
  return { kind: "new" };
}

/**
 * The scope + requisition a NEW claim is created with: the org's live MSA
 * scope (no MSA → org_wide, the documented default), with the requisition
 * recorded only when the claim is limited to it.
 */
export function newClaimScope(
  msaScope: string | null | undefined,
  requisitionId: string,
): { exclusivityScope: ExclusivityScope; requisitionId: string | null } {
  return msaScope === "req_only"
    ? { exclusivityScope: "req_only", requisitionId }
    : { exclusivityScope: "org_wide", requisitionId: null };
}
