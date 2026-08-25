import { describe, expect, it } from "vitest";
import {
  SYSTEM_SETUP_VERSION,
  SLA_IMMINENT_WINDOW_HOURS_DEFAULT,
  SLA_IMMINENT_WINDOW_HOURS_MIN,
  SLA_IMMINENT_WINDOW_HOURS_MAX,
  defaultSystemSetup,
  resolveSystemSetup,
  systemSetupSchema,
  updateSystemSetupInputSchema,
  getSystemSetupOutputSchema,
} from "../src/admin-ops";

/**
 * A4 — the SLA-imminent alert window is per-tenant.
 *
 * The window lives in the `systemSetup` block (which already owns "who gets
 * alerted") as `slaImminentWindowHours`, and the SLA scan worker
 * (apps/workers/src/jobs/sla-imminent-scan.ts) reads it per tenant when it
 * composes the imminent-CASE SQL. Everything load-bearing about that read is
 * `resolveSystemSetup`'s behaviour, so that is what is pinned here:
 *
 *   - A block stored BEFORE A4 has no such key. It must resolve to 4 — the
 *     exact constant the worker used pre-config — WITHOUT a
 *     SYSTEM_SETUP_VERSION bump, because adding a defaulted field is a
 *     non-breaking shape change (the ai-settings discipline: bump only on
 *     breaking shape changes). If this regressed, every existing tenant's
 *     alerting would silently shift on deploy.
 *   - An out-of-range / malformed value must not throw inside a cross-tenant
 *     scan. resolveSystemSetup's safeParse fallback is all-or-nothing: the
 *     WHOLE block reverts to defaults, not just the bad field. That is a sharp
 *     edge worth pinning explicitly rather than assuming.
 *   - An in-range value must survive the round trip the admin surface actually
 *     performs (updateSystemSetup validates its input with this same schema,
 *     then re-resolves it before persisting).
 *
 * Kept pure (no DB) so the resolve discipline is covered without live-DB flake.
 */

describe("systemSetupSchema — slaImminentWindowHours", () => {
  it("an empty block resolves to the platform default window of 4 hours", () => {
    expect(resolveSystemSetup({})).toEqual({
      version: SYSTEM_SETUP_VERSION,
      emailAlerts: { enabled: false, recipients: [], alertTypes: [] },
      escalationRules: [],
      slaImminentWindowHours: SLA_IMMINENT_WINDOW_HOURS_DEFAULT,
    });
    expect(SLA_IMMINENT_WINDOW_HOURS_DEFAULT).toBe(4);
    expect(resolveSystemSetup(undefined)).toEqual(defaultSystemSetup());
    expect(resolveSystemSetup(null)).toEqual(defaultSystemSetup());
  });

  it("a pre-A4 stored block (no window key) still parses, keeps its own config, and defaults to 4", () => {
    // Byte-for-byte the shape written by the pre-A4 admin surface.
    const legacyBlock = {
      version: 1,
      emailAlerts: {
        enabled: true,
        recipients: ["ops@example.com"],
        alertTypes: ["sla_breach"],
      },
      escalationRules: [{ daysThreshold: 3, recipient: "lead@example.com", severity: "high" }],
    };
    const parsed = systemSetupSchema.safeParse(legacyBlock);
    // No `.strict()` anywhere in the chain, and the new field is defaulted —
    // so the absent key is a parse SUCCESS, not a fallback to defaults.
    expect(parsed.success).toBe(true);

    const r = resolveSystemSetup(legacyBlock);
    expect(r.slaImminentWindowHours).toBe(SLA_IMMINENT_WINDOW_HOURS_DEFAULT);
    // The rest of the tenant's config survives untouched — proving this
    // resolved to the field default rather than falling back to the whole
    // default block.
    expect(r.emailAlerts.enabled).toBe(true);
    expect(r.emailAlerts.recipients).toEqual(["ops@example.com"]);
    expect(r.escalationRules).toHaveLength(1);
  });

  it("accepts the full 1–48 integer range", () => {
    for (const h of [SLA_IMMINENT_WINDOW_HOURS_MIN, 4, 12, 24, SLA_IMMINENT_WINDOW_HOURS_MAX]) {
      expect(resolveSystemSetup({ slaImminentWindowHours: h }).slaImminentWindowHours).toBe(h);
    }
    expect(SLA_IMMINENT_WINDOW_HOURS_MIN).toBe(1);
    expect(SLA_IMMINENT_WINDOW_HOURS_MAX).toBe(48);
  });

  it("out-of-range / non-integer / wrong-typed windows fall back to the FULL default block", () => {
    // resolveSystemSetup is safeParse-or-defaults: one bad field invalidates
    // the block, so the tenant's recipients go with it. Asserted explicitly
    // because a scan hitting this loses that tenant's alert config for the
    // tick — it does NOT keep the good fields and default only the bad one.
    const withRecipients = {
      emailAlerts: { enabled: true, recipients: ["ops@example.com"], alertTypes: ["sla_breach"] },
    };
    for (const bad of [0, -1, 49, 1000, 4.5, "4", null, true]) {
      const r = resolveSystemSetup({ ...withRecipients, slaImminentWindowHours: bad });
      expect(r).toEqual(defaultSystemSetup());
      expect(r.slaImminentWindowHours).toBe(SLA_IMMINENT_WINDOW_HOURS_DEFAULT);
      expect(r.emailAlerts.enabled).toBe(false);
    }
    // A non-object block is the same story.
    expect(resolveSystemSetup("garbage")).toEqual(defaultSystemSetup());
  });

  it("adding the field did NOT bump the version — a stored version:1 block still parses", () => {
    expect(SYSTEM_SETUP_VERSION).toBe(1);
    expect(resolveSystemSetup({ version: 1 }).version).toBe(1);
    // A future version is rejected by the literal and degrades to defaults,
    // which is the whole point of reserving the bump for breaking changes.
    expect(resolveSystemSetup({ version: 2 })).toEqual(defaultSystemSetup());
  });

  it("an in-range value survives the admin round trip (input schema → resolve → output schema)", () => {
    const submitted = {
      version: 1 as const,
      emailAlerts: {
        enabled: true,
        recipients: ["ops@example.com"],
        alertTypes: ["sla_breach" as const],
      },
      escalationRules: [],
      slaImminentWindowHours: 12,
    };
    // updateSystemSetup validates with this schema, then re-resolves the input
    // before writing it to tenants.settings.
    const input = updateSystemSetupInputSchema.parse(submitted);
    expect(input.slaImminentWindowHours).toBe(12);

    const persisted = resolveSystemSetup(input);
    expect(persisted.slaImminentWindowHours).toBe(12);

    // …and what getSystemSetup hands back to the admin surface round-trips too,
    // so the field is not dropped on the way out (the aliasing of both
    // procedure schemas to systemSetupSchema is what makes this free).
    const readBack = getSystemSetupOutputSchema.parse(JSON.parse(JSON.stringify(persisted)));
    expect(readBack).toEqual(persisted);
  });
});
