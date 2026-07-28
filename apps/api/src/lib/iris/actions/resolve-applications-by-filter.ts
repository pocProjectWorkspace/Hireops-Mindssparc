/**
 * Shared filter → concrete-set resolver for the IRIS-B2 bulk pipeline actions
 * (bulk_advance_applications, bulk_reject_applications).
 *
 * HONESTY. This is a READ. It runs the SAME gated `listCandidatesByRequisition`
 * procedure the recruiter's "All candidates" surface uses (its own RLS +
 * role gate fire through the in-process caller) and simply narrows the result to
 * the applications of ONE requisition that are currently at the given stage. The
 * bulk actions then LOOP the real per-entity gated procedure over exactly this
 * set — there is no bulk write path, and the preview shows this same set before
 * the user confirms.
 */

import type { ApplicationStage } from "@hireops/api-types";
import type { IrisCaller, IrisResolvedEntity } from "../registry";

/** Sentence-case a stage token for a human-readable label (e.g. "recruiter_review"
 * → "Recruiter review"). Pure display sugar, no data invented. */
export function humanizeStage(stage: string): string {
  const words = stage.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Resolve (requisition + current stage) to the concrete affected applications —
 * `{ entityId: applicationId, label: "<candidate> — <stage>" }` per row. Returns
 * an empty list when nothing matches (the caller surfaces an honest "no matches"
 * state rather than offering a confirm).
 */
export async function resolveApplicationsByFilter(
  caller: IrisCaller,
  requisitionId: string,
  fromStage: ApplicationStage,
): Promise<IrisResolvedEntity[]> {
  // The gated read is already stage-filtered server-side; the requisition group
  // then narrows to this one requisition. Re-filter defensively on stage.
  const res = await caller.listCandidatesByRequisition({ stage: fromStage });
  const group = res.groups.find((g) => g.requisitionId === requisitionId);
  if (!group) return [];
  return group.rows
    .filter((r) => r.stage === fromStage)
    .map((r) => ({
      entityId: r.applicationId,
      label: `${r.fullName ?? "Candidate"} — ${humanizeStage(r.stage)}`,
    }));
}
