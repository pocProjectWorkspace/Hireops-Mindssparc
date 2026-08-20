/**
 * N1 — DB-level constraint tests for the interview-notetaker chain
 * (migration 0116: interview_recording_consents, interview_recordings,
 * interview_transcripts, interview_notes, transcript_outbox, plus
 * interviews.recording_requested).
 *
 * Schema-only phase: there are no procedures, no UI and no worker yet
 * (N2–N5), so this suite is deliberately raw SQL against the tables — the
 * same shape as db-partner-a / db-approval. What it protects is the set of
 * decisions that are easy to undo by accident later:
 *
 *   1. interview_recording_consents accepts MULTIPLE rows per interview and
 *      the latest row by created_at is the effective state — granted →
 *      withdrawn → granted again. This is THE regression guard for
 *      withdrawability: the day someone "tidies up" by adding a unique on
 *      (tenant_id, interview_id), consent silently becomes terminal.
 *   2. interview_recordings / interview_transcripts / interview_notes each
 *      reject a SECOND row for the same interview (23505) — one artefact per
 *      round, so nothing downstream ever has to pick which one is "the" one.
 *   3. Deleting an interview CASCADEs the whole derived chain: recording →
 *      transcript → notes, plus the outbox row and the consent log. Derived
 *      data must not outlive the interview it describes.
 *   4. interview_notes upsert (ON CONFLICT) REPLACES rather than appends —
 *      it is a derived cache (interview_prep's rationale), not a log.
 *   5. interview_notes carries NO score / rating / recommendation column.
 *      That omission is a product stance ("notes assist the panellist, never
 *      auto-fill a recommendation"), so it is asserted rather than assumed.
 *
 * Runs entirely inside its own synthetic tenant (n116 namespace, RUN-suffixed
 * slugs/emails) via poolSql, so it touches no demo data and needs no JWT.
 * REQUIRES migration 0116 to have been applied.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { sql as poolSql } from "@hireops/db";

// Fixed synthetic ids (116 namespace — hex only; raw SQL, no Zod in the way).
const N_TENANT = "00000000-0000-4000-8000-000000116001";
const N_BU = "00000000-0000-4000-8000-000000116002";
const N_POSITION = "00000000-0000-4000-8000-000000116003";
const N_JD = "00000000-0000-4000-8000-000000116004";
const N_REQ = "00000000-0000-4000-8000-000000116005";
const N_PERSON = "00000000-0000-4000-8000-000000116006";
const N_CANDIDATE = "00000000-0000-4000-8000-000000116007";
const N_APP = "00000000-0000-4000-8000-000000116008";
const N_MEMBERSHIP = "00000000-0000-4000-8000-000000116009";
// IV1 carries the long-lived fixtures (tests 1, 2, 4, 5).
const N_IV1 = "00000000-0000-4000-8000-00000011600a";
// IV2 exists purely to be destroyed by the cascade test (test 3).
const N_IV2 = "00000000-0000-4000-8000-00000011600b";

const RUN = Date.now().toString(36);

/** A real auth.users id — tenant_user_memberships.user_id FKs to it at the
 * SQL level (drizzle can't model the cross-schema FK). Borrowing an existing
 * membership's user_id is the cheapest valid value and needs no sign-in. */
let userId: string;

/** postgres.js surfaces the SQLSTATE on `.code`; 23505 = unique_violation. */
function pgCode(err: unknown): string {
  return (err as { code?: string }).code ?? "";
}

async function expectPgError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return pgCode(err);
  }
  assert.fail("expected the insert to be rejected, but it succeeded");
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    // Audit rows first — the triggers on interview_recordings / interview_notes
    // write into the partitioned audit_logs and would otherwise be left behind.
    () =>
      poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${N_TENANT} AND entity_type IN ('interview_recordings','interview_notes','interviews','applications','requisitions')`,
    () => poolSql`DELETE FROM public.transcript_outbox WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.interview_notes WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.interview_transcripts WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.interview_recordings WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.interview_recording_consents WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.interviews WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.applications WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.candidates WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.persons WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.positions WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.business_units WHERE tenant_id = ${N_TENANT}`,
    () => poolSql`DELETE FROM public.tenants WHERE id = ${N_TENANT}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("N1 cleanup step failed (continuing):", err);
    }
  }
}

