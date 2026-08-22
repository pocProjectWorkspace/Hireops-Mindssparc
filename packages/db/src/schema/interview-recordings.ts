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
import { interviews } from "./interviews";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * interview_recordings — the media artefact for one interview round
 * (notetaker phase, N1 / migration 0116).
 *
 * VENDOR-AGNOSTIC BY DESIGN. `source` is the discriminator that keeps the
 * ingestion path open:
 *
 *   'manual_upload' — phase 1, and the only path N2 implements. A recruiter
 *   uploads the audio or VTT that Teams/Zoom/Meet already produced. No
 *   vendor account, no bot in the meeting, no per-minute COGS line.
 *
 *   'vendor_bot' — the later Recall.ai-style adapter, where a bot joins
 *   `interviews.meeting_url`. `vendor` + `vendor_ref` hold the provider name
 *   and its opaque bot/recording id, and are NULLABLE precisely because the
 *   manual path has neither. Shipping the discriminator now means adopting a
 *   vendor later is an adapter, not a migration.
 *
 * unique (tenant_id, interview_id): ONE recording per interview. A round
 * that needs re-recording replaces the artefact rather than accumulating
 * ambiguous siblings — nothing downstream should ever have to pick which
 * recording of a round is "the" one.
 *
 * `status` uses the text + CHECK convention (NOT pgEnum) — HANDOVER reality
 * #114. Ladder: pending (requested, nothing stored yet) → uploaded →
 * transcribing → transcribed, with `failed` terminal. `storage_key`,
 * `media_type`, `duration_seconds`, `size_bytes` and `uploaded_at` are
 * nullable because a 'pending' row legitimately predates the bytes.
 *
 * `requested_by_membership_id` is the provenance leg — WHO asked for this
 * round to be recorded — and is NOT NULL. Its compound FK uses RESTRICT:
 * compound FKs cannot SET NULL (the tenant_id leg is NOT NULL), so per
 * HANDOVER reality #63 we RESTRICT rather than orphan the requester, same
 * as interview_prep.generated_by and offers.drafted_by.
 *
 * Nothing in this table is permission to record. The capture path checks
 * `interviews.recording_requested` (the recruiter's intent) AND the latest
 * interview_recording_consents row for that interview (the candidate's,
 * which is withdrawable). Both, or no recording.
 *
 * `media_purged_at` (N3.RET / migration 0118) is the MEDIA LIFECYCLE axis,
 * deliberately kept separate from `status`. The ladder above tracks
 * PROCESSING and answers "was this transcribed?"; a 'purged' value on it
 * would overwrite that answer 30 days later for every recording old enough
 * to matter. The two compose instead: (transcribed, media_purged_at set) is
 * the healthy steady state of a month-old interview — transcript kept,
 * audio deleted on schedule. NULL means the bytes are still there.
 *
 * Tenant-scoped + FORCE RLS + audit trigger: a mutable status on a governed
 * artefact is exactly what the audit log exists for.
 */
export const interviewRecordings = pgTable(
  "interview_recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    interviewId: uuid("interview_id").notNull(),

    /** 'manual_upload' (phase 1) | 'vendor_bot' (later adapter). */
    source: text("source").notNull(),
    /** pending → uploaded → transcribing → transcribed; failed is terminal. */
    status: text("status").notNull().default("pending"),

    /** Object-storage key. Null until the bytes actually land. */
    storageKey: text("storage_key"),
    mediaType: text("media_type"),
    durationSeconds: integer("duration_seconds"),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }),

    /** Vendor legs — null on the manual-upload path. See the header. */
    vendor: text("vendor"),
    vendorRef: text("vendor_ref"),

    /** Provenance: who asked for this round to be recorded. */
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),

    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    /**
     * When the retention sweep deleted the stored object (N3.RET). NULL =
     * the media is still there. Set together with nulling storage_key, in
     * one UPDATE, so a row never claims to hold bytes it has purged.
     */
    mediaPurgedAt: timestamp("media_purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_interview_recordings_tenant_id_id").on(table.tenantId, table.id),
    // ONE recording per interview — see the header.
    unique("uniq_interview_recordings_per_interview").on(table.tenantId, table.interviewId),

    index("idx_interview_recordings_status").on(table.tenantId, table.status),

    // N3.RET retention sweep. Tenant-agnostic on purpose — the sweep is
    // cross-tenant and service-role, so the driving question is "which
    // recordings anywhere still hold purgeable bytes" (the
    // idx_transcript_outbox_orphan_sweep precedent). Both predicate legs are
    // IMMUTABLE, which is what makes the partial index legal; created_at
    // leads because it serves the hard-ceiling half of the sweep directly.
    index("idx_interview_recordings_media_purge_sweep")
      .on(table.createdAt)
      .where(sql`media_purged_at IS NULL AND storage_key IS NOT NULL`),

    // 0119 (N4.1) added 'ai_interview': media produced by the candidate's own
    // browser inside an 'ai_async' round. No vendor and no recruiter upload,
    // so `vendor` / `vendor_ref` stay NULL for the same reason they do on the
    // manual path. This is the third ingestion path the discriminator was
    // written to accept without a migration of the chain behind it.
    check(
      "interview_recordings_source_check",
      sql`${table.source} IN ('manual_upload', 'vendor_bot', 'ai_interview')`,
    ),
    check(
      "interview_recordings_status_check",
      sql`${table.status} IN ('pending', 'uploaded', 'transcribing', 'transcribed', 'failed')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.interviewId],
      foreignColumns: [interviews.tenantId, interviews.id],
      name: "fk_interview_recordings_interview",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.requestedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_interview_recordings_requested_by",
    }).onDelete("restrict"),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type InterviewRecording = typeof interviewRecordings.$inferSelect;
export type NewInterviewRecording = typeof interviewRecordings.$inferInsert;
