/**
 * Worker env loader — same dotenv-first pattern as the seed scripts so
 * `pnpm start` from `apps/workers` picks up the repo-root .env without
 * the operator having to set DATABASE_URL by hand.
 *
 * IMPORTANT: this file MUST be imported at the very top of src/index.ts
 * — before any module that touches process.env at import time (notably
 * @hireops/db's client.ts, which evaluates DATABASE_URL on import).
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });
