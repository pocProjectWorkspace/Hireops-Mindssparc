"use client";

import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { deriveIrisContext, type IrisPageContext } from "./context-map";

/**
 * IrisProvider (IRIS-A2) — the app-wide page-context provider for Iris. Derives
 * `{ route, entityType?, entityId? }` from the current pathname so the drawer
 * can pick a context-suggested default action. Client-only (usePathname); it
 * renders its children through unchanged (a context provider is not a DOM
 * wrapper), so it can wrap a server-rendered shell without forcing the shell
 * client-side.
 */

const IrisContext = createContext<IrisPageContext>({ route: "/" });

export function IrisProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const value = useMemo(() => deriveIrisContext(pathname ?? "/"), [pathname]);
  return <IrisContext.Provider value={value}>{children}</IrisContext.Provider>;
}

/** Read the current Iris page context. Safe outside a provider (root default). */
export function useIrisContext(): IrisPageContext {
  return useContext(IrisContext);
}