/** Seed one recording → transcript → notes → outbox chain for an interview. */
async function seedChain(interviewId: string): Promise<{
  recordingId: string;
  transcriptId: string;
}> {
  const [recording] = await poolSql<{ id: string }[]>`
    INSERT INTO public.interview_recordings
      (tenant_id, interview_id, source, status, storage_key, media_type,
       duration_seconds, size_bytes, requested_by_membership_id, uploaded_at)
    VALUES (${N_TENANT}, ${interviewId}, 'manual_upload', 'uploaded',
            ${`n116/${interviewId}/audio.m4a`}, 'audio/mp4', 1800, 4194304,
            ${N_MEMBERSHIP}, now())
    RETURNING id
  `;
  const recordingId = recording!.id;

  const [transcript] = await poolSql<{ id: string }[]>`
    INSERT INTO public.interview_transcripts
      (tenant_id, interview_id, recording_id, segments, full_text, language,
       provider, provider_model, word_count)
    VALUES (${N_TENANT}, ${interviewId}, ${recordingId},
            ${JSON.stringify([
              { speaker: "panellist", startMs: 0, endMs: 4000, text: "Tell me about Kafka." },
              {
                speaker: "candidate",
                startMs: 4000,
                endMs: 20000,
                text: "I ran a 12-broker cluster.",
              },
            ])}::jsonb,
            'Tell me about Kafka. I ran a 12-broker cluster.', 'en',
            'local-fixture', 'fixture-asr-1', 10)
    RETURNING id
  `;
  const transcriptId = transcript!.id;

  await poolSql`
    INSERT INTO public.interview_notes
      (tenant_id, interview_id, transcript_id, summary, key_points, model,
       prompt_version, generated_at)
    VALUES (${N_TENANT}, ${interviewId}, ${transcriptId}, 'First pass summary.',
            ${JSON.stringify(["Ran a 12-broker Kafka cluster"])}::jsonb,
            'claude-sonnet-4-6', 'v1', now())
  `;

  await poolSql`
    INSERT INTO public.transcript_outbox (tenant_id, recording_id, status)
    VALUES (${N_TENANT}, ${recordingId}, 'pending')
  `;

  return { recordingId, transcriptId };
}

