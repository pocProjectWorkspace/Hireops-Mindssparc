import type { TenantConfigDocument } from "../tenant-config";

/**
 * C1-F11 — turn a config EXPORT into a starter-pack source file SKELETON.
 *
 * The output is a starting point for review, not a finished pack: the
 * reviewer must generalise client-specific values (legal entity names, the
 * company name in labels or email copy, business units, JD templates) before
 * registering it in ./index.ts. Business units, approval matrices and panel
 * pools are dropped — they are organisation-specific, not pack material.
 * Settings blocks are kept as exported (people data is already scrubbed by the
 * export).
 */
export function starterPackSourceFromExport(
  doc: TenantConfigDocument,
  opts: { key: string; label: string; constName?: string },
): string {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(opts.key)) {
    throw new Error("pack key must be lower-case letters, digits and hyphens (2–63)");
  }
  const constName =
    opts.constName ?? `${opts.key.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_STARTER_PACK`;
  const config = { ...doc.sections };
  delete config.businessUnits;
  delete config.approvalMatrices;
  delete config.panelPools;
  const body = JSON.stringify(config, null, 2).replace(/\n/g, "\n  ");
  return `import type { StarterPack } from "./types";

/**
 * ${opts.label} — GENERATED from a tenant configuration export${
   doc.source?.tenantSlug ? ` (${doc.source.tenantSlug})` : ""
 } on ${doc.exportedAt.slice(0, 10)}.
 *
 * REVIEW BEFORE REGISTERING: replace client names and client-specific values
 * with generic placeholders, set the recommended modules, write the
 * description, then add the pack to STARTER_PACKS in ./index.ts.
 */
export const ${constName}: StarterPack = {
  key: ${JSON.stringify(opts.key)},
  version: 1,
  label: ${JSON.stringify(opts.label)},
  description: "TODO: describe who this pack is for.",
  modules: {},
  defaultRegion: "ap-south-1",
  config: ${body},
};
`;
}
