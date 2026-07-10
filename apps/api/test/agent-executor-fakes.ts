import type { ExecutorDeps } from "@hireops/agent-actions";

/**
 * Fake ExecutorDeps for the DB-backed drain tests.
 *
 * These tests exercise the DRAIN — claim, resume probe, approval gate,
 * run-action bookkeeping — against real Postgres. They are not testing
 * the executors' own behaviour (that lives in
 * `packages/agent-actions/test/follow-up-executors.test.ts`, which is
 * pure and needs no DB at all).
 *
 * Before FOLLOWUP-01 every executor was a stub, so the drain tests could
 * seed a fake `application_id` and let the executors run for real. Now
 * that `draft_message` and `send_message` are real, running them would
 * mean (a) a live `applications` row per test, (b) a LocalAIClient
 * fixture keyed by the exact prompt bytes, and (c) a notification_outbox
 * row per drain pass. All three would couple the drain tests to
 * unrelated schema and prompt copy, so we inject fakes instead and keep
 * the drain tests about the drain.
 *
 * `enqueued` is exposed so a test can assert that an approval-gated run
 * enqueued NOTHING before the human approved — the regression FOLLOWUP-01
 * fixed.
 */
export interface FakeExecutorDeps extends ExecutorDeps {
  enqueued: { tenantId: string; recipientEmail: string; dedupKey: string | null }[];
}

export function fakeExecutorDeps(): FakeExecutorDeps {
  const enqueued: FakeExecutorDeps["enqueued"] = [];
  let seq = 0;

  return {
    enqueued,
    async loadApplicationContext(_tenantId, applicationId) {
      return {
        applicationId,
        candidateId: "fake-candidate",
        candidateName: "Test Candidate",
        candidateEmail: "candidate@example.test",
        positionTitle: "Senior Backend Engineer",
        companyName: "Kyndryl GCC",
        stage: "tech_interview",
        daysInStage: 7,
        jdSummary: "A fake JD summary.",
      };
    },
    async draftWithAI() {
      // Deterministic — no LocalAIClient fixture, no tokens, no network.
      return { text: "Fake drafted follow-up body.", costMicros: 500n };
    },
    async enqueueEmail(tenantId, req) {
      seq += 1;
      enqueued.push({
        tenantId,
        recipientEmail: req.recipientEmail,
        dedupKey: req.dedupKey,
      });
      return { outboxId: `fake-outbox-${seq}` };
    },
  };
}
