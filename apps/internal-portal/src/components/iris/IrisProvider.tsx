"use client";

import { createContext, useContext, useMemo, useState } from "react";
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
 *
 * It also owns the drawer open-state (ONBOARD-1) so surfaces other than the
 * launcher — e.g. the onboarding journey's sign-off step — can open Iris.
 */

const IrisContext = createContext<IrisPageContext>({ route: "/" });

interface IrisControls {
  isOpen: boolean;
  openIris: () => void;
  closeIris: () => void;
}

const IrisControlsContext = createContext<IrisControls>({
  isOpen: false,
  openIris: () => undefined,
  closeIris: () => undefined,
});

export function IrisProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const value = useMemo(() => deriveIrisContext(pathname ?? "/"), [pathname]);

  const [isOpen, setIsOpen] = useState(false);
  const controls = useMemo<IrisControls>(
    () => ({
      isOpen,
      openIris: () => setIsOpen(true),
      closeIris: () => setIsOpen(false),
    }),
    [isOpen],
  );

  return (
    <IrisContext.Provider value={value}>
      <IrisControlsContext.Provider value={controls}>{children}</IrisControlsContext.Provider>
    </IrisContext.Provider>
  );
}

/** Read the current Iris page context. Safe outside a provider (root default). */
export function useIrisContext(): IrisPageContext {
  return useContext(IrisContext);
}

/** Read/drive the Iris drawer open-state. Safe outside a provider (no-op default). */
export function useIrisControls(): IrisControls {
  return useContext(IrisControlsContext);
}
