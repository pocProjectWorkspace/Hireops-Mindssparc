import { afterEach, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { getEnv, resetEnvCache } from "../src/lib/env";

describe("env validation", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    resetEnvCache();
  });

  it("returns the parsed shape when required vars are present", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    process.env.NEXT_PUBLIC_ENV = "dev";
    resetEnvCache();
    const env = getEnv();
    assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, "https://example.supabase.co");
    assert.equal(env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "anon-key");
    assert.equal(env.NEXT_PUBLIC_ENV, "dev");
  });

  it("defaults NEXT_PUBLIC_ENV to 'dev' when absent", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    delete process.env.NEXT_PUBLIC_ENV;
    resetEnvCache();
    assert.equal(getEnv().NEXT_PUBLIC_ENV, "dev");
  });

  it("throws when NEXT_PUBLIC_SUPABASE_URL is not a URL", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "not-a-url";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    resetEnvCache();
    let threw = false;
    try {
      getEnv();
    } catch (e) {
      threw = true;
      assert.match((e as Error).message, /NEXT_PUBLIC_SUPABASE_URL/);
    }
    assert.ok(threw, "expected getEnv to throw");
  });

  it("memoises after the first call", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    resetEnvCache();
    const a = getEnv();
    // Mutate process.env without resetting cache → memoised value wins.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://other.supabase.co";
    const b = getEnv();
    assert.equal(a, b, "cached instance returned");
    assert.equal(b.NEXT_PUBLIC_SUPABASE_URL, "https://example.supabase.co");
  });
});
