import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  date,
  boolean,
  integer,
  smallint,
  timestamp,
  unique,
  index,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";
import { candidates } from "./candidates";
import { offers } from "./offers";
import { notificationOutbox } from "./notification-outbox";
import { candidateInboundMessages } from "./candidate-inbound-messages";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * PC-14..17 — pre-joining (notice-period) engagement (migration 0128).
 *
 * The SQL migration is the source of truth (hand-written, like every
 * migration since 0040); these definitions mirror it for typed reads. Most
 * engagement code uses raw postgres.js with explicit tenant_id, matching
 * offers.ts / onboarding-case.ts.
 *
 * FACTS, NOT SCORES: candidate_risk_signals holds a named signal from a fixed
 * platform list plus the candidate's own words. There is no flight-risk
 * score / probability / rating column, by design (CLAUDE.md product stances).
 */

const tenantIsolation = () =>
  pgPolicy("tenant_isolation", {
    as: "permissive",
    for: "all",
    to: ["authenticated"],
    using: sql`tenant_id = current_tenant_id()`,
    withCheck: sql`tenant_id = current_tenant_id()`,
  });

export const preJoiningJourneys = pgTable(
  "pre_joining_journeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    joiningDate: date("joining_date").notNull(),
    /** active | stopped | completed */
    status: text("status").notNull().default("active"),
    /** joined | reneged | withdrawn | offer_not_accepted | joining_date_passed */
    stopReason: text("stop_reason"),
    replyToken: text("reply_token").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uniq_pre_joining_journeys_tenant_id_id").on(t.tenantId, t.id),
    unique("uniq_pre_joining_journeys_application").on(t.tenantId, t.applicationId),
    unique("uniq_pre_joining_journeys_reply_token").on(t.replyToken),
    index("idx_pre_joining_journeys_status").on(t.tenantId, t.status),
    foreignKey({
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_pre_joining_journeys_application",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.candidateId],
      foreignColumns: [candidates.tenantId, candidates.id],
      name: "fk_pre_joining_journeys_candidate",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.offerId],
      foreignColumns: [offers.tenantId, offers.id],
      name: "fk_pre_joining_journeys_offer",
    }).onDelete("cascade"),
    check(
      "pre_joining_journeys_status_check",
      sql`${t.status} IN ('active', 'stopped', 'completed')`,
    ),
    tenantIsolation(),
  ],
).enableRLS();

export const preJoiningCompanyUpdates = pgTable(
  "pre_joining_company_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    linkUrl: text("link_url"),
    videoUrl: text("video_url"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(100),
    createdByMembershipId: uuid("created_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uniq_pre_joining_company_updates_tenant_id_id").on(t.tenantId, t.id),
    index("idx_pre_joining_company_updates_order").on(
      t.tenantId,
      t.isActive,
      t.sortOrder,
      t.createdAt,
    ),
    tenantIsolation(),
  ],
).enableRLS();

export const preJoiningTouchpoints = pgTable(
  "pre_joining_touchpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    journeyId: uuid("journey_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    stepKey: text("step_key").notNull(),
    sequence: integer("sequence").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    carriesPulse: boolean("carries_pulse").notNull().default(false),
    /** scheduled → processing → sent | skipped | failed; scheduled → cancelled */
    status: text("status").notNull().default("scheduled"),
    skipReason: text("skip_reason"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    notificationOutboxId: uuid("notification_outbox_id"),
    companyUpdateId: uuid("company_update_id"),
    pulseTokenHash: text("pulse_token_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uniq_pre_joining_touchpoints_tenant_id_id").on(t.tenantId, t.id),
    unique("uniq_pre_joining_touchpoints_step").on(t.tenantId, t.journeyId, t.stepKey, t.sequence),
    unique("uniq_pre_joining_touchpoints_pulse_token").on(t.pulseTokenHash),
    index("idx_pre_joining_touchpoints_drain").on(t.status, t.scheduledFor),
    index("idx_pre_joining_touchpoints_application").on(
      t.tenantId,
      t.applicationId,
      t.scheduledFor,
    ),
    foreignKey({
      columns: [t.tenantId, t.journeyId],
      foreignColumns: [preJoiningJourneys.tenantId, preJoiningJourneys.id],
      name: "fk_pre_joining_touchpoints_journey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_pre_joining_touchpoints_application",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.notificationOutboxId],
      foreignColumns: [notificationOutbox.id],
      name: "fk_pre_joining_touchpoints_outbox",
    }).onDelete("set null"),
    foreignKey({
      columns: [t.companyUpdateId],
      foreignColumns: [preJoiningCompanyUpdates.id],
      name: "fk_pre_joining_touchpoints_company_update",
    }).onDelete("set null"),
    tenantIsolation(),
  ],
).enableRLS();

