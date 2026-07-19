import { CandidateNotificationsClient } from "./CandidateNotificationsClient";

export const dynamic = "force-dynamic"; // auth-gated + live candidate state

/**
 * Candidate notifications (CAND-02). A person-scoped feed of the REAL
 * candidate-directed notification_outbox rows (interview invitations, stage
 * advances, offer/activation, document reminders). Nothing is fabricated.
 */
export default function CandidateNotificationsPage() {
  return <CandidateNotificationsClient />;
}
