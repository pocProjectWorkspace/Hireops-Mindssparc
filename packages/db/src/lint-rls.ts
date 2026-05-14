/**
 * RLS lint — fails if any public-schema table is missing the expected RLS state.
 *
 * Contract:
 *   - Allowlisted (platform) tables must have RLS enabled + FORCE ROW LEVEL
 *     SECURITY on. Their policies are their own concern (each has a bespoke
 *     justification documented in 0003_rls_baseline.sql or the migration that
 *     introduced it).
 *   - All other tables are treated as tenant-scoped and MUST have:
 *       - RLS enabled
 *       - FORCE ROW LEVEL SECURITY on
 *       - A policy named `tenant_isolation` whose qualifier references
 *         current_tenant_id() (the framework's outermost predicate; see
 *         ADR-002 §5.3).
 *
 * Adding a table to the allowlist is a deliberate decision. Justify in the
 * comment next to the entry. Default for any new table is tenant-scoped.
 *
 * Exit codes: 0 on PASS, 1 on FAIL. Run with: pnpm db:lint:rls
 *
 * TODO: wire into CI when FND-01..14 lands the GitHub Actions workflow files.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env") });

import postgres from "postgres";

const DIRECT_URL = process.env.DIRECT_URL;
if (!DIRECT_URL) {
  throw new Error("DIRECT_URL is not set. Add it to your .env file.");
}

// Tables that are platform-level and not tenant-scoped.
// Adding a table here is a deliberate decision — justify in comment.
const PLATFORM_TABLES_ALLOWLIST = new Set<string>([
  "tenants", // the tenant registry itself; rows keyed by tenant id, not tenant_id
  "tenant_user_memberships", // membership join table (user-scoped, not tenant-scoped)
  "tenant_encryption_keys", // DEK store; service-role only per ADR-002 §5.5, no authenticated reads
  "users", // platform-level user profile (user-scoped via id = auth.uid(), survives tenant deletion)
]);

interface TableRow {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
}

interface PolicyRow {
  tablename: string;
  policyname: string;
  qual: string | null;
  with_check: string | null;
}

async function main() {
  const sql = postgres(DIRECT_URL as string, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 2,
  });

  try {
    const tables = await sql<TableRow[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname NOT LIKE '__drizzle%'
      ORDER BY c.relname
    `;

    const policies = await sql<PolicyRow[]>`
      SELECT tablename, policyname, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
    `;

    // Index policies by table for the tenant-isolation check.
    const policiesByTable = new Map<string, PolicyRow[]>();
    for (const p of policies) {
      const list = policiesByTable.get(p.tablename) ?? [];
      list.push(p);
      policiesByTable.set(p.tablename, list);
    }

    const violations: string[] = [];
    let platformCount = 0;
    let tenantCount = 0;

    for (const t of tables) {
      const name = t.relname;
      const allowlisted = PLATFORM_TABLES_ALLOWLIST.has(name);

      if (!t.relrowsecurity) {
        violations.push(`${name}: RLS not enabled`);
      }
      if (!t.relforcerowsecurity) {
        violations.push(`${name}: FORCE ROW LEVEL SECURITY not enabled`);
      }

      if (allowlisted) {
        platformCount += 1;
      } else {
        tenantCount += 1;
        const tblPolicies = policiesByTable.get(name) ?? [];
        // Accept either a single policy named `tenant_isolation` (the common
        // shape) OR a set of split policies named `tenant_isolation_*` that
        // together cover the table (e.g. tenant_isolation_select +
        // tenant_isolation_insert for append-only audit tables).
        const isolationPolicies = tblPolicies.filter((p) =>
          p.policyname.startsWith("tenant_isolation"),
        );
        if (isolationPolicies.length === 0) {
          violations.push(
            `${name}: missing tenant_isolation policy (required for non-allowlisted tables)`,
          );
        } else {
          // At least one of the matching policies must reference
          // current_tenant_id() in qual or with_check. We require all of
          // them to reference it — a tenant_isolation_* policy that doesn't
          // is almost certainly a mistake.
          const noRef = isolationPolicies.filter(
            (p) =>
              !p.qual?.includes("current_tenant_id") &&
              !p.with_check?.includes("current_tenant_id"),
          );
          if (noRef.length > 0) {
            violations.push(
              `${name}: tenant_isolation policy/policies missing current_tenant_id() reference (${noRef.map((p) => p.policyname).join(", ")})`,
            );
          }
        }
      }
    }

    console.log(`Tables checked: ${tables.length}`);
    console.log(`  platform (allowlisted): ${platformCount}`);
    console.log(`  tenant-scoped:           ${tenantCount}`);
    console.log("");
    for (const t of tables) {
      const tag = PLATFORM_TABLES_ALLOWLIST.has(t.relname) ? "[platform]" : "[tenant]";
      console.log(`  ${tag} ${t.relname}  rls=${t.relrowsecurity} forced=${t.relforcerowsecurity}`);
    }

    if (violations.length > 0) {
      console.log("");
      console.error(`RLS lint: FAIL — ${violations.length} violation(s)`);
      for (const v of violations) console.error(`  - ${v}`);
      process.exit(1);
    }

    console.log("");
    console.log(
      `RLS lint: PASS — ${tables.length} tables checked, ${platformCount} platform, ${tenantCount} tenant-scoped`,
    );
  } finally {
    await sql.end({ timeout: 2 });
  }
}

main()
  .catch((err) => {
    console.error("Lint failed:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
