/**
 * C1-F10 — make an EXISTING auth user a platform operator (or revoke it).
 *
 * Platform operators are NOT a tenant role: they live in platform_operators
 * (migration 0134), outside tenant RLS, and the API resolves operator status
 * from the auth user id. This script is the only way to create the first one —
 * there is deliberately no API for "make me an operator".
 *
 * It NEVER runs automatically (not chained from any other seed) and REQUIRES an
 * explicit email. It does not create auth users or passwords: the person must
 * already exist in auth.users (e.g. a staff login). An operator with no tenant
 * membership signs in at the internal /login and is routed to /platform.
 *
 * Usage (from repo root, Node 22):
 *   pnpm db:seed:platform-operator -- --email=ops@mindssparc.com [--role=owner|operator|support]
 *   pnpm db:seed:platform-operator -- --email=ops@mindssparc.com --deactivate
 *
 * Idempotent: re-running updates the role and re-activates the row. Every run
 * writes a platform_audit_log row (operator = this script).
 *
 * Which database: DATABASE_URL (exported variables win over the repo-root .env
 * that dotenv loads). The script prints the target host before writing.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const ROLES = ["owner", "operator", "support"] as const;
type Role = (typeof ROLES)[number];

function parseArgs(argv: string[]): { email: string; role: Role; deactivate: boolean } {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const email = get("email")?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("Required: --email=<existing auth user email>");
  }
  const roleArg = (get("role") ?? "operator") as Role;
  if (!ROLES.includes(roleArg)) {
    throw new Error(`--role must be one of ${ROLES.join(", ")}`);
  }
  return { email, role: roleArg, deactivate: argv.includes("--deactivate") };
}

async function main(): Promise<void> {
  const { email, role, deactivate } = parseArgs(process.argv.slice(2));

  // Imported after dotenv so client.ts sees DATABASE_URL.
  const { sql } = await import("../client");
  try {
    const host = (sql.options as { host?: string[] }).host?.join(",") ?? "?";
    console.log(`[platform-operator] target database host: ${host}`);

    const users = await sql<{ id: string; email: string }[]>`
      SELECT id::text AS id, email FROM auth.users WHERE lower(email) = ${email}
    `;
    const user = users[0];
    if (!user) {
      throw new Error(`No auth user with email ${email}. Create the login first.`);
    }

    await sql.begin(async (tx) => {
      if (deactivate) {
        const rows = await tx<{ id: string }[]>`
          UPDATE public.platform_operators
             SET active = false, deactivated_at = now()
           WHERE user_id = ${user.id}
          RETURNING id::text AS id
        `;
        if (rows.length === 0) throw new Error(`${email} is not a platform operator.`);
        await tx`
          INSERT INTO public.platform_audit_log (operator_id, operator_email, action, summary)
          VALUES (NULL, 'system:seed-platform-operator', 'operator.deactivate',
                  ${JSON.stringify({ email })}::jsonb)
        `;
        console.log(`[platform-operator] deactivated ${email}`);
        return;
      }
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO public.platform_operators (user_id, email, role, active)
        VALUES (${user.id}, ${user.email ?? email}, ${role}, true)
        ON CONFLICT (user_id) DO UPDATE
          SET role = EXCLUDED.role, email = EXCLUDED.email,
              active = true, deactivated_at = NULL
        RETURNING id::text AS id
      `;
      await tx`
        INSERT INTO public.platform_audit_log (operator_id, operator_email, action, summary)
        VALUES (NULL, 'system:seed-platform-operator', 'operator.grant',
                ${JSON.stringify({ email, role, operatorId: row?.id ?? null })}::jsonb)
      `;
      console.log(`[platform-operator] ${email} is now an active platform ${role} (${row?.id})`);
    });
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(`[platform-operator] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
