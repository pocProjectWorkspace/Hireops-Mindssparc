import { BLANK_STARTER_PACK } from "./blank";
import { INDIA_GCC_FINANCE_GBS_STARTER_PACK } from "./india-gcc-finance-gbs";
import type { StarterPack } from "./types";

export type { StarterPack } from "./types";
export { BLANK_STARTER_PACK } from "./blank";
export { INDIA_GCC_FINANCE_GBS_STARTER_PACK } from "./india-gcc-finance-gbs";

/** The platform's starter-pack registry. Add a pack here to offer it on the create form. */
export const STARTER_PACKS: readonly StarterPack[] = [
  BLANK_STARTER_PACK,
  INDIA_GCC_FINANCE_GBS_STARTER_PACK,
];

export const STARTER_PACK_KEYS = STARTER_PACKS.map((p) => p.key);

export function getStarterPack(key: string): StarterPack | undefined {
  return STARTER_PACKS.find((p) => p.key === key);
}
export { starterPackSourceFromExport } from "./from-export";
