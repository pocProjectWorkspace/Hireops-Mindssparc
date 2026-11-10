import { CandidateWelcomeClient } from "./CandidateWelcomeClient";

export const dynamic = "force-dynamic"; // auth-gated + live candidate state

/**
 * PC-18 — "Welcome to <company>": the published welcome guide for the hire's
 * business unit (else the nearest parent unit's, else the organisation
 * default), shown between offer acceptance and joining. The pre-joining
 * journey's welcome-guide email links here.
 */
export default function CandidateWelcomePage() {
  return <CandidateWelcomeClient />;
}
