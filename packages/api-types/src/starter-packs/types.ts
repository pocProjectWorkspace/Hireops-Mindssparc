import type { PlatformModuleKey } from "../platform";
import type { TenantConfigSections } from "../tenant-config";

/**
 * C1-F11 — a tenant STARTER PACK (Plan A §14.2 layer 2, §14.3 step 2).
 *
 * Platform-owned, versioned, defined in code (not DB rows), so a pack is
 * reviewed and released like any other platform change. Provisioning applies
 * `config` ADDITIVELY through the same applier as config import: it only adds
 * what is missing, so a re-run (or a retry after a failure) never duplicates a
 * row and never overwrites a value a tenant admin has since changed.
 *
 * Packs are generic: no client names. A client's own setup becomes a pack by
 * exporting its configuration and running the export → pack script
 * (`pnpm db:pack:from-export`), then reviewing and generalising the result.
 */
export interface StarterPack {
  /** Stable key, recorded on the tenant as settings.starterPack.key. */
  key: string;
  /** Bump on ANY content change; recorded as settings.starterPack.version. */
  version: number;
  label: string;
  description: string;
  /**
   * Recommended module entitlements. A module not listed takes the platform
   * default (enabled). The operator can override per module at creation.
   */
  modules: Partial<Record<PlatformModuleKey, boolean>>;
  /** Region note shown on the create form (tenants.primary_region). */
  defaultRegion: string;
  /** The configuration the pack lays down (sections absent = platform defaults). */
  config: TenantConfigSections;
}
