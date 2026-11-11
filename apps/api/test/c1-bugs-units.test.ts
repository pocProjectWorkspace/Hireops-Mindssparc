/**
 * C1-BUGS — the PURE halves of BUG-3 (probation from the offer), BUG-7 /
 * NEW-8 (Ask-data source relabels), BUG-9 (worker claim-warning window),
 * BUG-12 (req_only exclusivity) and NEW-14 (explicit seed tenant slug).
 *
 * No database queries. onboarding-case.ts imports @hireops/db (whose client
 * needs a DATABASE_URL to construct — it never connects unless queried), so
 * bootstrap is loaded for the env; nothing here touches the shared DB.
 */
import "../src/bootstrap";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROBATION_DAYS, resolveProbation } from "../src/lib/onboarding-case";
import {
  claimCoversRequisition,
  newClaimScope,
  resolveClaimForSubmission,
  type ActiveClaimView,
} from "../src/lib/partner-claims";
import { sourceName } from "../src/lib/ask-data/execute";
import { isWithinClaimWarningWindow } from "../../../apps/workers/src/jobs/ownership-claim-sweep.js";
import {
  MissingTenantSlugError,
  tenantSlugFromEnv,
} from "../../../packages/db/src/scripts/tenant-slug.js";

describe("BUG-3 resolveProbation — onboarding takes the accepted offer's probation", () => {
  it("3 months from a known start ends on the same calendar day", () => {
    expect(resolveProbation("2026-01-15", 3)).toEqual({
      probationDays: 90,
      probationEndsAt: "2026-04-15",
    });
  });
  it("6 months is not the 90-day default", () => {
    const r = resolveProbation("2026-11-01", 6);
    expect(r.probationEndsAt).toBe("2027-05-01");
    expect(r.probationDays).toBe(181);
  });
  it("month-end start clamps to the target month's last day", () => {
    expect(resolveProbation("2026-11-30", 3).probationEndsAt).toBe("2027-02-28");
  });
  it("0 months → no probation", () => {
    expect(resolveProbation("2026-11-01", 0)).toEqual({
      probationDays: 0,
      probationEndsAt: "2026-11-01",
    });
  });
  it("unknown start date → months × 30, no end date", () => {
    expect(resolveProbation(null, 6)).toEqual({ probationDays: 180, probationEndsAt: null });
  });
  it("no probation on the offer (legacy) → the platform default", () => {
    expect(resolveProbation("2026-01-01", null)).toEqual({
      probationDays: DEFAULT_PROBATION_DAYS,
      probationEndsAt: "2026-04-01",
    });
    expect(resolveProbation("2026-01-01", -1).probationDays).toBe(DEFAULT_PROBATION_DAYS);
  });
  it("the 24-month offer maximum fits the widened 0..731 CHECK", () => {
    expect(resolveProbation("2028-02-29", 24).probationDays).toBeLessThanOrEqual(731);
    expect(resolveProbation(null, 24).probationDays).toBeLessThanOrEqual(731);
  });
});

