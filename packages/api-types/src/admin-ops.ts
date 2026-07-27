/**
 * Admin operations surfaces (AD-03) — shared zod + types for the admin
 * persona's audit-export, email messaging log, and system-setup screens.
 *
 * Three honest, deterministic building blocks:
 *
 *   1. Audit severity — a PURE, deterministic classifier derived from the
 *      audit row's own `action` + `entity_type`. There is no `severity`
 *      column on `audit_logs`; we never invent one server-side. Severity is
 *      a UI/reporting lens computed identically wherever it's shown (the
 *      elevated audit table, the CSV export column). Honest: it reflects the
 *      DML verb and whether the touched table is security/state-sensitive —
 *      nothing about people.
 *
 *   2. Email messaging — the REAL notification system is the
 *      `notification_outbox` (email via Resend behind config). This exposes a
 *      read-only, tenant-scoped, admin-gated delivery log plus a registry of
 *      the REAL code-owned email templates. There is deliberately NO WhatsApp
 *      / SMS channel and NO delivery/read-receipt telemetry — we don't have
 *      them, so we don't fake them.
 *
 *   3. System setup — email-alert recipients + simple escalation rules,
 *      persisted in `tenants.settings` jsonb under `systemSetup` (the same
 *      atomic-merge discipline as `biasLexicon` / `scoringWeights`). The full
 *      tenant-configurable SLA-threshold table stays Phase-3 deferred; the SLA
 *      hours remain hardcoded in `@hireops/sla-thresholds`.
 */

import { z } from "zod";
import { auditEventRowSchema } from "./procedures";

// ─────────────────────────── audit severity ───────────────────────────

/** The reporting severity lens. Derived, never stored. */
export const AUDIT_SEVERITIES = ["info", "warning", "critical"] as const;
export const auditSeveritySchema = z.enum(AUDIT_SEVERITIES);
export type AuditSeverity = z.infer<typeof auditSeveritySchema>;

/**
 * Tables where ANY change is security-critical (access, identity, secrets,
 * the audit ledger itself). A change here is always `critical`.
 */
const SECURITY_SENSITIVE_ENTITIES = new Set<string>([
  "integration_credentials",
  "tenant_encryption_keys",
  "roles",
  "tenant_user_memberships",
  "users",
  "tenants",
  "api_audit_logs",
  "signed_link_uses",
  "pii_access_log",
]);

/**
 * Tables that carry a governed state change (approvals, offers, settlements,
 * provisioning, agent auto-actions). Non-delete changes here are `warning`.
 */
const SENSITIVE_STATE_ENTITIES = new Set<string>([
  "approval_requests",
  "approval_decisions",
  "approval_chains",
  "approval_matrices",
  "offers",
  "final_settlements",
  "offboarding_cases",
  "offboarding_tasks",
  "it_provisioning_requests",
  "asset_returns",
  "asset_assignments",
  "agent_approval_requests",
  "agent_approval_rules",
  "agent_actions",
  "workday_sync_outbox",
  "requisition_state_transitions",
  "application_state_transitions",
]);

/**
 * Deterministically classify one audit row's severity from its `action` and
 * `entity_type`. Pure — identical on server and client.
 *
 *   critical → a delete of anything, or any change to a security-sensitive
 *              table (access/identity/secrets/audit).
 *   warning  → an update to anything, or any non-delete change to a governed-
 *              state table (approvals/offers/provisioning/agent actions).
 *   info     → everything else (routine inserts).
 */
export function auditEventSeverity(action: string, entityType: string): AuditSeverity {
  if (action === "delete" || SECURITY_SENSITIVE_ENTITIES.has(entityType)) return "critical";
  if (action === "update" || SENSITIVE_STATE_ENTITIES.has(entityType)) return "warning";
  return "info";
}

export const AUDIT_SEVERITY_META: Record<AuditSeverity, { label: string; description: string }> = {
  info: {
    label: "Info",
    description: "Routine record creation. No governed-state or security implication.",
  },
  warning: {
    label: "Warning",
    description: "An update, or a change to a governed-state record (approvals, offers, agents).",
  },
  critical: {
    label: "Critical",
    description: "A deletion, or a change to access / identity / secrets / the audit ledger.",
  },
};

