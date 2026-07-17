import { CandidateShell } from "@/components/candidate/CandidateShell";
import { CandidateLoginClient } from "./CandidateLoginClient";

export const dynamic = "force-dynamic"; // reads ?tenant / ?email search params

/**
 * Candidate sign-in (CAND-01). Public (middleware allowlist). Email +
 * password against Supabase, resolving to a candidate identity; a first-time
 * candidate uses "Activate your account" to receive a signed link by email.
 *
 * Deliberately NOT the internal /login: candidates never see the recruiter
 * shell. Mobile-first CandidateShell like the apply / offer surfaces.
 */
export default function CandidateLoginPage() {
  return (
    <CandidateShell>
      <CandidateLoginClient />
    </CandidateShell>
  );
}
