import { ActionConfigMismatchError, type ActionExecutor } from "../types";

/**
 * send_message — REAL (FOLLOWUP-01). Supersedes the AGENT-02 stub.
 *
 * Enqueues the approved draft into `notification_outbox`. It never calls
 * the EmailProvider directly — Module 3's outbox-first rule (HANDOVER
 * #62) means the notification drain owns dispatch.
 *
 * ── Ordering contract ────────────────────────────────────────────────
 * This is the effectful action, so it must NOT be the gated one. The
 * drain executes-then-gates and skips re-execution on resume (see
 * agent-run-drain.ts and approveApprovalWithEdit's "skips re-execution"
 * note), so a gated send would fire BEFORE the human approved it.
 * FOLLOWUP-01 moved the gate onto the preceding `draft_message`; by the
 * time this runs, the draft in `previousActionOutputs` is either the
 * model's original or the recruiter's edited replacement
 * (approveApprovalWithEdit overwrites `agent_run_actions.output`
 * wholesale). Either way this reads the final approved text. That is the
 * whole point of the ordering.
 *
 * `requiresApproval` still mirrors `config.requires_approval` so an
 * operator who deliberately attaches a human gate here gets the
 * historical behaviour rather than a silently-ignored flag — but the
 * curated Follow-Up agent sets it false and pins the rule to 'auto'.
 *
 * ── Idempotency ──────────────────────────────────────────────────────
 * `dedupKey` is the run-action id, so a drain pass retried after a crash
 * between "enqueue" and "mark completed" cannot double-send. The worker's
 * `enqueueEmail` swallows the 23505 from the partial UNIQUE on
 * (tenant_id, dedup_key) and returns the existing row.
 */

interface DraftLike {
  draft_text: string;
  subject?: unknown;
  candidate_email?: unknown;
  candidate_id?: unknown;
  candidate_name?: unknown;
  position_title?: unknown;
  company_name?: unknown;
}

function isDraftLike(value: unknown): value is DraftLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { draft_text?: unknown }).draft_text === "string" &&
    (value as { draft_text: string }).draft_text.trim().length > 0
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`send_message: approved draft is missing '${field}'`);
  }
  return value;
}

export const sendMessageExecutor: ActionExecutor = async ({
  config,
  tenantId,
  runActionId,
  previousActionOutputs,
  deps,
}) => {
  if (config.type !== "send_message") {
    throw new ActionConfigMismatchError("send_message", config.type);
  }

  // Scan by shape, not by hard-coded action_order — HR can reorder or
  // insert actions, so the curated ordering (draft=1, send=2) is a
  // convention rather than a constraint. Highest order wins, so a later
  // draft supersedes an earlier one.
  const draft = Object.keys(previousActionOutputs)
    .map(Number)
    .sort((a, b) => b - a)
    .map((order) => previousActionOutputs[order])
    .find(isDraftLike);

  if (!draft) {
    throw new Error(
      "send_message: no preceding action produced a non-empty draft_text. " +
        "A send_message action must follow a draft_message action.",
    );
  }

  const recipientEmail = requireString(draft.candidate_email, "candidate_email");
  const subject = requireString(draft.subject, "subject");
  const candidateId = typeof draft.candidate_id === "string" ? draft.candidate_id : null;

  const { outboxId } = await deps.enqueueEmail(tenantId, {
    recipientEmail,
    recipientCandidateId: candidateId,
    templateKey: "candidate.agent_message",
    templateData: {
      candidateName: requireString(draft.candidate_name, "candidate_name"),
      companyName: requireString(draft.company_name, "company_name"),
      positionTitle: requireString(draft.position_title, "position_title"),
      body: draft.draft_text,
      // The dispatcher renders from templateData and uses
      // `rendered.subject`, ignoring notification_outbox.subject. Agent
      // messages are the only template whose subject is caller-owned, so
      // it must travel here as well as in the column (which stays
      // populated for SQL inspection of the outbox).
      subject,
    },
    subject,
    dedupKey: `agent_run_action:${runActionId}`,
  });

  return {
    output: {
      sent: true,
      channel: config.channel,
      outbox_kind: config.outbox_kind,
      notification_outbox_id: outboxId,
      recipient_email: recipientEmail,
      subject,
    },
    costMicros: 0n,
    requiresApproval: config.requires_approval,
  };
};
