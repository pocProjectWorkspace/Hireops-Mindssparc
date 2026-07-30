import { describe, expect, it } from "vitest";
import {
  AI_FEATURE_KEYS,
  AI_FEATURE_META,
  aiSettingsSchema,
  defaultAiSettings,
} from "../src/ai-settings";

/**
 * IRIS kill-switch — the `iris_assistant` AI feature key.
 *
 * ONE key governs BOTH Iris AI calls (usageFeatures iris_intent +
 * iris_message_draft). It must appear in the key list, carry an honest META
 * entry the admin surface renders, and — crucially for byte-compatibility —
 * resolve to ENABLED for an existing tenant whose stored block predates the key
 * (additive-with-defaults; no version bump). These are pure-schema assertions,
 * no DB.
 */
describe("ai-settings: iris_assistant feature key", () => {
  it("is present in AI_FEATURE_KEYS", () => {
    expect(AI_FEATURE_KEYS).toContain("iris_assistant");
  });

  it("has an AI_FEATURE_META entry that governs BOTH Iris AI calls", () => {
    const meta = AI_FEATURE_META.iris_assistant;
    expect(meta).toBeDefined();
    expect(meta.label).toBe("Iris assistant (AI drafting)");
    expect(meta.usageFeatures).toEqual(["iris_intent", "iris_message_draft"]);
    expect(meta.description.length).toBeGreaterThan(0);
  });

  it("every AI_FEATURE_KEYS entry has a META entry (no orphaned key)", () => {
    for (const key of AI_FEATURE_KEYS) {
      expect(AI_FEATURE_META[key]).toBeDefined();
    }
  });

  it("defaults to enabled when a tenant's stored block omits it (byte-compatible)", () => {
    // Parsing an empty block == a tenant that never wrote the key.
    const resolved = aiSettingsSchema.parse({});
    expect(resolved.iris_assistant.enabled).toBe(true);
    expect(defaultAiSettings().iris_assistant.enabled).toBe(true);
  });

  it("resolves iris_assistant defaults even for a partial legacy block", () => {
    // A pre-IRIS stored block with only some other keys must still fill
    // iris_assistant up to the enabled default rather than throwing.
    const resolved = aiSettingsSchema.parse({ jd_generation: { enabled: false } });
    expect(resolved.iris_assistant.enabled).toBe(true);
    expect(resolved.jd_generation.enabled).toBe(false);
  });

  it("honours an explicit disable of iris_assistant", () => {
    const resolved = aiSettingsSchema.parse({ iris_assistant: { enabled: false } });
    expect(resolved.iris_assistant.enabled).toBe(false);
  });
});
