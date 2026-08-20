import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  unique,
  index,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { interviewRecordings } from "./interview-recordings";

/**
 * interview_transcripts — the speech-to-text output for one recording
 * (notetaker phase, N1 / migration 0116).
 *
 * `segments` is a jsonb array of { speaker, startMs, endMs, text }. jsonb
 * rather than a child table because nothing ever queries INTO a segment:
 * the api reads a whole transcript or none of it, and ASR providers differ
 * in what they emit (diarisation labels, confidence, punctuation) — keeping
 * the payload as jsonb (validated by the api-types zod schema, as
 * interview_prep does) means a provider change needs no migration.
 * `full_text` is the flattened form the summariser prompt actually consumes,
 * stored rather than recomputed so the prompt is byte-stable across reruns.
 *
 * `provider` / `provider_model` / `language` / `word_count` are the ASR-side
 * provenance, deliberately separate from interview_notes' `model` /
 * `prompt_version` (the LLM-side provenance) — two different vendors can be
 * swapped independently and the audit story has to survive that.
 *
 * unique (tenant_id, interview_id): ONE transcript per interview. The
 * denormalised `interview_id` exists so the panel-side read path can find a
 * transcript without joining through interview_recordings on every request;
 * it is kept consistent by the writer and by the fact that a recording's
 * interview never changes.
 *
 * FK: compound (tenant_id, recording_id) → interview_recordings with
 * CASCADE. The transcript is derived data that must not outlive its source
 * media, and this leg is also how the whole chain unwinds — deleting an
 * interview cascades to the recording, which cascades to here, which
 * cascades to interview_notes.
 *
 * NO AUDIT TRIGGER, and unlike the other omissions in 0116 this one is a
 * SIZE decision rather than a category one. public.audit_record_change()
 * writes to_jsonb(OLD) AND to_jsonb(NEW) — the entire row, both sides —
 * into the monthly-partitioned audit_logs. A transcript's `full_text` plus
 * `segments` runs to tens of KB, so every write would copy the whole
 * transcript (twice, on UPDATE) into the audit partitions for no
 * investigative gain. The artefact it came from (interview_recordings) and
 * the artefact derived from it (interview_notes) are BOTH audited, so the
 * chain's provenance is intact without paying that cost here.
 *
 * Tenant-scoped + FORCE RLS.
 */
export const interviewTranscripts = pgTable(
  "interview_transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Denormalised for the panel-side read path — see the header. */
    interviewId: uuid("interview_id").notNull(),
    recordingId: uuid("recording_id").notNull(),

    /** Array of { speaker, startMs, endMs, text } — see the header. */
    segments: jsonb("segments").notNull(),
    /** Flattened transcript; what the summariser prompt consumes. */
    fullText: text("full_text").notNull(),

    language: text("language"),
    /** ASR-side provenance, distinct from interview_notes' LLM provenance. */
    provider: text("provider"),
    providerModel: text("provider_model"),
    wordCount: integer("word_count"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_interview_transcripts_tenant_id_id").on(table.tenantId, table.id),
    // ONE transcript per interview.
    unique("uniq_interview_transcripts_per_interview").on(table.tenantId, table.interviewId),

    index("idx_interview_transcripts_recording").on(table.tenantId, table.recordingId),

    foreignKey({
      columns: [table.tenantId, table.recordingId],
      foreignColumns: [interviewRecordings.tenantId, interviewRecordings.id],
      name: "fk_interview_transcripts_recording",
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

export type InterviewTranscript = typeof interviewTranscripts.$inferSelect;
export type NewInterviewTranscript = typeof interviewTranscripts.$inferInsert;