// ─────────────────────── audit CSV export (AD10) ───────────────────────

/**
 * The audit-export query. Mirrors the server-side filter fields of
 * `listAuditEvents` (minus the keyset cursor) so the CSV is generated from
 * the SAME predicate the operator is looking at. Capped at a hard ceiling so
 * a stray export can't scan the whole partitioned log.
 */
export const exportAuditEventsInputSchema = z.object({
  entityTypes: z.array(z.string().min(1).max(63)).max(20).optional(),
  action: z.enum(["insert", "update", "delete"]).optional(),
  entityId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().positive().max(5000).default(5000),
});
export type ExportAuditEventsInput = z.infer<typeof exportAuditEventsInputSchema>;

export const exportAuditEventsOutputSchema = z.object({
  items: z.array(auditEventRowSchema),
  /** True when the cap clipped the result — the CSV footer says so. */
  truncated: z.boolean(),
  generatedAt: z.string(),
});
export type ExportAuditEventsOutput = z.infer<typeof exportAuditEventsOutputSchema>;

// ───────────────────── email messaging log (AD12) ─────────────────────

/** notification_outbox.status lifecycle (read-only lens). */
export const NOTIFICATION_STATUSES = [
  "pending",
  "processing",
  "sent",
  "failed",
  "cancelled",
] as const;
export const notificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

export const NOTIFICATION_STATUS_META: Record<
  NotificationStatus,
  { label: string; tone: "info" | "success" | "error" | "warning" | "neutral" }
