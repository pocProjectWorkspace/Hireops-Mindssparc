import { CandidateLearningClient } from "./CandidateLearningClient";

export const dynamic = "force-dynamic"; // auth-gated + live candidate state

/**
 * Candidate learning (LD-1B). The hire's own view of the learning a recruiter
 * has pushed onto their onboarding case: grouped by layer (about the
 * organisation / for your role / picked for you), each item an outbound link to
 * where the material actually lives, plus a self-attested progress control.
 *
 * HireOps hosts none of this — every item opens in the provider's own tab.
 */
export default function CandidateLearningPage() {
  return <CandidateLearningClient />;
}
