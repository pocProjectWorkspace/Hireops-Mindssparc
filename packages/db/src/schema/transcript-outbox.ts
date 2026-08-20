import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  smallint,
  timestamp,
  unique,
  index,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { interviewRecordings } from "./interview-recordings";

/**
 * Outbox for async transcript processing (notetaker phase, N1 / migration
 * 0116) — a direct clone of ai_score_outbox, on purpose.
 *
 * One row per recording that is ready to be transcribed and summarised. The
 * N3 drain worker will poll this table, claim a batch via
 * UPDATE ... WHERE id IN (... FOR UPDATE SKIP LOCKED), run the ASR +
 * summarisation chain, write interview_transcripts + interview_notes, and
 * mark the row 'completed'.
 *
 * status: 'pending' → 'processing' → 'completed' | 'failed'. Failed rows are
 * retried up to `attempt_cap`; past the cap they stay 'failed' for the ops
 * surface rather than looping forever. `claimed_at` / `claimed_by` are the
 * lease columns the orphan sweep uses to recover rows whose worker died
 * mid-flight.
 *
 * Compound unique (tenant_id, recording_id) — one processing job per
 * recording. Re-running a transcript is a deliberate act (reset the row),
 * not something a duplicate enqueue can cause by accident.
 *
 * SCOPE NOTE: the drain worker itself is N3. This table ships in 0116 so the
 * human applies ONE migration for the whole notetaker phase instead of two.
 * Until N3 lands, nothing writes here.
 *
 * RLS: tenant_isolation FOR ALL (the drain mutates status / attempt_count in
 * place, so SELECT+INSERT-only policies would break it). No audit trigger
 * attached — this IS the log of processing attempts, the same documented
 * exclusion as ai_score_outbox / notification_outbox / workday_sync_outbox /
 * ai_usage_logs / *_state_transitions.
 *
 * FK: compound (tenant_id, recording_id) → interview_recordings with
 * CASCADE, per HANDOVER §4.5/#13. recording_id is NOT NULL.
 */
export const transcriptOutbox = pgTable(
  "transcript_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: smallint("attempt_count").notNull().default(0),
    attemptCap: smallint("attempt_cap").notNull().default(5),
    lastError: text("last_error"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_transcript_outbox_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_transcript_outbox_per_recording").on(table.tenantId, table.recordingId),
    // Primary worker query — partial to skip terminal rows.
    index("idx_transcript_outbox_queue")
      .on(table.tenantId, table.status, table.createdAt)
      .where(sql`status IN ('pending', 'processing')`),
    // Orphan-recovery sweep — stuck-in-processing rows.
    index("idx_transcript_outbox_orphan_sweep")
      .on(table.claimedAt)
      .where(sql`status = 'processing'`),
    check(
      "transcript_outbox_status_check",
      sql`${table.status} IN ('pending', 'processing', 'completed', 'failed')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.recordingId],
      foreignColumns: [interviewRecordings.tenantId, interviewRecordings.id],
      name: "fk_transcript_outbox_recording",
    }).onDelete("cascade"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type TranscriptOutbox = typeof transcriptOutbox.$inferSelect;
export type NewTranscriptOutbox = typeof transcriptOutbox.$inferInsert;
