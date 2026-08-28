import { describe, expect, it } from "vitest";
import {
  INTERVIEW_AUDIO_HARD_CEILING_DAYS,
  INTERVIEW_AUDIO_RETENTION_DAYS_DEFAULT,
  defaultRetentionPolicy,
  effectiveRetentionYears,
  resolveRetentionPolicy,
  retentionPolicySchema,
  updateRetentionPolicyInputSchema,
  type RetentionPolicy,
} from "../src/retention-policy";

/**
 * T4.3 / A2 — the tenant retention policy block.
 *
 * There was no test file for this block until A2 added `interviewAudioDays` to
 * it, and A2 is exactly the change that made one necessary. The documents half
 * feeds a REGISTER: getting it wrong shows the wrong rows on a screen. The
 * audio half feeds the daily `interview_media_purge` worker sweep, which
 * DELETES BYTES. So the properties pinned here are the ones whose failure is
 * unrecoverable rather than merely wrong:
 *
 *   - A block stored BEFORE A2 (document fields only, which is every stored
 *     block in existence at the time of writing) must still parse, keep its
 *     document config, and default the audio window to 30 — the exact constant
 *     the worker hard-coded pre-A2. If this regressed, deploying A2 would
 *     change the retention of audio for every existing tenant with a policy.
 *   - The resolver's fallback is ALL-OR-NOTHING: one bad field discards the
 *     whole block, including a tenant's document overrides. That is a sharp
 *     edge, it is the safe direction, and it is worth asserting rather than
 *     assuming — so the malformed cases below check what really happens, not
 *     what would be nicer.
 *   - The ceiling is the platform's promise (sweep finding B9), so 90 must be
 *     accepted and 91 must be REJECTED on the write path, and 0 must be
 *     rejected too — a zero window would schedule every recording the sweep can
 *     see for deletion tonight.
 *   - `effectiveRetentionYears` must be untouched by any of it. The audio field
 *     is measured in days and has nothing to do with documents.
 *
 * Pure (no DB). The live round trip through updateRetentionPolicy/
 * getRetentionPolicy, the role gating and the overdue register are covered by
 * the api suite (apps/api/test/t43-retention-policy.test.ts); the purge sweep
 * itself by apps/api/test/notetaker-06-media-retention.test.ts.
 */

/** Byte-for-byte the shape the pre-A2 admin surface wrote. */
const PRE_A2_BLOCK = {
  overridesByCode: { government_id: 3, offer_letter: 10 },
  defaultYears: 5,
};

describe("retentionPolicySchema — defaults", () => {
  it("an unconfigured tenant gets no document config and the 30-day audio window", () => {
    expect(defaultRetentionPolicy()).toEqual({
      overridesByCode: {},
      defaultYears: null,
      interviewAudioDays: INTERVIEW_AUDIO_RETENTION_DAYS_DEFAULT,
    });
    expect(INTERVIEW_AUDIO_RETENTION_DAYS_DEFAULT).toBe(30);
    expect(INTERVIEW_AUDIO_HARD_CEILING_DAYS).toBe(90);
    expect(resolveRetentionPolicy({})).toEqual(defaultRetentionPolicy());
    expect(resolveRetentionPolicy(undefined)).toEqual(defaultRetentionPolicy());
    expect(resolveRetentionPolicy(null)).toEqual(defaultRetentionPolicy());
  });

  it("the default is the schema's own, not a hand-written literal that can go stale", () => {
    expect(defaultRetentionPolicy()).toEqual(retentionPolicySchema.parse({}));
  });
});

describe("resolveRetentionPolicy — a pre-A2 stored block (the no-migration guarantee)", () => {
  it("parses successfully and defaults ONLY the new field", () => {
    const parsed = retentionPolicySchema.safeParse(PRE_A2_BLOCK);
    expect(parsed.success).toBe(true);
    expect(resolveRetentionPolicy(PRE_A2_BLOCK)).toEqual({
      // Every document field survives verbatim — this is the whole point.
      overridesByCode: { government_id: 3, offer_letter: 10 },
      defaultYears: 5,
      // ...and the tenant lands on the constant the worker used before A2, so
      // its audio purges on exactly the schedule it did yesterday.
      interviewAudioDays: INTERVIEW_AUDIO_RETENTION_DAYS_DEFAULT,
    });
  });

  it("the schema is not .strict(), so an unknown sibling key is dropped rather than fatal", () => {
    // A block carrying a key from some future (or abandoned) field must not
    // take a tenant's whole policy down with it.
    expect(resolveRetentionPolicy({ ...PRE_A2_BLOCK, someFutureKey: "whatever" })).toEqual({
      overridesByCode: { government_id: 3, offer_letter: 10 },
      defaultYears: 5,
      interviewAudioDays: INTERVIEW_AUDIO_RETENTION_DAYS_DEFAULT,
    });
  });
});

describe("interviewAudioDays — the accepted range", () => {
  it("accepts every whole day from the floor to the platform ceiling", () => {
    for (const days of [1, 2, 7, 14, 29, 30, 31, 60, 89, INTERVIEW_AUDIO_HARD_CEILING_DAYS]) {
      expect(resolveRetentionPolicy({ interviewAudioDays: days }).interviewAudioDays).toBe(days);
    }
  });

  it("a configured window coexists with document config in the same block", () => {
    expect(resolveRetentionPolicy({ ...PRE_A2_BLOCK, interviewAudioDays: 7 })).toEqual({
      overridesByCode: { government_id: 3, offer_letter: 10 },
      defaultYears: 5,
      interviewAudioDays: 7,
    });
  });
});

