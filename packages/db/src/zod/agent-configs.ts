import { z } from "zod";

/**
 * Discriminated-union Zod schemas for the jsonb config columns on
 * agent_triggers and agent_actions, plus a placeholder for
 * agent_approval_rules.conditions.
 *
 * These schemas are NOT enforced by the database — Postgres only knows
 * the column is jsonb. Validation happens application-side at write
 * time (admin agent CRUD procedure, AGENT-02 onwards) and read time
 * (the worker before dispatch). Keeping the schemas in @hireops/db
 * means both the API surface and the worker can import the same source
 * of truth.
 *
 * Each member uses .strict() so unknown fields fail loud — better an
 * error than a silently-dropped config field that the worker later
 * misses.
 *
 * AGENT-01a ships exhaustive members for the 5 trigger types and 7
 * action types fixed in the chat-Claude design session (2026-05-28).
 * Field names are snake_case to match the jsonb storage convention.
 * Adding a new trigger or action type means: extend the CHECK
 * constraint on the table + add a member here + update the worker
 * dispatcher. The discriminated union forces all three to stay in
 * lockstep at typecheck time.
 */

// ───────────────────────────────────────────────────────────────────────────
// Trigger configs
// ───────────────────────────────────────────────────────────────────────────

/**
 * stage_stale: fires when an application has sat in a stage past a
 * days threshold. The application-side evaluator scans on a schedule
 * and enqueues a run per matching application.
 */
export const StageStaleTriggerConfigSchema = z
  .object({
    type: z.literal("stage_stale"),
    stage: z.string().min(1),
    days_threshold: z.number().int().positive(),
  })
  .strict();

/**
 * stage_entered: fires immediately when an application transitions
 * into the configured stage. Enqueue happens in the same tx as the
 * stage transition.
 */
export const StageEnteredTriggerConfigSchema = z
  .object({
    type: z.literal("stage_entered"),
    stage: z.string().min(1),
  })
  .strict();

/**
 * message_received: fires when a candidate_inbound_messages row lands
 * for an application in scope. AGENT-01a locks channel='email' and
 * from='candidate'; later tickets relax to other channels and senders.
 */
export const MessageReceivedTriggerConfigSchema = z
  .object({
    type: z.literal("message_received"),
    channel: z.literal("email"),
    from: z.literal("candidate"),
  })
  .strict();

/**
 * time_scheduled: cron-shaped recurring trigger. Cron parsing happens
 * in the worker — we store the string as-is. Timezone is required so
 * "every weekday at 9am" is unambiguous across tenant regions.
 */
export const TimeScheduledTriggerConfigSchema = z
  .object({
    type: z.literal("time_scheduled"),
    cron: z.string().min(1),
    timezone: z.string().min(1),
  })
  .strict();

/**
 * manual: fires when a human clicks "Run now" in the admin UI. No
 * payload because the trigger context comes from the click event.
 */
export const ManualTriggerConfigSchema = z
  .object({
    type: z.literal("manual"),
  })
  .strict();

export const TriggerConfigSchema = z.discriminatedUnion("type", [
  StageStaleTriggerConfigSchema,
  StageEnteredTriggerConfigSchema,
  MessageReceivedTriggerConfigSchema,
  TimeScheduledTriggerConfigSchema,
  ManualTriggerConfigSchema,
]);

export type TriggerConfig = z.infer<typeof TriggerConfigSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Action configs
// ───────────────────────────────────────────────────────────────────────────

/**
 * draft_message: LLM drafts a message body against a stored prompt
 * template. tone shapes the LLM system message; max_tokens caps the
 * output. Output is consumed by a subsequent send_message action.
 */
export const DraftMessageActionConfigSchema = z
  .object({
    type: z.literal("draft_message"),
    template_prompt_id: z.string().min(1),
    tone: z.enum(["formal", "friendly", "neutral"]),
    max_tokens: z.number().int().positive(),
  })
  .strict();

/**
 * send_message: dispatches via the notification outbox. outbox_kind
 * selects the worker-side handler ('notification', 'whatsapp_business',
 * etc. in future). requires_approval mirrors the approval-mode pattern
 * at the action level so a single agent can mix auto + approval-gated
 * sends.
 */
export const SendMessageActionConfigSchema = z
  .object({
    type: z.literal("send_message"),
    channel: z.literal("email"),
    outbox_kind: z.string().min(1),
    requires_approval: z.boolean(),
  })
  .strict();

/**
 * propose_calendar_slots: queries the calendar integration for free
 * slots within a window for the specified panel. Output is consumed by
 * a subsequent create_calendar_event action via source_action_ref.
 */
export const ProposeCalendarSlotsActionConfigSchema = z
  .object({
    type: z.literal("propose_calendar_slots"),
    panel_id: z.string().min(1),
    slot_count: z.number().int().positive(),
    window_days: z.number().int().positive(),
    duration_minutes: z.number().int().positive(),
  })
  .strict();

/**
 * create_calendar_event: books a slot proposed by an earlier action.
 * source_action_ref points to the prior propose_calendar_slots run-
 * action whose output supplies the chosen slot.
 */
export const CreateCalendarEventActionConfigSchema = z
  .object({
    type: z.literal("create_calendar_event"),
    panel_id: z.string().min(1),
    source_action_ref: z.string().min(1),
  })
  .strict();

/**
 * update_application_stage: advance or reject the application to a
 * specific stage. reason_template_id supplies the audit-log reason
 * text via a stored template — keeps the action config compact and
 * auditable.
 */
export const UpdateApplicationStageActionConfigSchema = z
  .object({
    type: z.literal("update_application_stage"),
    target_stage: z.string().min(1),
    reason_template_id: z.string().min(1),
  })
  .strict();

/**
 * notify_recruiter: sends an in-portal or email notification to the
 * recruiter assigned to the application, body rendered from a stored
 * prompt template.
 */
export const NotifyRecruiterActionConfigSchema = z
  .object({
    type: z.literal("notify_recruiter"),
    template_prompt_id: z.string().min(1),
    channel: z.enum(["in_portal", "email"]),
  })
  .strict();

/**
 * create_audit_entry: append a row to audit_logs for downstream
 * compliance reporting. payload_template_id renders the entry body;
 * event_type is the audit_logs.action-equivalent discriminator.
 */
export const CreateAuditEntryActionConfigSchema = z
  .object({
    type: z.literal("create_audit_entry"),
    event_type: z.string().min(1),
    payload_template_id: z.string().min(1),
  })
  .strict();

export const ActionConfigSchema = z.discriminatedUnion("type", [
  DraftMessageActionConfigSchema,
  SendMessageActionConfigSchema,
  ProposeCalendarSlotsActionConfigSchema,
  CreateCalendarEventActionConfigSchema,
  UpdateApplicationStageActionConfigSchema,
  NotifyRecruiterActionConfigSchema,
  CreateAuditEntryActionConfigSchema,
]);

export type ActionConfig = z.infer<typeof ActionConfigSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Approval conditions
// ───────────────────────────────────────────────────────────────────────────

/**
 * Placeholder for AGENT-01b conditional approval logic ("auto-approve
 * if cost_micros < N", "require approval if message length > N"). In
 * AGENT-01a the column is always NULL and this schema accepts an empty
 * object only.
 */
export const ApprovalConditionsSchema = z.object({}).strict().optional();

export type ApprovalConditions = z.infer<typeof ApprovalConditionsSchema>;
