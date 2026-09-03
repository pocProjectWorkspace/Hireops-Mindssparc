import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readSessionClaims } from "../src/lib/session-claims";

/**
 * The wrong-door contract: a candidate or partner authenticates fine against
 * the same Supabase project, but the Custom Access Token hook only stamps
 * `tid` / `roles` for identities with a tenant_user_memberships row. Their
 * token is VALID and must decode to `null` (→ bounce to their own portal),
 * not throw — throwing is what put a raw "JWT missing required claims" error
 * page in front of anyone who typed candidate credentials into /login.
 */

/** Build an unsigned JWT with the given payload — readSessionClaims only decodes. */
function token(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.signature`;
}

describe("readSessionClaims", () => {
  it("decodes an internal identity", () => {
    const session = readSessionClaims(
      token({ sub: "user-1", tid: "tenant-1", roles: ["recruiter"], email: "r@example.com" }),
    );
    assert.deepEqual(session, {
      accessToken: token({
        sub: "user-1",
        tid: "tenant-1",
        roles: ["recruiter"],
        email: "r@example.com",
      }),
      userId: "user-1",
      tenantId: "tenant-1",
      roles: ["recruiter"],
      email: "r@example.com",
    });
  });

  it("returns null for a candidate/partner token (valid sub, no tid)", () => {
    assert.equal(readSessionClaims(token({ sub: "cand-1", email: "p@example.test" })), null);
  });

  it("defaults roles to [] when the claim is missing or malformed", () => {
    assert.deepEqual(readSessionClaims(token({ sub: "u", tid: "t" }))?.roles, []);
    assert.deepEqual(readSessionClaims(token({ sub: "u", tid: "t", roles: "admin" }))?.roles, []);
  });

  it("omits a non-string email claim rather than trusting it", () => {
    assert.equal(readSessionClaims(token({ sub: "u", tid: "t", email: 42 }))?.email, undefined);
  });

  it("throws only when the token is genuinely malformed (no sub)", () => {
    assert.throws(() => readSessionClaims(token({ tid: "tenant-1" })), /missing required claim/);
  });
});