> = {
  pending: { label: "Pending", tone: "warning" },
  processing: { label: "Processing", tone: "info" },
  sent: { label: "Sent", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const notificationLogRowSchema = z.object({
  id: z.string().uuid(),
  recipient_email: z.string(),
  recipient_type: z.string(),
  template_key: z.string(),
  subject: z.string().nullable(),
  status: z.string(),
  priority: z.number().int(),
  attempt_count: z.number().int(),
  scheduled_for: z.string().nullable(),
  sent_at: z.string().nullable(),
  last_error: z.string().nullable(),
  provider_message_id: z.string().nullable(),
  created_at: z.string(),
});
export type NotificationLogRow = z.infer<typeof notificationLogRowSchema>;

export const listNotificationLogInputSchema = z.object({
  status: notificationStatusSchema.optional(),
  templateKey: z.string().min(1).max(120).optional(),
  limit: z.number().int().positive().max(200).default(100),
});
export type ListNotificationLogInput = z.infer<typeof listNotificationLogInputSchema>;

export const listNotificationLogOutputSchema = z.object({
  items: z.array(notificationLogRowSchema),
  /** Count per status across the whole tenant outbox (not just this page). */
  statusCounts: z.record(notificationStatusSchema, z.number().int()),
  /** Total outbox rows for the tenant. */
  total: z.number().int(),
});
export type ListNotificationLogOutput = z.infer<typeof listNotificationLogOutputSchema>;

/**
 * The REAL email templates — code-owned in `@hireops/email-templates`, keyed
 * by the `TemplateKey` union in `@hireops/notifications`. This registry is the
 * honest "template management" surface: these are the exact templates the
 * worker renders. It is descriptive metadata only (the copy lives in code and
 * is version-controlled, not editable from a settings screen).
 */
export interface EmailTemplateMeta {
  key: string;
  label: string;
  audience: "Candidate" | "Recruiter";
  description: string;
}

export const EMAIL_TEMPLATE_REGISTRY: EmailTemplateMeta[] = [
  {
    key: "candidate.application_received",
    label: "Application received",
    audience: "Candidate",
    description: "Confirms a candidate's application landed, with the position title.",
  },
  {
    key: "candidate.stage_advanced",
    label: "Application update",
    audience: "Candidate",
    description: "Notifies the candidate their application advanced a stage.",
  },
  {
    key: "candidate.interview_invitation",
    label: "Interview invitation",
    audience: "Candidate",
    description: "Invites the candidate to a round, with a real .ics when a time is set.",
  },
  {
    key: "candidate.interview_cancelled",
    label: "Interview cancelled",
    audience: "Candidate",
    description: "Tells the candidate a scheduled interview was cancelled.",
  },
  {
    key: "candidate.offer_extended",
    label: "Offer extended",
    audience: "Candidate",
    description: "Delivers the offer with a signed link to view and accept in-portal.",
  },
  {
    key: "candidate.account_activation",
    label: "Account activation",
    audience: "Candidate",
    description: "Sends the candidate their portal activation link.",
  },
  {
    key: "candidate.agent_message",
    label: "Agent follow-up",
    audience: "Candidate",
    description: "A human-approved agent follow-up (e.g. a missing-info chase).",
  },
  {
    key: "recruiter.sla_breach_imminent",
    label: "SLA breach imminent",
    audience: "Recruiter",
    description: "Warns the recruiter a stage is about to breach its SLA.",
  },
  {
    key: "recruiter.offer_accepted",
    label: "Offer accepted",
    audience: "Recruiter",
    description: "Tells the recruiter a candidate accepted their offer.",
  },
  {
    key: "recruiter.offer_declined",
    label: "Offer declined",
    audience: "Recruiter",
    description: "Tells the recruiter a candidate declined their offer.",
  },
];

// ─────────────────── system setup (AD14 / AD15) ───────────────────

/** Operational events an email alert can subscribe to. Honest set — each maps
 * to a real state the platform already tracks. */
export const SYSTEM_ALERT_TYPES = [
  "workflow_failure",
  "approval_pending",
  "sla_breach",
  "integration_error",
  "offer_expiring",
  "ai_budget",
] as const;
export const systemAlertTypeSchema = z.enum(SYSTEM_ALERT_TYPES);
export type SystemAlertType = z.infer<typeof systemAlertTypeSchema>;

export const SYSTEM_ALERT_TYPE_META: Record<
  SystemAlertType,
  { label: string; description: string }
> = {
  workflow_failure: {
    label: "Workflow failure",
    description: "An automation run failed or a job errored out.",
  },
  approval_pending: {
    label: "Approval pending",
    description: "A requisition or offer approval is waiting on a decision.",
  },
  sla_breach: {
    label: "SLA breach",
    description: "A stage crossed its service-level threshold.",
  },
  integration_error: {
    label: "Integration error",
    description: "A connector (e.g. the Workday seam) reported an error.",
  },
  offer_expiring: {
    label: "Offer expiring",
    description: "An extended offer is approaching its response deadline.",
  },
  ai_budget: {
    label: "AI budget",
    description: "Monthly AI spend crossed a configured budget threshold.",
  },
};

export const emailAlertsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Who receives operational alerts. Comma-separated in the UI, stored as a list. */
  recipients: z.array(z.string().email()).max(20).default([]),
  alertTypes: z.array(systemAlertTypeSchema).max(SYSTEM_ALERT_TYPES.length).default([]),
});
export type EmailAlertsConfig = z.infer<typeof emailAlertsConfigSchema>;

/** Simple, deterministic escalation: after N days, notify a recipient at a
 * chosen severity. Deliberately NOT the full tenant-configurable SLA table. */
export const ESCALATION_SEVERITIES = ["low", "medium", "high"] as const;
export const escalationSeveritySchema = z.enum(ESCALATION_SEVERITIES);
export type EscalationSeverity = z.infer<typeof escalationSeveritySchema>;

export const escalationRuleSchema = z.object({
  daysThreshold: z.number().int().min(1).max(90),
  recipient: z.string().email(),
  severity: escalationSeveritySchema.default("medium"),
});
export type EscalationRule = z.infer<typeof escalationRuleSchema>;

export const SYSTEM_SETUP_VERSION = 1 as const;

export const systemSetupSchema = z.object({
  version: z.literal(SYSTEM_SETUP_VERSION).default(SYSTEM_SETUP_VERSION),
  emailAlerts: emailAlertsConfigSchema.default(() => emailAlertsConfigSchema.parse({})),
  escalationRules: z.array(escalationRuleSchema).max(10).default([]),
});
export type SystemSetup = z.infer<typeof systemSetupSchema>;

export function defaultSystemSetup(): SystemSetup {
  return systemSetupSchema.parse({});
}