describe("N1 — interview notetaker schema (migration 0116)", () => {
  beforeAll(async () => {
    const [existing] = await poolSql<{ user_id: string }[]>`
      SELECT user_id FROM public.tenant_user_memberships LIMIT 1
    `;
    assert.ok(existing, "no tenant_user_memberships row to borrow a user_id from");
    userId = existing.user_id;

    await cleanup();

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${N_TENANT}, ${`synth-n116-${RUN}`}, ${`Notetaker Synth ${RUN}`}, 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${N_BU}, ${N_TENANT}, ${`N1 BU ${RUN}`}, ${`n116-bu-${RUN}`})
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${N_MEMBERSHIP}, ${N_TENANT}, ${userId},
              ARRAY['recruiter']::tenant_role[], 'active', ${N_BU})
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${N_POSITION}, ${N_TENANT}, ${N_BU}, ${`N1 Backend Engineer ${RUN}`}, 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${N_JD}, ${N_TENANT}, ${N_POSITION}, 1, '# N1 JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${N_REQ}, ${N_TENANT}, ${N_POSITION}, ${N_JD}, ${N_MEMBERSHIP}, ${N_MEMBERSHIP}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${N_PERSON}, ${N_TENANT}, 'N1 Candidate', ${`n116-cand-${RUN}@example.test`}, ${`n116-cand-${RUN}@example.test`})
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${N_CANDIDATE}, ${N_TENANT}, ${N_PERSON}, 'career_site', 'v1')
    `;
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${N_APP}, ${N_TENANT}, ${N_CANDIDATE}, ${N_REQ}, 'career_site', 'tech_interview', now())
    `;
    for (const [id, round] of [
      [N_IV1, 1],
      [N_IV2, 2],
    ] as const) {
      await poolSql`
        INSERT INTO public.interviews
          (id, tenant_id, application_id, requisition_id, round_number, round_name,
           status, duration_minutes, mode, created_by_membership_id)
        VALUES (${id}, ${N_TENANT}, ${N_APP}, ${N_REQ}, ${round}, ${`N1 Round ${round}`},
                'scheduled', 60, 'video', ${N_MEMBERSHIP})
      `;
    }
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 0: interviews.recording_requested exists and defaults to false (opt-in)", async () => {
    const rows = await poolSql<{ recording_requested: boolean }[]>`
      SELECT recording_requested FROM public.interviews WHERE id = ${N_IV1}
    `;
    assert.equal(rows[0]?.recording_requested, false, "recruiter intent must default OFF");
  });

  it("Test 1: consent is append-only and WITHDRAWABLE — latest row by created_at wins", async () => {
    // Three events on ONE interview. No unique on (tenant_id, interview_id)
    // means all three coexist; that is the whole point of the table.
    await poolSql`
      INSERT INTO public.interview_recording_consents
        (tenant_id, interview_id, decision, consent_version, captured_via, captured_at, created_at)
      VALUES (${N_TENANT}, ${N_IV1}, 'granted', 'rec-consent-v1', 'candidate_confirm_link',
              now() - interval '2 hours', now() - interval '2 hours')
    `;
    await poolSql`
      INSERT INTO public.interview_recording_consents
        (tenant_id, interview_id, decision, consent_version, captured_via, captured_at, created_at,
         ip_address, user_agent)
      VALUES (${N_TENANT}, ${N_IV1}, 'withdrawn', 'rec-consent-v1', 'candidate_confirm_link',
              now() - interval '1 hour', now() - interval '1 hour',
              '203.0.113.7'::inet, 'Mozilla/5.0 (n116 test)')
    `;

    const afterWithdrawal = await poolSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM public.interview_recording_consents
      WHERE tenant_id = ${N_TENANT} AND interview_id = ${N_IV1}
    `;
    assert.equal(afterWithdrawal[0]?.n, 2, "both consent events must coexist");

    const current = await poolSql<{ decision: string }[]>`
      SELECT decision FROM public.interview_recording_consents
      WHERE tenant_id = ${N_TENANT} AND interview_id = ${N_IV1}
      ORDER BY created_at DESC LIMIT 1
    `;
    assert.equal(current[0]?.decision, "withdrawn", "effective consent must be the withdrawal");

    // A withdrawal is not terminal either — the candidate can grant again.
    await poolSql`
      INSERT INTO public.interview_recording_consents
        (tenant_id, interview_id, decision, consent_version, captured_via)
      VALUES (${N_TENANT}, ${N_IV1}, 'granted', 'rec-consent-v1', 'candidate_confirm_link')
    `;
    const regranted = await poolSql<{ decision: string; purpose: string }[]>`
      SELECT decision, purpose FROM public.interview_recording_consents
      WHERE tenant_id = ${N_TENANT} AND interview_id = ${N_IV1}
      ORDER BY created_at DESC LIMIT 1
    `;
    assert.equal(regranted[0]?.decision, "granted", "a re-grant must supersede the withdrawal");
    assert.equal(regranted[0]?.purpose, "interview_recording", "purpose defaults, scoped by CHECK");

    // Purpose is scoped by construction — nothing else may be authorised here.
    const badPurpose = await expectPgError(
      () => poolSql`
        INSERT INTO public.interview_recording_consents
          (tenant_id, interview_id, decision, purpose, consent_version, captured_via)
        VALUES (${N_TENANT}, ${N_IV1}, 'granted', 'marketing', 'rec-consent-v1', 'candidate_confirm_link')
      `,
    );
    assert.equal(badPurpose, "23514", "a non-recording purpose must fail the CHECK");
  });

  it("Test 2: one recording / transcript / notes row per interview (23505 on the second)", async () => {
    const { recordingId, transcriptId } = await seedChain(N_IV1);

    const dupRecording = await expectPgError(
      () => poolSql`
        INSERT INTO public.interview_recordings
          (tenant_id, interview_id, source, status, requested_by_membership_id)
        VALUES (${N_TENANT}, ${N_IV1}, 'vendor_bot', 'pending', ${N_MEMBERSHIP})
      `,
    );
    assert.equal(dupRecording, "23505", "second recording for the interview must be rejected");

    const dupTranscript = await expectPgError(
      () => poolSql`
        INSERT INTO public.interview_transcripts
          (tenant_id, interview_id, recording_id, segments, full_text)
        VALUES (${N_TENANT}, ${N_IV1}, ${recordingId}, '[]'::jsonb, 'second transcript')
      `,
    );
    assert.equal(dupTranscript, "23505", "second transcript for the interview must be rejected");

    const dupNotes = await expectPgError(
      () => poolSql`
        INSERT INTO public.interview_notes (tenant_id, interview_id, transcript_id, summary)
        VALUES (${N_TENANT}, ${N_IV1}, ${transcriptId}, 'second notes row')
      `,
    );
    assert.equal(dupNotes, "23505", "second notes row for the interview must be rejected");
  });

  it("Test 3: deleting an interview CASCADEs consent → recording → transcript → notes → outbox", async () => {
    await seedChain(N_IV2);
    await poolSql`
      INSERT INTO public.interview_recording_consents
        (tenant_id, interview_id, decision, consent_version, captured_via)
      VALUES (${N_TENANT}, ${N_IV2}, 'granted', 'rec-consent-v1', 'candidate_confirm_link')
    `;

    const before = await poolSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM public.interview_notes
      WHERE tenant_id = ${N_TENANT} AND interview_id = ${N_IV2}
    `;
    assert.equal(before[0]?.n, 1, "chain seeded");

    await poolSql`DELETE FROM public.interviews WHERE tenant_id = ${N_TENANT} AND id = ${N_IV2}`;

    const survivors = await poolSql<{ table_name: string; n: number }[]>`
      SELECT 'consents' AS table_name, COUNT(*)::int AS n
        FROM public.interview_recording_consents
       WHERE tenant_id = ${N_TENANT} AND interview_id = ${N_IV2}
      UNION ALL
      SELECT 'recordings', COUNT(*)::int
        FROM public.interview_recordings
       WHERE tenant_id = ${N_TENANT} AND interview_id = ${N_IV2}
      UNION ALL
      SELECT 'transcripts', COUNT(*)::int
        FROM public.interview_transcripts
       WHERE tenant_id = ${N_TENANT} AND interview_id = ${N_IV2}
      UNION ALL
      SELECT 'notes', COUNT(*)::int
        FROM public.interview_notes
       WHERE tenant_id = ${N_TENANT} AND interview_id = ${N_IV2}
      UNION ALL
      SELECT 'outbox', COUNT(*)::int
        FROM public.transcript_outbox o
       WHERE o.tenant_id = ${N_TENANT}
         AND NOT EXISTS (SELECT 1 FROM public.interview_recordings r
                          WHERE r.tenant_id = o.tenant_id AND r.id = o.recording_id)
    `;
    for (const row of survivors) {
      assert.equal(row.n, 0, `${row.table_name} must be cascaded away with the interview`);
    }

    // IV1's chain is untouched — the cascade is scoped to the deleted row.
    const iv1 = await poolSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM public.interview_notes
      WHERE tenant_id = ${N_TENANT} AND interview_id = ${N_IV1}
    `;
    assert.equal(iv1[0]?.n, 1, "the surviving interview keeps its notes");
  });

  it("Test 4: interview_notes upsert REPLACES (derived cache, not an append-only log)", async () => {
    const beforeRows = await poolSql<{ id: string; summary: string | null }[]>`
      SELECT id, summary FROM public.interview_notes
      WHERE tenant_id = ${N_TENANT} AND interview_id = ${N_IV1}
    `;
    assert.equal(beforeRows.length, 1, "one notes row before the regenerate");
    const originalId = beforeRows[0]!.id;
    assert.equal(beforeRows[0]!.summary, "First pass summary.");

    const [transcript] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.interview_transcripts
      WHERE tenant_id = ${N_TENANT} AND interview_id = ${N_IV1}
    `;

    // Exactly the shape the N3 regenerate path will use.
    await poolSql`
      INSERT INTO public.interview_notes
        (tenant_id, interview_id, transcript_id, summary, key_points, model, prompt_version, generated_at)
      VALUES (${N_TENANT}, ${N_IV1}, ${transcript!.id}, 'Regenerated summary.',
              ${JSON.stringify(["Regenerated point"])}::jsonb, 'claude-haiku-4-5', 'v2', now())
      ON CONFLICT (tenant_id, interview_id) DO UPDATE SET
        transcript_id = EXCLUDED.transcript_id,
        summary       = EXCLUDED.summary,
        key_points    = EXCLUDED.key_points,
        model         = EXCLUDED.model,
        prompt_version = EXCLUDED.prompt_version,
        generated_at  = EXCLUDED.generated_at,
        updated_at    = now()
    `;

    const afterRows = await poolSql<
      { id: string; summary: string | null; model: string | null; prompt_version: string | null }[]
    >`
      SELECT id, summary, model, prompt_version FROM public.interview_notes
      WHERE tenant_id = ${N_TENANT} AND interview_id = ${N_IV1}
    `;
    assert.equal(afterRows.length, 1, "regenerate must REPLACE, never append a second row");
    assert.equal(afterRows[0]!.id, originalId, "the same row is updated in place");
    assert.equal(afterRows[0]!.summary, "Regenerated summary.");
    assert.equal(afterRows[0]!.model, "claude-haiku-4-5", "provenance is re-stamped");
    assert.equal(afterRows[0]!.prompt_version, "v2");
  });

  it("Test 5: interview_notes carries NO score / rating / recommendation column", async () => {
    // The omission is a product stance ("notes assist the panellist, never
    // auto-fill a recommendation"), so it gets a guard rather than a comment.
    const cols = await poolSql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'interview_notes'
    `;
    const names = cols.map((c) => c.column_name);
    assert.ok(names.length > 0, "interview_notes must exist");
    for (const banned of ["score", "rating", "recommendation"]) {
      const offenders = names.filter((n) => n.includes(banned));
      assert.deepEqual(
        offenders,
        [],
        `interview_notes must not carry a '${banned}' column — see the schema header`,
      );
    }
  });
});
