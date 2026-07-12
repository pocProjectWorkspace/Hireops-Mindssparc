import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEmailProvider, resetEmailProviderCache } from "../src/factory";

/**
 * Factory env-resolution tests. vitest sets NODE_ENV=test by default, so
 * every test that exercises a non-test codepath explicitly overrides
 * NODE_ENV, and one test asserts the NODE_ENV=test local-forcing.
 *
 * No provider is ever `.send()`-ed here, so LocalEmailProvider's
 * @hireops/db import never opens a connection — DB-free.
 */

const ORIGINAL_ENV = { ...process.env };

describe("getEmailProvider factory", () => {
  beforeEach(() => {
    resetEmailProviderCache();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetEmailProviderCache();
  });

  it("NODE_ENV=test forces local even when EMAIL_PROVIDER=resend", () => {
    process.env.NODE_ENV = "test";
    process.env.EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_x";
    process.env.EMAIL_FROM = "HireOps <no-reply@x.test>";

    expect(getEmailProvider("tenant-1").provider).toBe("local");
  });

  it("unset EMAIL_PROVIDER defaults to local", () => {
    process.env.NODE_ENV = "production";
    delete process.env.EMAIL_PROVIDER;

    expect(getEmailProvider("tenant-1").provider).toBe("local");
  });

  it("EMAIL_PROVIDER=resend without RESEND_API_KEY throws naming the var", () => {
    process.env.NODE_ENV = "production";
    process.env.EMAIL_PROVIDER = "resend";
    delete process.env.RESEND_API_KEY;
    process.env.EMAIL_FROM = "HireOps <no-reply@x.test>";

    expect(() => getEmailProvider("tenant-1")).toThrow(/RESEND_API_KEY/);
  });

  it("EMAIL_PROVIDER=resend without EMAIL_FROM throws naming the var", () => {
    process.env.NODE_ENV = "production";
    process.env.EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_x";
    delete process.env.EMAIL_FROM;

    expect(() => getEmailProvider("tenant-1")).toThrow(/EMAIL_FROM/);
  });

  it("EMAIL_PROVIDER=resend with both vars returns a provider tagged resend", () => {
    process.env.NODE_ENV = "production";
    process.env.EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_x";
    process.env.EMAIL_FROM = "HireOps <no-reply@x.test>";

    expect(getEmailProvider("tenant-1").provider).toBe("resend");
  });

  it("EMAIL_PROVIDER=real errors and points to resend", () => {
    process.env.NODE_ENV = "production";
    process.env.EMAIL_PROVIDER = "real";

    expect(() => getEmailProvider("tenant-1")).toThrow(/resend/i);
  });

  it("unknown EMAIL_PROVIDER throws", () => {
    process.env.NODE_ENV = "production";
    process.env.EMAIL_PROVIDER = "sendgrid";

    expect(() => getEmailProvider("tenant-1")).toThrow(/Unknown EMAIL_PROVIDER/);
  });
});
