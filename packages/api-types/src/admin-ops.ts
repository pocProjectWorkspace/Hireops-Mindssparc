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

/** A4 — how far ahead of a stage's SLA threshold the imminent-breach scan
 * warns. Platform default 4 h (the pre-config constant that lived in
 * apps/workers/src/jobs/sla-imminent-scan.ts), tunable 1–48 h per tenant for
 * alert-fatigue reasons. It is a LEAD TIME, not a threshold: the thresholds
 * themselves stay in `tenants.settings.slaThresholds` (/admin/sla-thresholds).
 * The scan clamps the window to each stage's own threshold, so a window wider
 * than a stage's SLA makes that stage "imminent from entry" and never earlier.
 */
export const SLA_IMMINENT_WINDOW_HOURS_DEFAULT = 4 as const;
export const SLA_IMMINENT_WINDOW_HOURS_MIN = 1 as const;
export const SLA_IMMINENT_WINDOW_HOURS_MAX = 48 as const;

export const systemSetupSchema = z.object({
  version: z.literal(SYSTEM_SETUP_VERSION).default(SYSTEM_SETUP_VERSION),
  emailAlerts: emailAlertsConfigSchema.default(() => emailAlertsConfigSchema.parse({})),
  escalationRules: z.array(escalationRuleSchema).max(10).default([]),
  /** Hours before a stage's SLA threshold at which the scan starts alerting.
   * Defaulted, so blocks stored before A4 resolve to 4 without a version bump
   * (version bumps are reserved for BREAKING shape changes). */
  slaImminentWindowHours: z
    .number()
    .int()
    .min(SLA_IMMINENT_WINDOW_HOURS_MIN)
    .max(SLA_IMMINENT_WINDOW_HOURS_MAX)
    .default(SLA_IMMINENT_WINDOW_HOURS_DEFAULT),
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

/** Dedup key for one budget-threshold alert: at most one per (tenant, RECIPIENT,
 * month, percent). `yearMonth` is YYYY-MM. Mirrors the sla-imminent scan's
 * per-recipient dedup-key discipline (`sla_escalation:${rule.recipient}:…`).
 *
 * The `recipient` leg is load-bearing. `notification_outbox`'s dedup index is
 * UNIQUE (tenant_id, dedup_key), so the original recipient-less key let exactly
 * ONE row per (tenant, month, percent) reach the outbox: a tenant with three
 * alert recipients had two of them silently absorbed as an expected 23505, and
 * only the alphabetically-first address was ever alerted. Adding the recipient
 * is what makes the configured list mean what the admin UI says it means. */
export function aiBudgetAlertDedupKey(
  tenantId: string,
  recipient: string,
  yearMonth: string,
  pct: number,
): string {
  return `ai_budget:${tenantId}:${recipient}:${yearMonth}:${pct}`;
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

// ─────────────────── R1.5a — scheduled report digests ───────────────────
//
// Per-tenant opt-in for a periodic emailed digest carrying the executive
// board-pack headline numbers, persisted to tenants.settings.reportDigests (a
// SIBLING of systemSetup / shortlistDefaults / aiBudget — no new table, no
// migration).
//
// WHY THERE IS NO TABLE. The obvious shape for "email this tenant once per
// period" is a send-log keyed (tenant, period) so a second attempt can be
// refused. We already own exactly that guarantee: notification_outbox carries a
// partial UNIQUE on (tenant_id, dedup_key), so the second insert of
// `report_digest:<tenantId>:<cadence>:<periodKey>` is rejected with a 23505.
// THE DEDUP KEY IS THE IDEMPOTENCY MECHANISM. A digest table would only restate
// it, and would immediately become a second thing that has to agree with the
// outbox about what was sent.
//
// The consequence worth stating out loud: the key names the CLOSED PERIOD, not
// the tick that noticed it, so a missed tick self-heals. The scan ticks every 30
// minutes; if the worker is down for the whole first day of a new period, the
// next tick that comes up computes the same period, builds the same key, and
// sends — late, exactly once, and correct. Nothing has to remember that a send
// was owed, and nothing has to be reconciled afterwards.
//
// Recipients are plain mailboxes rather than memberships: a digest goes wherever
// the admin nominates (a sponsor, a distribution list), and those addresses need
// not be HireOps users at all. That is precisely why the worker runs the report
// with `isAdmin: false` — see report-digest-scan.ts.

export const REPORT_DIGESTS_VERSION = 1 as const;

export const REPORT_DIGEST_CADENCES = ["weekly", "monthly"] as const;
export const reportDigestCadenceSchema = z.enum(REPORT_DIGEST_CADENCES);
export type ReportDigestCadence = z.infer<typeof reportDigestCadenceSchema>;

export const reportDigestsSchema = z.object({
  version: z.literal(REPORT_DIGESTS_VERSION).default(REPORT_DIGESTS_VERSION),
  /** Master switch. Off until an admin turns it on — an unconfigured tenant
   * sends nothing, which is the pre-config behaviour. */
  enabled: z.boolean().default(false),
  cadence: reportDigestCadenceSchema.default("weekly"),
  /** Plain mailboxes (a sponsor, an ops list) — NOT memberships. Max 10. */
  recipients: z.array(z.string().email()).max(10).default([]),
  /** UTC hour, on/after the first day of the new period, from which the digest
   * for the just-closed period may send. Default 07:00Z ≈ 12:30 IST. */
  sendHourUtc: z.number().int().min(0).max(23).default(7),
});
export type ReportDigests = z.infer<typeof reportDigestsSchema>;

export function defaultReportDigests(): ReportDigests {
  return reportDigestsSchema.parse({});
}

/**
 * Merge a raw stored `reportDigests` block (partial / unknown / absent) with
 * defaults, returning a complete validated config. Malformed / future blocks
 * fall back to defaults rather than throwing — same discipline as
 * `resolveAiBudget`, and it matters more here: this is read by a cross-tenant
 * worker loop, where one tenant's bad JSON must not stop the scan.
 *
 * Recipients are lower-cased, deduped and sorted so the list renders
 * deterministically in the admin UI and the worker enqueues in a stable order
 * (nice-to-have, not load-bearing — the dedup key is per (tenant, period), so
 * ordering cannot affect what is sent).
 */
export function resolveReportDigests(raw: unknown): ReportDigests {
  const parsed = reportDigestsSchema.safeParse(raw ?? {});
  const cfg = parsed.success ? parsed.data : defaultReportDigests();
  const recipients = Array.from(new Set(cfg.recipients.map((r) => r.trim().toLowerCase()))).sort();
  return { ...cfg, recipients };
}

/** Dedup key for one digest: at most one per (tenant, RECIPIENT, cadence, closed
 * period). `periodKey` is `digestPeriod().periodKey` — `2026-W33` or `2026-07`.
 * See the block header for why this key IS the idempotency mechanism. Cadence is
 * in the key so flipping weekly→monthly mid-period cannot collide with a digest
 * already sent under the old cadence.
 *
 * The `recipient` leg is LOAD-BEARING, not decoration. `notification_outbox`'s
 * dedup index is UNIQUE (tenant_id, dedup_key) — so a key that omits the
 * recipient lets exactly ONE row per tenant per period reach the outbox and the
 * other N−1 recipients come back 23505, which the scan absorbs as an expected
 * "already sent". A tenant configuring three recipients would silently get one
 * email. This mirrors `sla-imminent-scan`'s per-recipient keys
 * (`sla_imminent_cfg:${recipient}:…`, `sla_escalation:${rule.recipient}:…`),
 * which is the correct precedent for a fan-out. `aiBudgetAlertDedupKey` gets
 * this wrong and is fixed alongside this. */
export function reportDigestDedupKey(
  tenantId: string,
  recipient: string,
  cadence: ReportDigestCadence,
  periodKey: string,
): string {
  return `report_digest:${tenantId}:${recipient}:${cadence}:${periodKey}`;
}

/** The closed reporting period a digest covers. `from`/`to` are the inclusive
 * first and LAST instants (…T23:59:59.999Z), not a half-open range — they are
 * handed straight to `reportFiltersSchema`, whose bounds are inclusive. */
export interface DigestPeriod {
  /** Stable human-readable key: `2026-W33` (ISO week) or `2026-07` (month). */
  periodKey: string;
  from: Date;
  to: Date;
}

const DAY_MS = 86_400_000;

/**
 * ISO-8601 week-numbering year + week for a UTC instant.
 *
 * The rule that makes this non-obvious: a week belongs to the year that owns its
 * THURSDAY, so the last days of December can sit in week 1 of the next year and
 * the first days of January in week 52/53 of the previous one. We therefore
 * shift to the week's Thursday first and take the year from there, then count
 * whole weeks from the Thursday of that year's week 1 (the week containing 4
 * January, by the same rule).
 */
function isoWeekParts(d: Date): { isoYear: number; week: number } {
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay() is Sun=0; re-base to Mon=0 so the arithmetic reads ISO-wise.
  const dayIndex = (thursday.getUTCDay() + 6) % 7;
  thursday.setUTCDate(thursday.getUTCDate() - dayIndex + 3);
  const isoYear = thursday.getUTCFullYear();
  const week1Thursday = new Date(Date.UTC(isoYear, 0, 4));
  const week1Index = (week1Thursday.getUTCDay() + 6) % 7;
  week1Thursday.setUTCDate(week1Thursday.getUTCDate() - week1Index + 3);
  const week = 1 + Math.round((thursday.getTime() - week1Thursday.getTime()) / (7 * DAY_MS));
  return { isoYear, week };
}

/**
 * The PREVIOUS COMPLETE period for a cadence, entirely in UTC. Pure — the same
 * `now` always yields the same window, which is what lets the dedup key be
 * derived rather than recorded.
 *
 *   weekly  → the ISO week that just ended: Monday 00:00:00.000Z through the
 *             following Sunday 23:59:59.999Z. Key `2026-W33`.
 *   monthly → the previous calendar month, first through last instant. Key
 *             `2026-07`.
 *
 * Never the period `now` is IN: a digest that reported a half-finished week
 * would be wrong on arrival and would then disagree with the same numbers read
 * off /reports an hour later.
 *
 * UTC throughout, deliberately. The tenant's people read this in IST (or CET, in
 * the France/Germany GCC targets); picking one of those as the boundary would
 * make the window silently different per tenant while the report SQL still cut
 * on UTC timestamps. One clock, stated, is more honest than a friendlier clock
 * that disagrees with the page.
 */
export function digestPeriod(cadence: ReportDigestCadence, now: Date): DigestPeriod {
  if (cadence === "monthly") {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    // First instant of the CURRENT month, minus a millisecond.
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1);
    const periodKey = `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, "0")}`;
    return { periodKey, from, to };
  }

  // Monday 00:00Z of the week `now` is in, then step back one week.
  const mondayThisWeek = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayIndex = (now.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const from = new Date(mondayThisWeek - (dayIndex + 7) * DAY_MS);
  const to = new Date(from.getTime() + 7 * DAY_MS - 1);
  const { isoYear, week } = isoWeekParts(from);
  return { periodKey: `${isoYear}-W${String(week).padStart(2, "0")}`, from, to };
}

/**
 * May the digest for the just-closed period be sent yet?
 *
 * True once `now` is at or past `sendHourUtc` o'clock on the first day of the
 * CURRENT period (i.e. the instant after the reported period closed, plus the
 * configured hour) — and it STAYS true for the rest of that period rather than
 * only during the send hour. That monotone shape is what makes the missed-tick
 * self-heal in the block header real: a worker that is down all of Monday still
 * sends Monday's digest on Tuesday, once, because the dedup key is what stops a
 * second send, not this gate.
 *
 * Total by construction: `sendHourUtc` is clamped to 0–23 so a caller that
 * bypassed the schema still gets a boolean rather than a nonsense instant.
 */
export function shouldSendDigest(
  cadence: ReportDigestCadence,
  now: Date,
  sendHourUtc: number,
): boolean {
  // digestPeriod always returns the period BEFORE the one `now` sits in, so the
  // instant after its last one is the current period's first.
  const currentPeriodStart = digestPeriod(cadence, now).to.getTime() + 1;
  const hour = Math.min(23, Math.max(0, Math.trunc(sendHourUtc || 0)));
  return now.getTime() >= currentPeriodStart + hour * 3_600_000;
}

// ────────── R1.5b — wire contract for the report-digest admin surface ──────────
//
// R1.5a deliberately shipped no procedure schemas ("an unused pair of schemas
// shipped a ticket early is a pair nobody has validated against a real form").
// This is that form's contract, mirroring the getAiBudget / updateAiBudget pair
// above field-for-field: an empty-input read that returns the RESOLVED block, and
// a write that echoes what was persisted.

export const getReportDigestsInputSchema = z.object({});
export const getReportDigestsOutputSchema = reportDigestsSchema;
export type GetReportDigestsOutput = z.infer<typeof getReportDigestsOutputSchema>;

export const updateReportDigestsInputSchema = reportDigestsSchema;
export type UpdateReportDigestsInput = z.infer<typeof updateReportDigestsInputSchema>;
export const updateReportDigestsOutputSchema = z.object({
  ok: z.literal(true),
  reportDigests: reportDigestsSchema,
});
export type UpdateReportDigestsOutput = z.infer<typeof updateReportDigestsOutputSchema>;

/**
 * The "next digest" preview the admin surface renders — the closed period the
 * next digest will report on, and the instant it may go.
 *
 * DERIVED, NEVER STORED. There is no `nextDigestAt` column and there must not be
 * one: the send instant is a pure function of (cadence, sendHourUtc, now), and
 * the moment it is also written down it becomes a second thing that has to agree
 * with `digestPeriod`. Same argument as the block header's "the dedup key IS the
 * idempotency mechanism".
 *
 * It is deliberately NOT a procedure output either, despite being shaped like
 * one. The preview has to react to the form's UNSAVED state — flipping the
 * cadence dropdown must visibly flip the previewed period, which is the honesty
 * check this page exists for — and a server round-trip would either lag that or
 * force a save first. The schema lives here so the shape is pinned in the shared
 * package (and could be served by a procedure later without changing a caller),
 * while `nextDigestPreview` is the one implementation both sides would use.
 *
 * Dates cross as ISO strings, matching every other wire shape in this file.
 */
export const reportDigestPreviewSchema = z.object({
  /** `2026-W33` / `2026-07` — the same key that goes in the dedup key. */
  periodKey: z.string(),
  /** Inclusive first / last instant of the covered period (ISO 8601, UTC). */
  from: z.string(),
  to: z.string(),
  /** Human label for the period, e.g. "10–16 August 2026" or "July 2026". */
  label: z.string(),
  /** ISO instant the send gate opens: period end + 1ms + `sendHourUtc` hours. */
  sendsAt: z.string(),
  /**
   * True when the previewed period has already CLOSED — its numbers are final
   * and only the send hour is outstanding. False when the period is still
   * accumulating, i.e. the previous period's digest is already due or sent and
   * the next one cannot be computed until this window ends.
   */
  periodClosed: z.boolean(),
});
export type ReportDigestPreview = z.infer<typeof reportDigestPreviewSchema>;

/**
 * Human period label. Weekly reads as a date range because "week 33" means
 * nothing to a sponsor; monthly reads as the month name. UTC throughout, matching
 * the window the numbers are computed over — a label on a different clock from
 * its own figures is how a digest starts arguing with itself.
 *
 * NOTE: `report-digest-scan.ts` (R1.5a) carries a private `formatPeriodLabel`
 * with exactly this rule, written before this shared one existed. They must stay
 * identical or the previewed label and the emailed label diverge; collapsing the
 * worker onto this function is a one-line follow-up left out of R1.5b's fence.
 */
export function formatDigestPeriodLabel(
  cadence: ReportDigestCadence,
  period: DigestPeriod,
): string {
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(d);
  if (cadence === "monthly") {
    return fmt(period.from, { month: "long", year: "numeric" });
  }
  const sameMonth = period.from.getUTCMonth() === period.to.getUTCMonth();
  const fromPart = sameMonth
    ? fmt(period.from, { day: "numeric" })
    : fmt(period.from, { day: "numeric", month: "long" });
  return `${fromPart}–${fmt(period.to, { day: "numeric", month: "long", year: "numeric" })}`;
}

/**
 * The period `now` sits IN (still accumulating), expressed via `digestPeriod`
 * rather than a second piece of calendar arithmetic: `digestPeriod` returns the
 * period BEFORE the one containing its argument, so asking it about an instant
 * inside the NEXT period yields the current one. One implementation of "what is
 * a week/month" keeps the preview and the worker on the same boundaries.
 */
function currentDigestPeriod(cadence: ReportDigestCadence, now: Date): DigestPeriod {
  const start = new Date(digestPeriod(cadence, now).to.getTime() + 1);
  const probe =
    cadence === "monthly"
      ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
      : new Date(start.getTime() + 7 * DAY_MS);
  return digestPeriod(cadence, probe);
}

/**
 * Which digest goes next, and when — pure, and computed from the same two
 * functions the worker gates on.
 *
 *   send gate NOT yet open → the just-closed period, going at the gate instant
 *                            (soon; `periodClosed: true` — numbers are final).
 *   send gate ALREADY open → the just-closed period's digest is due or already
 *                            enqueued, so the next one covers the period `now`
 *                            is in, going after it closes (`periodClosed: false`).
 *
 * The honest limit, stated because the UI must not overclaim: nothing here reads
 * `notification_outbox`, so once the gate is open this cannot distinguish "sent
 * an hour ago" from "the scan tick that sends it hasn't run yet". It shows the
 * period that is definitely still to come rather than asserting a send already
 * happened. The scan ticks every 30 minutes, so the ambiguous window is small,
 * and the dedup key — not this function — is what guarantees exactly-once.
 */
export function nextDigestPreview(
  cadence: ReportDigestCadence,
  sendHourUtc: number,
  now: Date,
): ReportDigestPreview {
  const gateOpen = shouldSendDigest(cadence, now, sendHourUtc);
  const period = gateOpen ? currentDigestPeriod(cadence, now) : digestPeriod(cadence, now);
  const hour = Math.min(23, Math.max(0, Math.trunc(sendHourUtc || 0)));
  // period end + 1ms is the first instant of the period AFTER the one reported
  // on; the send hour is measured from there, exactly as shouldSendDigest does.
  const sendsAt = new Date(period.to.getTime() + 1 + hour * 3_600_000);
  return {
    periodKey: period.periodKey,
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    label: formatDigestPeriodLabel(cadence, period),
    sendsAt: sendsAt.toISOString(),
    periodClosed: !gateOpen,
  };
}