/**
 * Merge a raw stored `systemSetup` block (partial / unknown / absent) with
 * defaults, returning a complete validated config. Malformed / future blocks
 * fall back to defaults rather than throwing — same discipline as
 * `resolveBiasLexicon`.
 */
export function resolveSystemSetup(raw: unknown): SystemSetup {
  const parsed = systemSetupSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : defaultSystemSetup();
}

export const getSystemSetupInputSchema = z.object({});
export const getSystemSetupOutputSchema = systemSetupSchema;
export type GetSystemSetupOutput = z.infer<typeof getSystemSetupOutputSchema>;

export const updateSystemSetupInputSchema = systemSetupSchema;
export type UpdateSystemSetupInput = z.infer<typeof updateSystemSetupInputSchema>;
export const updateSystemSetupOutputSchema = z.object({
  ok: z.literal(true),
  systemSetup: systemSetupSchema,
});
export type UpdateSystemSetupOutput = z.infer<typeof updateSystemSetupOutputSchema>;

// ─────────────────── T2.3 / G08 — shortlist threshold + tier defaults ───────────────────
//
// Per-tenant defaults for the AI Shortlist surface, persisted to
// tenants.settings.shortlistDefaults (a SIBLING of systemSetup — no new table).
// The saved defaults DRIVE the shortlist computation: listShortlist reads the
// resolved threshold + tierCutoffs and uses them for the min-score filter and
// the match-tier bucketing. The code defaults (75 / 90 / 75 / 60) are
// byte-identical to the constants in apps/api/src/lib/recruiter-urgency.ts
// (MATCH_TIER_*_MIN) and the historic listShortlist `.default(75)` threshold, so
// an UNCONFIGURED tenant behaves exactly as before this ticket.

export const SHORTLIST_DEFAULTS_VERSION = 1 as const;

/** The three deterministic match-tier floors (inclusive min score per tier).
 * Cross-field sanity: partial ≤ good ≤ excellent. */
export const tierCutoffsSchema = z
  .object({
    excellent: z.number().int().min(0).max(100).default(90),
    good: z.number().int().min(0).max(100).default(75),
    partial: z.number().int().min(0).max(100).default(60),
  })
  .refine((c) => c.partial <= c.good && c.good <= c.excellent, {
    message: "Tier cutoffs must be ordered: partial ≤ good ≤ excellent.",
  });
export type TierCutoffs = z.infer<typeof tierCutoffsSchema>;

export const shortlistDefaultsSchema = z.object({
  version: z.literal(SHORTLIST_DEFAULTS_VERSION).default(SHORTLIST_DEFAULTS_VERSION),
  /** Default minimum real ai_score to include in the shortlist table (0–100). */
  threshold: z.number().min(0).max(100).default(75),
  tierCutoffs: tierCutoffsSchema.default(() => tierCutoffsSchema.parse({})),
});
export type ShortlistDefaults = z.infer<typeof shortlistDefaultsSchema>;

export function defaultShortlistDefaults(): ShortlistDefaults {
  return shortlistDefaultsSchema.parse({});
}

/**
 * Merge a raw stored `shortlistDefaults` block (partial / unknown / absent) with
 * defaults, returning a complete validated config. Malformed / future /
 * cross-field-invalid blocks fall back to defaults rather than throwing — same
 * discipline as `resolveSystemSetup`.
 */
export function resolveShortlistDefaults(raw: unknown): ShortlistDefaults {
  const parsed = shortlistDefaultsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : defaultShortlistDefaults();
}

export const getShortlistDefaultsInputSchema = z.object({});
export const getShortlistDefaultsOutputSchema = shortlistDefaultsSchema;
export type GetShortlistDefaultsOutput = z.infer<typeof getShortlistDefaultsOutputSchema>;

export const updateShortlistDefaultsInputSchema = shortlistDefaultsSchema;
export type UpdateShortlistDefaultsInput = z.infer<typeof updateShortlistDefaultsInputSchema>;
export const updateShortlistDefaultsOutputSchema = z.object({
  ok: z.literal(true),
  shortlistDefaults: shortlistDefaultsSchema,
});
export type UpdateShortlistDefaultsOutput = z.infer<typeof updateShortlistDefaultsOutputSchema>;

