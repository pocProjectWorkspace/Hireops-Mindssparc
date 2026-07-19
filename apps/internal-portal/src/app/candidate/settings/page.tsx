import { CandidateSettingsClient } from "./CandidateSettingsClient";

export const dynamic = "force-dynamic"; // auth-gated

/**
 * Candidate → Settings (CAND-01). A minimal placeholder for now — account
 * controls (notification preferences, password) land in a later pass. Honest
 * about being a stub rather than faking toggles that do nothing.
 */
export default function CandidateSettingsPage() {
  return <CandidateSettingsClient />;
}
