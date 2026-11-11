import type { PlatformModuleKey } from "@hireops/api-types";

/**
 * C1-F10 (D4) — the nav's module rule, pure so it can be unit-tested. An item
 * with no module is always shown; `modules === null` (signed out / failed
 * read) shows everything; otherwise only an explicit `false` hides it.
 */
export function isNavModuleVisible(
  modules: Record<PlatformModuleKey, boolean> | null,
  module: PlatformModuleKey | undefined,
): boolean {
  return !module || !modules || modules[module] !== false;
}

export function filterNavByModules<T extends { module?: PlatformModuleKey }>(
  items: T[],
  modules: Record<PlatformModuleKey, boolean> | null,
): T[] {
  return items.filter((i) => isNavModuleVisible(modules, i.module));
}
