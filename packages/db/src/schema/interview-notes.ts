import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  unique,
  index,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { interviewTranscripts } from "./interview-transcripts";

/**
 * interview_notes — the structured AI notes derived from one interview
 * transcript (notetaker phase, N1 / migration 0116).
 *
 * Same honest pattern as interview_prep / requisition_feasibility / comp
 * rationale: the N3 drain builds a structured prompt from the transcript,
 * asks the tenant's configured model through @hireops/ai-client's
 * completeStructured (cost-logged to ai_usage_logs under the
 * `interview_notes` AI feature key), and caches the structured result here.
 * `model` + `prompt_version` stamp provenance so a regenerated corpus stays
 * legible.
 *
 * WHAT THIS TABLE DELIBERATELY DOES NOT HAVE: a score. A rating. A
 * hire/no-hire recommendation. Any column of that kind. Notes ASSIST the
 * panellist — they summarise what was said, they never form or pre-fill a
 * verdict. That is the same stance SessionBoard.tsx takes ("not a
 * surveillance surface") and the same anti-anchoring convention that keeps
 * prior-round SCORES out of the interview-prep prompt. The omission is the
 * product decision, not an unfinished schema: a future ticket that wants to
 * add a recommendation column is changing the product, and should be made
 * to say so out loud.
 *
 * `summary` is prose; `key_points`, `topics_covered`, `questions_asked` and
 * `follow_ups` are jsonb arrays (validated by the api-types zod schema) so a
 * prompt-shape evolution doesn't need a migration — interview_prep's
 * rationale exactly. All are nullable: a row can exist in a partially
 * populated state, and a model that returns fewer sections must not fail an
 * INSERT.
 *
 * unique (tenant_id, interview_id): ONE notes row per interview.
 * Regenerating REPLACES the row via ON CONFLICT, never appends — this is a
 * derived cache, not an append-only log, so replacement is correct (and is
 * why the two genuinely append-only tables in 0116, the consent log and the
 * outbox, are shaped the other way round).
 *
 * FK: compound (tenant_id, transcript_id) → interview_transcripts with
 * CASCADE. Notes derived from a transcript must not outlive it; combined
 * with the recording → transcript and interview → recording legs, deleting
 * an interview unwinds the entire chain. `interview_id` is denormalised for
 * the read path, as on interview_transcripts.
 *
 * Tenant-scoped + FORCE RLS + audit trigger — regenerating a panellist's
 * notes changes what a hiring decision was informed by, so it is auditable.
 */
export const interviewNotes = pgTable(
  "interview_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Denormalised for the read path — see the header. */
    interviewId: uuid("interview_id").notNull(),
    transcriptId: uuid("transcript_id").notNull(),

    summary: text("summary"),
    /** jsonb arrays of strings — shape validated in api-types, not the DB. */
    keyPoints: jsonb("key_points"),
    topicsCovered: jsonb("topics_covered"),
    questionsAsked: jsonb("questions_asked"),
    followUps: jsonb("follow_ups"),

    // NOTE: no score / rating / recommendation column, deliberately.
    // See the header before adding one.

    /** LLM-side provenance, distinct from the transcript's ASR provenance. */
    model: text("model"),
    promptVersion: text("prompt_version"),

    generatedAt: timestamp("generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_interview_notes_tenant_id_id").on(table.tenantId, table.id),
    // ONE notes row per interview — the upsert (regenerate-replaces) target.
    unique("uniq_interview_notes_per_interview").on(table.tenantId, table.interviewId),

    index("idx_interview_notes_transcript").on(table.tenantId, table.transcriptId),

    foreignKey({
      columns: [table.tenantId, table.transcriptId],
      foreignColumns: [interviewTranscripts.tenantId, interviewTranscripts.id],
      name: "fk_interview_notes_transcript",
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

export type InterviewNote = typeof interviewNotes.$inferSelect;
export type NewInterviewNote = typeof interviewNotes.$inferInsert;
