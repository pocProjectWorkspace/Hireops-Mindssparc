/**
 * PC-26 — static privacy guardrails for diversity self-ID. PURE: reads source
 * files only, no DB, no network, no migration needed.
 *
 *   1. Only an allowlist of files may name the self-ID table (Drizzle symbol
 *      or SQL name) or import the server helper module. In particular no AI
 *      prompt builder (scoring, evidence, interview, prep, JD, Iris, ask-data),
 *      no worker, no report / export and no partner-portal code does.
 *   2. The prompt-builder packages / modules carry no diversity vocabulary at
 *      all, so a future edit that threads a self-ID value into a prompt input
 *      trips this test.
 *   3. Partner submit cannot carry a self-ID (input schema has no such key).
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(here, "../../..");

/** Every .ts/.tsx/.sql source file under `dir`, skipping build output + iCloud dupes. */
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name === "dist" || name.startsWith("."))
      continue;
    if (/ \d+(\.[a-z]+)?$/.test(name) || / \d+\./.test(name)) continue; // "foo 2.ts"
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|sql)$/.test(name)) out.push(p);
  }
  return out;
}

/** Source with block / line comments (and SQL `--` comments) removed — code only. */
function code(p: string): string {
  const src = readFileSync(p, "utf8");
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1").replace(/^\s*--.*$/, ""))
    .join("\n");
}

const SOURCE_ROOTS = ["apps", "packages"].map((d) => join(ROOT, d));
const ALL = SOURCE_ROOTS.flatMap((d) => walk(d)).filter((p) => !p.includes(`${"/"}test${"/"}`));
const rel = (p: string) => relative(ROOT, p);

// Files allowed to touch the raw table. Everything else gets counts via the
// lib's aggregate functions or nothing at all.
const TABLE_ALLOWLIST = new Set([
  "packages/db/src/schema/candidate-diversity-self-id.ts",
  "packages/db/src/schema/index.ts",
  "packages/db/drizzle/migrations/0126_diversity_slate.sql",
  "apps/api/src/lib/diversity-slate.ts",
]);
const LIB_IMPORT_ALLOWLIST = new Set(["apps/api/src/trpc/router.ts"]);

describe("PC-26 guardrails — who may touch raw self-ID", () => {
  it("only the allowlisted files name the self-ID table", () => {
    const offenders = ALL.filter((p) => {
      return /candidate_diversity_self_id|candidateDiversitySelfId/.test(code(p));
    })
      .map(rel)
      .filter(
        (r) => !TABLE_ALLOWLIST.has(r) && !r.startsWith("packages/db/drizzle/migrations/meta"),
      );
    expect(offenders).toEqual([]);
  });

  it("only the router imports the server self-ID helpers", () => {
    const offenders = ALL.filter((p) => /lib\/diversity-slate["']/.test(code(p)))
      .map(rel)
      .filter((r) => !LIB_IMPORT_ALLOWLIST.has(r));
    expect(offenders).toEqual([]);
  });

  it("the router never queries the table itself (counts go through the lib)", () => {
    const router = code(join(ROOT, "apps/api/src/trpc/router.ts"));
    expect(router).not.toMatch(/candidate_diversity_self_id|candidateDiversitySelfId/);
  });
});

// Prompt builders + AI / evidence / export / partner code: no diversity vocabulary.
const NO_DIVERSITY_DIRS = [
  "packages/ai-scoring/src",
  "packages/ai-client/src",
  "apps/workers/src",
  "apps/partner-portal/src",
  "apps/api/src/lib/iris",
  "apps/api/src/lib/ask-data",
  "apps/api/src/lib/reports",
];
const NO_DIVERSITY_FILES = [
  "apps/api/src/lib/ai-interview-evidence-read.ts",
  "apps/api/src/lib/ai-interview-questions.ts",
  "apps/api/src/lib/ai-interview-session.ts",
  "apps/api/src/lib/interview-prep.ts",
  "apps/api/src/lib/feedback-summary.ts",
  "apps/api/src/lib/jd-generation.ts",
  "apps/api/src/lib/recruiter-brief.ts",
  "apps/api/src/lib/skill-match.ts",
  "apps/api/src/lib/screening-answers.ts",
  "apps/api/src/lib/comp-recommendation.ts",
];
const VOCAB =
  /diversitySelfId|diversity_self_id|DiversitySelfId|diverseSlate|diversitySlate|lib\/diversity-slate/;

describe("PC-26 guardrails — AI prompts, evidence, workers, exports, partner portal", () => {
  const files = [
    ...NO_DIVERSITY_DIRS.flatMap((d) => walk(join(ROOT, d))),
    ...NO_DIVERSITY_FILES.map((f) => join(ROOT, f)),
  ];

  it("covers a real set of files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("no prompt builder / worker / export / partner file references self-ID or slate data", () => {
    const offenders = files
      .filter((p) => {
        try {
          return VOCAB.test(code(p));
        } catch {
          return false;
        }
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("PC-26 guardrails — partner submit cannot carry demographics", () => {
  it("no partner-facing input schema mentions self-ID", () => {
    const procedures = readFileSync(join(ROOT, "packages/api-types/src/procedures.ts"), "utf8");
    // The only schema allowed to carry diversitySelfId is the public apply form's.
    const carriers = [...procedures.matchAll(/^export const (\w+) = [\s\S]*?^\}\);/gm)]
      .filter((m) => /diversitySelfId/.test(m[0]))
      .map((m) => m[1]);
    expect(carriers).toEqual(["submitApplicationInputSchema"]);
  });
});
