"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PlatformModuleKey } from "@hireops/api-types";
import { isNavModuleVisible } from "@/lib/nav-modules";

/**
 * C1-F10 (D4) — the signed-in tenant's module entitlements, resolved once per
 * request in app/layout.tsx (lib/tenant-ui-settings.ts → loadTenantModules)
 * and read by the nav to hide modules the tenant does not have. `null` (signed
 * out, or a failed read) means every module is shown — the pre-F10 behaviour.
 * Display only: the API enforces entitlements on every module procedure.
 */
const TenantModulesContext = createContext<Record<PlatformModuleKey, boolean> | null>(null);

export function TenantModulesProvider({
  modules,
  children,
}: {
  modules: Record<PlatformModuleKey, boolean> | null;
  children: ReactNode;
}) {
  return <TenantModulesContext.Provider value={modules}>{children}</TenantModulesContext.Provider>;
}

/** Predicate: is the module enabled for this tenant? (No module → always true.) */
export function useModuleFilter(): (module: PlatformModuleKey | undefined) => boolean {
  const modules = useContext(TenantModulesContext);
  return (module) => isNavModuleVisible(modules, module);
}
