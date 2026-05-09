/**
 * Verifies the FND-15b end-to-end claim propagation:
 *   1. Sign in as the test user
 *   2. Decode the issued JWT and assert tid + tenant_slug + roles claims are present
 *   3. Call current_tenant_id() via PostgREST RPC and assert it matches the JWT
 *   4. Call has_role('admin') and assert true
 *   5. Call has_role('nonexistent') and assert false
 *
 * Run with: pnpm db:test:verify
 *
 * If `tid` is missing from claims, the Custom Access Token hook is not registered
 * in the dashboard (Step 6) — re-check Authentication → Hooks.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env");
}

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";

function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) {
    throw new Error("Token is not a JWT (expected 3 segments)");
  }
  const decoded = Buffer.from(payload, "base64url").toString("utf-8");
  return JSON.parse(decoded) as Record<string, unknown>;
}

async function main() {
  // Local consts to satisfy strict TS narrowing — the throw above already guards both.
  const url = SUPABASE_URL;
  const anonKey = ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env");
  }
  const supabase = createClient(url, anonKey);

  console.log("Signing in as test user...");
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error) throw error;

  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("No access token in session");

  console.log("JWT obtained. Decoding claims...");
  const claims = decodeJwt(accessToken);
  console.log("Claims:");
  console.log(JSON.stringify(claims, null, 2));

  // Assert the expected claims are present
  const errors: string[] = [];
  if (!claims["tid"]) errors.push("Missing tid claim");
  if (!claims["tenant_slug"]) errors.push("Missing tenant_slug claim");
  if (claims["tenant_slug"] !== "kyndryl-poc")
    errors.push(`tenant_slug expected kyndryl-poc, got ${String(claims["tenant_slug"])}`);
  if (!Array.isArray(claims["roles"])) errors.push("roles claim is not an array");
  if (!(claims["roles"] as string[] | undefined)?.includes("admin"))
    errors.push("roles claim does not contain admin");

  if (errors.length > 0) {
    console.error("\nFAIL: Claims verification failed");
    errors.forEach((e) => console.error(`  - ${e}`));
    console.error(
      "\nIf tid is missing, re-check the dashboard hook is enabled and points at public.custom_access_token_hook.",
    );
    process.exit(1);
  }

  console.log("\nClaim verification: PASS");

  // Now exercise the helpers via a query that uses them
  console.log("\nExercising current_tenant_id() and has_role() via PostgREST...");
  const { data: rpcTid, error: rpcErr } = await supabase.rpc("current_tenant_id");
  if (rpcErr) {
    console.error("current_tenant_id() RPC failed:", rpcErr);
    process.exit(1);
  }
  console.log(`  current_tenant_id() returned: ${String(rpcTid)}`);
  if (rpcTid !== claims["tid"]) {
    console.error(
      `FAIL: current_tenant_id() returned ${String(rpcTid)}, expected ${String(claims["tid"])}`,
    );
    process.exit(1);
  }

  const { data: hasAdmin, error: hasErr } = await supabase.rpc("has_role", {
    role_name: "admin",
  });
  if (hasErr) {
    console.error("has_role() RPC failed:", hasErr);
    process.exit(1);
  }
  console.log(`  has_role('admin') returned: ${String(hasAdmin)}`);
  if (hasAdmin !== true) {
    console.error("FAIL: has_role(admin) should return true");
    process.exit(1);
  }

  const { data: hasNonsense } = await supabase.rpc("has_role", { role_name: "nonexistent" });
  console.log(`  has_role('nonexistent') returned: ${String(hasNonsense)}`);
  if (hasNonsense !== false) {
    console.error("FAIL: has_role(nonexistent) should return false");
    process.exit(1);
  }

  console.log("\n=========================================");
  console.log("FND-15b verification: PASS");
  console.log("=========================================");
}

main()
  .catch((err) => {
    console.error("Verification failed:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