describe("resolveRetentionPolicy — malformed blocks (all-or-nothing fallback)", () => {
  it("an out-of-range audio window loses the tenant's DOCUMENT overrides too", () => {
    // THE SHARP EDGE, asserted rather than assumed. safeParse runs on the whole
    // block, so a single bad field reverts everything — including document
    // overrides that were perfectly valid. Safe (every field falls back to a
    // platform default rather than to a half-read policy) but surprising, and
    // reachable only by a direct DB edit: updateRetentionPolicy validates
    // against this same schema.
    const corrupt = { ...PRE_A2_BLOCK, interviewAudioDays: 365 };
    expect(resolveRetentionPolicy(corrupt)).toEqual(defaultRetentionPolicy());
    expect(resolveRetentionPolicy(corrupt).overridesByCode).toEqual({});
    expect(resolveRetentionPolicy(corrupt).defaultYears).toBeNull();
  });

  it("0, 91, negatives, fractions and wrong types all fall back to the FULL default", () => {
    for (const bad of [0, -1, 91, 30.5, "30", null, true, [], {}]) {
      expect(resolveRetentionPolicy({ ...PRE_A2_BLOCK, interviewAudioDays: bad })).toEqual(
        defaultRetentionPolicy(),
      );
    }
  });

  it("a bad DOCUMENT field equally discards the audio window", () => {
    // Symmetric — the audio field is no more privileged than the document ones.
    expect(resolveRetentionPolicy({ overridesByCode: { x: 500 }, interviewAudioDays: 7 })).toEqual(
      defaultRetentionPolicy(),
    );
    expect(resolveRetentionPolicy({ defaultYears: "five", interviewAudioDays: 7 })).toEqual(
      defaultRetentionPolicy(),
    );
  });

  it("a non-object never throws — the sweep and the router both rely on that", () => {
    expect(resolveRetentionPolicy("not-a-policy")).toEqual(defaultRetentionPolicy());
    expect(resolveRetentionPolicy(30)).toEqual(defaultRetentionPolicy());
    expect(resolveRetentionPolicy([])).toEqual(defaultRetentionPolicy());
  });
});

describe("updateRetentionPolicyInputSchema (the write path)", () => {
  it("rejects a window outside 1..90 rather than clamping it", () => {
    const base = { overridesByCode: {}, defaultYears: null };
    expect(
      updateRetentionPolicyInputSchema.safeParse({ ...base, interviewAudioDays: 0 }).success,
    ).toBe(false);
    expect(
      updateRetentionPolicyInputSchema.safeParse({
        ...base,
        interviewAudioDays: INTERVIEW_AUDIO_HARD_CEILING_DAYS + 1,
      }).success,
    ).toBe(false);
    expect(
      updateRetentionPolicyInputSchema.safeParse({ ...base, interviewAudioDays: 7.5 }).success,
    ).toBe(false);
    expect(
      updateRetentionPolicyInputSchema.safeParse({ ...base, interviewAudioDays: 1 }).success,
    ).toBe(true);
    expect(
      updateRetentionPolicyInputSchema.safeParse({
        ...base,
        interviewAudioDays: INTERVIEW_AUDIO_HARD_CEILING_DAYS,
      }).success,
    ).toBe(true);
  });

  it("a documents-only write is still valid and means 'the default audio window'", () => {
    // The admin surface always sends the field, but the schema accepting a
    // documents-only write is what keeps every pre-A2 stored block readable.
    expect(updateRetentionPolicyInputSchema.parse(PRE_A2_BLOCK)).toEqual({
      overridesByCode: { government_id: 3, offer_letter: 10 },
      defaultYears: 5,
      interviewAudioDays: INTERVIEW_AUDIO_RETENTION_DAYS_DEFAULT,
    });
  });
});

describe("effectiveRetentionYears — unchanged by A2", () => {
  const policy: RetentionPolicy = {
    overridesByCode: { government_id: 3 },
    defaultYears: 5,
    interviewAudioDays: 7,
  };

  it("precedence is still override > reference > defaultYears > null", () => {
    expect(effectiveRetentionYears("government_id", 7, policy)).toBe(3);
    expect(effectiveRetentionYears("pan_card", 7, policy)).toBe(7);
    expect(effectiveRetentionYears("misc_code", null, policy)).toBe(5);
    expect(effectiveRetentionYears("misc_code", null, defaultRetentionPolicy())).toBeNull();
  });

  it("an override of 0 is still honoured, not treated as absent", () => {
    expect(
      effectiveRetentionYears("government_id", 7, {
        ...defaultRetentionPolicy(),
        overridesByCode: { government_id: 0 },
      }),
    ).toBe(0);
  });

  it("the audio window never leaks into a document answer", () => {
    // It is measured in DAYS. If it were ever consulted here, a 7-day audio
    // window would silently become a 7-YEAR document retention.
    expect(effectiveRetentionYears("unknown_code", null, { ...policy, defaultYears: null })).toBe(
      null,
    );
  });
});