// ─────────────────── T5.1 / G24 — AI budget + spend alerts ───────────────────
//
// Per-tenant AI spend budget, persisted to tenants.settings.aiBudget (a SIBLING
// of systemSetup / shortlistDefaults — no new table, no migration). This block
// is GENUINELY consumed, not decorative:
//   (a) getAiBudgetStatus computes a real month-to-date spend + honest linear
//       month-end projection over the ai_usage_logs cost ledger and returns a
//       derived status band. Flipping `enabled` / `monthlyBudgetUsd` flips the
//       status — the honesty flip-test for the costs surface.
//   (b) the ai_budget_scan worker sums each tenant's month-to-date spend and,
//       when email alerts are enabled and the `ai_budget` alert type is on,
//       emails the configured recipients once per crossed threshold per month
//       (dedupKey `ai_budget:<tenantId>:<YYYY-MM>:<pct>`).
//
// SCOPE (T5.1 vs T5.1b): this ticket ships ALERTING only. A hard cap that BLOCKS
// AI calls at 100% budget is the destructive/irreversible automation (mid-month
// blocking of business-critical AI) and is DEFERRED as T5.1b — exactly like T4.3
// deferred the erasure automation. `enabled` here governs alerting, never a
// mid-run block; the worker never mutates spend or refuses a call.

export const USD_MICROS = 1_000_000 as const;

export const AI_BUDGET_VERSION = 1 as const;

export const aiBudgetSchema = z.object({
  version: z.literal(AI_BUDGET_VERSION).default(AI_BUDGET_VERSION),
  /** Master switch for AI-budget ALERTING (never enforcement — see T5.1b above). */
  enabled: z.boolean().default(false),
  /** Monthly AI spend budget in whole/fractional USD. 0 disables the status/alerts. */
  monthlyBudgetUsd: z.number().min(0).default(0),
  /** Percent-of-budget marks that trigger an alert (e.g. 80, 100). Max 5. */
  alertThresholdPercents: z.array(z.number().int().min(1).max(200)).max(5).default([80, 100]),
});
export type AiBudget = z.infer<typeof aiBudgetSchema>;

export function defaultAiBudget(): AiBudget {
  return aiBudgetSchema.parse({});
}

/**
 * Merge a raw stored `aiBudget` block (partial / unknown / absent) with defaults,
 * returning a complete validated config. Malformed / future blocks fall back to
 * defaults rather than throwing — same discipline as `resolveSystemSetup`. The
 * threshold list is deduped + sorted ascending so downstream crossing checks and
 * the UI render deterministically (nice-to-have, not load-bearing).
 */
export function resolveAiBudget(raw: unknown): AiBudget {
  const parsed = aiBudgetSchema.safeParse(raw ?? {});
  const cfg = parsed.success ? parsed.data : defaultAiBudget();
  const thresholds = Array.from(new Set(cfg.alertThresholdPercents)).sort((a, b) => a - b);
  return { ...cfg, alertThresholdPercents: thresholds };
}

/** Monthly budget expressed in USD micros (mirrors ai_usage_logs.cost_micros).
 * Rounded to whole micros — monthlyBudgetUsd may be fractional dollars. */
export function monthlyBudgetMicros(monthlyBudgetUsd: number): bigint {
  return BigInt(Math.max(0, Math.round(monthlyBudgetUsd * USD_MICROS)));
}

/**
 * Honest LINEAR month-end projection: assume spend continues at the current
 * month-to-date daily rate for the rest of the month.
 *
 *   projected = MTD ÷ daysElapsed × daysInMonth
 *
 * `daysElapsed` is the current UTC day-of-month, floored at 1 so an early-in-the-
 * month scan never divides by zero. This is a naive straight-line estimate, NOT a
 * seasonality- or trend-aware forecast — deliberately simple + explainable. All
 * bigint integer arithmetic; the ×daysInMonth before ÷daysElapsed keeps precision.
 */
export function projectMonthEndSpendMicros(mtdMicros: bigint, now: Date): bigint {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const daysElapsed = Math.max(1, now.getUTCDate());
  return (mtdMicros * BigInt(daysInMonth)) / BigInt(daysElapsed);
}

