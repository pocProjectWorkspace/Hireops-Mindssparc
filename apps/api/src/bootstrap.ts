// Side-effect module: must be imported first by every entry point that
// depends on workspace-root .env values (apps/api server, integration tests,
// any standalone scripts in this package).
//
// ESM evaluates imports in declaration order, so `import "./bootstrap";`
// at the top of an entry file runs dotenv before any sibling imports.

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env") });
