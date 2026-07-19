import { CandidateProfileClient } from "./CandidateProfileClient";

export const dynamic = "force-dynamic"; // auth-gated + live candidate state

/**
 * Candidate self-service profile (CAND-02). The candidate views + edits their
 * own contact and professional details — the exact "missing info" recruiters
 * chase. Person-scoped by the API; a non-candidate identity gets a calm notice.
 */
export default function CandidateProfilePage() {
  return <CandidateProfileClient />;
}
