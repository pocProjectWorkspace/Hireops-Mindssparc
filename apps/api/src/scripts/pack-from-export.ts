/**
 * C1-F11 — CLI: turn a tenant configuration export (JSON) into a starter-pack
 * source file skeleton for review.
 *
 *   pnpm --filter @hireops/api pack:from-export <export.json> <pack-key> "<Pack label>" [out.ts]
 *
 * Reads only the file given; touches no database. Refuses a file that is not a
 * compatible HireOps tenant configuration export. Writes to stdout unless an
 * output path is given (never overwrites an existing file).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseTenantConfigDocument, starterPackSourceFromExport } from "@hireops/api-types";

function main(): void {
  const [input, key, label, out] = process.argv.slice(2);
  if (!input || !key || !label) {
    console.error('usage: pack-from-export <export.json> <pack-key> "<Pack label>" [out.ts]');
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(input, "utf8")) as unknown;
  // Accept either the bare document or the exportTenantConfig response ({ document, skipped }).
  const candidate =
    raw && typeof raw === "object" && "document" in (raw as Record<string, unknown>)
      ? (raw as { document: unknown }).document
      : raw;
  const parsed = parseTenantConfigDocument(candidate);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  const source = starterPackSourceFromExport(parsed.document, { key, label });
  if (!out) {
    process.stdout.write(source);
    return;
  }
  if (existsSync(out)) {
    console.error(`refusing to overwrite ${out}`);
    process.exit(1);
  }
  writeFileSync(out, source, "utf8");
  console.error(`wrote ${out} — review and generalise it before registering the pack`);
}

main();
