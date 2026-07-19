import { CandidateDocumentsClient } from "./CandidateDocumentsClient";

export const dynamic = "force-dynamic"; // auth-gated + live candidate state

/**
 * Candidate documents (CAND-02). One clean page unifying the two real document
 * flows — pre-offer verification documents (HR-requested) and post-accept
 * onboarding documents — with status chips and the real upload affordance.
 * Reuses the existing procedures + REST upload; presentation elevation only.
 */
export default function CandidateDocumentsPage() {
  return <CandidateDocumentsClient />;
}
