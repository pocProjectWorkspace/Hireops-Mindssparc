/**
 * P0.6 — the partner portal's first test. The middleware's public-route
 * decision is small but load-bearing in both directions: too narrow and every
 * invitee is locked out of /accept-invite (the P0.2 redemption link exists
 * precisely for visitors with no session); too wide and an authenticated-only
 * surface leaks past the session gate.
 */

import { describe, expect, it } from "vitest";
import { isPublicPath } from "../src/lib/public-paths";

describe("partner portal public paths", () => {
  it("exact public paths pass", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/logout")).toBe(true);
    // P1.4 password recovery — both legs are for visitors who can't sign in.
    expect(isPublicPath("/forgot-password")).toBe(true);
    expect(isPublicPath("/reset-password")).toBe(true);
  });

  it("accept-invite is public with or without a token segment", () => {
    expect(isPublicPath("/accept-invite")).toBe(true);
    expect(isPublicPath("/accept-invite/some-raw-token")).toBe(true);
  });

  it("prefix matching is segment-safe, not substring-sloppy", () => {
    // A route that merely STARTS with the prefix string is not public.
    expect(isPublicPath("/accept-invitees")).toBe(false);
  });

  it("everything else requires a session", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/submit")).toBe(false);
    expect(isPublicPath("/login/extra")).toBe(false);
  });
});
