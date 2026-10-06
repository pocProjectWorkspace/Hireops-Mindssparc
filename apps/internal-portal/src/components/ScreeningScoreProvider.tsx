"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Carries the tenant's `aiSettings.screeningScoreVisible` from the root layout
 * (resolved server-side, see lib/tenant-ui-settings.ts) to every component that
 * renders the AI screening score or a match tier. Defaults to visible, so a
 * tree rendered outside the provider (stories, tests) behaves as before.
 */
const ScreeningScoreContext = createContext<boolean>(true);

export function ScreeningScoreProvider({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  return (
    <ScreeningScoreContext.Provider value={visible}>{children}</ScreeningScoreContext.Provider>
  );
}

export function useScreeningScoreVisible(): boolean {
  return useContext(ScreeningScoreContext);
}