export const AI_BUDGET_STATUSES = ["off", "under", "on_track", "over_projected"] as const;
export const aiBudgetStatusSchema = z.enum(AI_BUDGET_STATUSES);
export type AiBudgetStatus = z.infer<typeof aiBudgetStatusSchema>;

/**
 * Deterministic status band from the projection vs the budget:
 *   off            → alerting disabled or no budget set (nothing to compare).
 *   over_projected → the linear projection exceeds the monthly budget.
 *   on_track       → projection within budget but ≥ 80% of it (heading toward the cap).
 *   under          → projection comfortably below 80% of budget.
 * Pure — the same input always yields the same band.
 */
export function deriveAiBudgetStatus(args: {
  enabled: boolean;
  monthlyBudgetUsd: number;
  projectedMicros: bigint;
}): AiBudgetStatus {
  if (!args.enabled || args.monthlyBudgetUsd <= 0) return "off";
  const budget = monthlyBudgetMicros(args.monthlyBudgetUsd);
  if (budget <= 0n) return "off";
  if (args.projectedMicros > budget) return "over_projected";
  // 80% band — a projection at/over four-fifths of budget reads as "on track to spend it".
  if (args.projectedMicros * 100n >= budget * 80n) return "on_track";
  return "under";
}

/**
 * Which configured alert-threshold percents the month-to-date spend has reached.
 * A percent P is "crossed" when MTD ≥ budget × P/100 (in micros). Returns the
 * crossed percents ascending-unique. Pure — the alert worker uses this to decide
 * which per-threshold notifications to enqueue. Integer bigint division truncates
 * the per-threshold micros DOWN, so a mark fires at or a hair before the exact
 * fraction — never late.
 */
export function crossedAiBudgetThresholds(
  mtdMicros: bigint,
  monthlyBudgetUsd: number,
  thresholdPercents: number[],
): number[] {
  if (monthlyBudgetUsd <= 0) return [];
  const budget = monthlyBudgetMicros(monthlyBudgetUsd);
  const crossed = thresholdPercents.filter((pct) => mtdMicros >= (budget * BigInt(pct)) / 100n);
  return Array.from(new Set(crossed)).sort((a, b) => a - b);
}

/** Dedup key for one budget-threshold alert: at most one per (tenant, month, percent).
 * `yearMonth` is YYYY-MM. Mirrors the sla-imminent scan's dedup-key discipline. */
export function aiBudgetAlertDedupKey(tenantId: string, yearMonth: string, pct: number): string {
  return `ai_budget:${tenantId}:${yearMonth}:${pct}`;
}

export const getAiBudgetInputSchema = z.object({});
export const getAiBudgetOutputSchema = aiBudgetSchema;
export type GetAiBudgetOutput = z.infer<typeof getAiBudgetOutputSchema>;

export const updateAiBudgetInputSchema = aiBudgetSchema;
export type UpdateAiBudgetInput = z.infer<typeof updateAiBudgetInputSchema>;
export const updateAiBudgetOutputSchema = z.object({
  ok: z.literal(true),
  aiBudget: aiBudgetSchema,
});
export type UpdateAiBudgetOutput = z.infer<typeof updateAiBudgetOutputSchema>;

export const getAiBudgetStatusInputSchema = z.object({});
export const getAiBudgetStatusOutputSchema = z.object({
  enabled: z.boolean(),
  monthlyBudgetUsd: z.number(),
  /** SUM(cost_micros) since date_trunc('month', now()). Decimal string (bigint on the wire). */
  monthToDateSpendMicros: z.string(),
  /** Linear projection of month-end spend (see projectMonthEndSpendMicros). */
  projectedMonthEndSpendMicros: z.string(),
  /** monthlyBudgetUsd expressed in micros; "0" when no budget is set. */
  budgetMicros: z.string(),
  /** MTD ÷ budget × 100, rounded to one decimal; 0 when budget is 0. */
  percentOfBudget: z.number(),
  status: aiBudgetStatusSchema,
});
export type GetAiBudgetStatusOutput = z.infer<typeof getAiBudgetStatusOutputSchema>;