describe("BUG-12 exclusivity scope", () => {
  const REQ_A = "00000000-0000-4000-8000-00000000000a";
  const REQ_B = "00000000-0000-4000-8000-00000000000b";
  const orgWide = (org: string): ActiveClaimView => ({
    id: `c-${org}`,
    partnerOrgId: org,
    exclusivityScope: "org_wide",
    requisitionId: null,
  });
  const reqOnly = (org: string, req: string): ActiveClaimView => ({
    id: `c-${org}-${req}`,
    partnerOrgId: org,
    exclusivityScope: "req_only",
    requisitionId: req,
  });

  it("org_wide covers every requisition; req_only only its own", () => {
    expect(claimCoversRequisition(orgWide("P1"), REQ_B)).toBe(true);
    expect(claimCoversRequisition(reqOnly("P1", REQ_A), REQ_A)).toBe(true);
    expect(claimCoversRequisition(reqOnly("P1", REQ_A), REQ_B)).toBe(false);
  });
  it("an unknown scope fails closed to org_wide", () => {
    expect(
      claimCoversRequisition(
        { id: "x", partnerOrgId: "P1", exclusivityScope: "weird", requisitionId: REQ_A },
        REQ_B,
      ),
    ).toBe(true);
  });
  it("another org's org_wide claim blocks a different req (unchanged behaviour)", () => {
    expect(resolveClaimForSubmission([orgWide("P1")], "P2", REQ_B).kind).toBe("blocked");
  });
  it("another org's req_only claim blocks the same req but NOT a different one", () => {
    expect(resolveClaimForSubmission([reqOnly("P1", REQ_A)], "P2", REQ_A).kind).toBe("blocked");
    expect(resolveClaimForSubmission([reqOnly("P1", REQ_A)], "P2", REQ_B).kind).toBe("new");
  });
  it("own covering claim → added under it; own req_only on another req → new claim", () => {
    expect(resolveClaimForSubmission([orgWide("P1")], "P1", REQ_B).kind).toBe("own");
    expect(resolveClaimForSubmission([reqOnly("P1", REQ_A)], "P1", REQ_A).kind).toBe("own");
    expect(resolveClaimForSubmission([reqOnly("P1", REQ_A)], "P1", REQ_B).kind).toBe("new");
  });
  it("a blocking claim outranks the submitter's own", () => {
    const d = resolveClaimForSubmission([reqOnly("P1", REQ_A), reqOnly("P2", REQ_A)], "P2", REQ_A);
    expect(d.kind).toBe("blocked");
  });
  it("new claims snapshot the MSA scope (no MSA → org_wide)", () => {
    expect(newClaimScope("req_only", REQ_A)).toEqual({
      exclusivityScope: "req_only",
      requisitionId: REQ_A,
    });
    expect(newClaimScope("org_wide", REQ_A)).toEqual({
      exclusivityScope: "org_wide",
      requisitionId: null,
    });
    expect(newClaimScope(undefined, REQ_A).exclusivityScope).toBe("org_wide");
  });
});

describe("BUG-7 / NEW-8 Ask-data source wording", () => {
  it("tenant relabel → platform default → humanized key", () => {
    expect(sourceName({ sourceLabels: { job_board: "Naukri" } }, "job_board")).toBe("Naukri");
    expect(sourceName({ sourceLabels: null }, "job_board")).toBe("Job board");
    expect(sourceName({}, "some_new_source")).toBe("Some new source");
  });
});

describe("BUG-9 worker claim-warning window uses the tenant setting", () => {
  const now = new Date("2026-11-11T00:00:00Z");
  const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);
  it("platform default (14 days) when unconfigured — the same number as the portal feed", () => {
    expect(isWithinClaimWarningWindow(inDays(10), now, {})).toBe(true);
    expect(isWithinClaimWarningWindow(inDays(14), now, {})).toBe(true);
    expect(isWithinClaimWarningWindow(inDays(15), now, {})).toBe(false);
  });
  it("tenant override", () => {
    const s = { partnerDefaults: { claimExpiryWarningDays: 7 } };
    expect(isWithinClaimWarningWindow(inDays(5), now, s)).toBe(true);
    expect(isWithinClaimWarningWindow(inDays(10), now, s)).toBe(false);
  });
  it("already-expired claims are the sweep's, not the warning's", () => {
    expect(isWithinClaimWarningWindow(inDays(-1), now, {})).toBe(false);
  });
});

describe("NEW-14 seed scripts require an explicit tenant slug", () => {
  it("unset or blank → a clear error, no client default", () => {
    expect(() => tenantSlugFromEnv({})).toThrow(MissingTenantSlugError);
    expect(() => tenantSlugFromEnv({ HIREOPS_TENANT_SLUG: "  " })).toThrow(/HIREOPS_TENANT_SLUG/);
  });
  it("set → used verbatim (trimmed)", () => {
    expect(tenantSlugFromEnv({ HIREOPS_TENANT_SLUG: " acme " })).toBe("acme");
  });
});
