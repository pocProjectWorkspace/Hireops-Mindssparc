import { CandidateApplicationsClient } from "./CandidateApplicationsClient";

export const dynamic = "force-dynamic"; // auth-gated + live candidate state

/**
 * Candidate → Applications (CAND-01). The application timeline as a vertical
 * stepper. Neutral status only — NO AI score, no "top factors", no feedback.
 */
export default function CandidateApplicationsPage() {
  return <CandidateApplicationsClient />;
}
