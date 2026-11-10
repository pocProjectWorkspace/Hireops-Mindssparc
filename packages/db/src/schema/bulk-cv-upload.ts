import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  unique,
  index,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { requisitions } from "./requisitions";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { candidates } from "./candidates";
import { applications } from "./applications";

/**
 * PC-2 bulk CV upload (migration 0123). See the migration header for the
 * consent/basis reasoning and the item ladder.
 *
 * bulk_cv_batches — one per upload session: which requisition, who uploaded
 * (auth user + membership), and the processing basis they attested to. A
 * bulk-uploaded candidate has NOT consented to anything; the batch is the
 * record of why the platform holds their CV. Audited.
 */
export const bulkCvBatches = pgTable(
  "bulk_cv_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id").notNull(),
    uploadedByMembershipId: uuid("uploaded_by_membership_id"),
    /** 'recruiter_attested' — the only basis today (CHECK-pinned). */
    basis: text("basis").notNull().default("recruiter_attested"),
    attestationVersion: text("attestation_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_bulk_cv_batches_tenant_id_id").on(table.tenantId, table.id),
    index("idx_bulk_cv_batches_req").on(table.tenantId, table.requisitionId, table.createdAt),
    check("bulk_cv_batches_basis_check", sql`${table.basis} IN ('recruiter_attested')`),
    foreignKey({
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
      name: "fk_bulk_cv_batches_requisition",
    }).onDelete("cascade"),
    // SQL: ON DELETE SET NULL ("uploaded_by_membership_id") — column-targeted.
    foreignKey({
      columns: [table.tenantId, table.uploadedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_bulk_cv_batches_membership",
    }).onDelete("set null"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type BulkCvBatch = typeof bulkCvBatches.$inferSelect;
export type NewBulkCvBatch = typeof bulkCvBatches.$inferInsert;

/**
 * bulk_cv_items — one per uploaded file; the bulk-CV drain's work queue and
 * the drawer's per-file status.
 *
 *   queued → parsing → created | duplicate | failed;  skipped (at upload)
 *
 * text + CHECK, not pgEnum (HANDOVER reality #114). `leaseExpiresAt` bounds a
 * 'parsing' claim and doubles as a backing-off 'queued' row's not-before.
 * No audit trigger: a work queue (ai_score_outbox precedent).
 */
export const bulkCvItems = pgTable(
  "bulk_cv_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").notNull(),
    requisitionId: uuid("requisition_id").notNull(),
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key"),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    checksum: text("checksum"),
    status: text("status").notNull().default("queued"),
    outcomeDetail: text("outcome_detail"),
    failureReason: text("failure_reason"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    candidateId: uuid("candidate_id"),
    applicationId: uuid("application_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_bulk_cv_items_tenant_id_id").on(table.tenantId, table.id),
    index("idx_bulk_cv_items_batch").on(table.tenantId, table.batchId, table.createdAt),
    index("idx_bulk_cv_items_drain")
      .on(table.status, table.leaseExpiresAt, table.createdAt)
      .where(sql`status IN ('queued', 'parsing')`),
    check(
      "bulk_cv_items_status_check",
      sql`${table.status} IN ('queued', 'parsing', 'created', 'duplicate', 'failed', 'skipped')`,
    ),
    check("bulk_cv_items_attempt_count_check", sql`${table.attemptCount} >= 0`),
    foreignKey({
      columns: [table.tenantId, table.batchId],
      foreignColumns: [bulkCvBatches.tenantId, bulkCvBatches.id],
      name: "fk_bulk_cv_items_batch",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
      name: "fk_bulk_cv_items_requisition",
    }).onDelete("cascade"),
    // SQL: ON DELETE SET NULL ("candidate_id") / ("application_id").
    foreignKey({
      columns: [table.tenantId, table.candidateId],
      foreignColumns: [candidates.tenantId, candidates.id],
      name: "fk_bulk_cv_items_candidate",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_bulk_cv_items_application",
    }).onDelete("set null"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type BulkCvItem = typeof bulkCvItems.$inferSelect;
export type NewBulkCvItem = typeof bulkCvItems.$inferInsert;