export const preJoiningPulseResponses = pgTable(
  "pre_joining_pulse_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    touchpointId: uuid("touchpoint_id").notNull(),
    journeyId: uuid("journey_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    /** yes | unsure | no */
    onTrack: text("on_track").notNull(),
    feeling: smallint("feeling"),
    comment: text("comment"),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uniq_pre_joining_pulse_responses_tenant_id_id").on(t.tenantId, t.id),
    unique("uniq_pre_joining_pulse_responses_touchpoint").on(t.tenantId, t.touchpointId),
    index("idx_pre_joining_pulse_responses_application").on(
      t.tenantId,
      t.applicationId,
      t.respondedAt,
    ),
    foreignKey({
      columns: [t.tenantId, t.touchpointId],
      foreignColumns: [preJoiningTouchpoints.tenantId, preJoiningTouchpoints.id],
      name: "fk_pre_joining_pulse_responses_touchpoint",
    }).onDelete("cascade"),
    tenantIsolation(),
  ],
).enableRLS();

export const candidateRiskSignals = pgTable(
  "candidate_risk_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),
    journeyId: uuid("journey_id"),
    signalType: text("signal_type").notNull(),
    /** inbound_email | pulse_response */
    source: text("source").notNull(),
    /** Verbatim candidate words (verified) — never a paraphrase. */
    quote: text("quote"),
    inboundMessageId: uuid("inbound_message_id"),
    pulseResponseId: uuid("pulse_response_id"),
    /** open | acknowledged */
    status: text("status").notNull().default("open"),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    acknowledgedByMembershipId: uuid("acknowledged_by_membership_id"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uniq_candidate_risk_signals_tenant_id_id").on(t.tenantId, t.id),
    index("idx_candidate_risk_signals_application").on(
      t.tenantId,
      t.applicationId,
      t.status,
      t.createdAt,
    ),
    foreignKey({
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_candidate_risk_signals_application",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.inboundMessageId],
      foreignColumns: [candidateInboundMessages.id],
      name: "fk_candidate_risk_signals_inbound",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.pulseResponseId],
      foreignColumns: [preJoiningPulseResponses.id],
      name: "fk_candidate_risk_signals_pulse",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.acknowledgedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_candidate_risk_signals_ack_membership",
    }),
    tenantIsolation(),
  ],
).enableRLS();

export const offerReneges = pgTable(
  "offer_reneges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonLabel: text("reason_label").notNull(),
    notes: text("notes"),
    recordedByMembershipId: uuid("recorded_by_membership_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uniq_offer_reneges_tenant_id_id").on(t.tenantId, t.id),
    unique("uniq_offer_reneges_offer").on(t.tenantId, t.offerId),
    index("idx_offer_reneges_recorded").on(t.tenantId, t.recordedAt),
    foreignKey({
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_offer_reneges_application",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.offerId],
      foreignColumns: [offers.tenantId, offers.id],
      name: "fk_offer_reneges_offer",
    }).onDelete("cascade"),
    tenantIsolation(),
  ],
).enableRLS();
