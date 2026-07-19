import { CandidateInterviewsClient } from "./CandidateInterviewsClient";

export const dynamic = "force-dynamic"; // auth-gated + live candidate state

/**
 * Candidate → Interviews (CAND-01). Upcoming (schedule + meeting link + confirm)
 * and past (score-free, tenant-gated shared summary only). No live room, no
 * scores, no raw feedback.
 */
export default function CandidateInterviewsPage() {
  return <CandidateInterviewsClient />;
}
