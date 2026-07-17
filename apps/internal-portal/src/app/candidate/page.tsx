import { CandidateDashboardClient } from "./CandidateDashboardClient";

export const dynamic = "force-dynamic"; // auth-gated + live candidate state

/**
 * Candidate dashboard (CAND-01). The candidate's world in one place:
 * applications with a stage stepper, interviews with confirm-from-portal, and
 * a quiet placeholder for documents + offers (CAND-02).
 *
 * Middleware guarantees a Supabase session here; the client resolves the
 * candidate identity via candidateGetMe and shows a calm "not a candidate
 * account" screen if the signed-in identity is internal/partner.
 */
export default function CandidateDashboardPage() {
  return <CandidateDashboardClient />;
}
