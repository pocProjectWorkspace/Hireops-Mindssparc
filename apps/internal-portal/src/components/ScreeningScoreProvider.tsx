"use client";

import { createContext, useContext, type ReactNode } from "react";
import { SCREENING_SCORE_BANDS_DEFAULT, type ScreeningScoreBands } from "@hireops/api-types";

/**
 * Carries the tenant's `aiSettings.screeningScoreVisible` from the root layout
 * (resolved server-side, see lib/tenant-ui-settings.ts) to every component that
 * renders the AI screening score or a match tier. Defaults to visible, so a
 * tree rendered outside the provider (stories, tests) behaves as before.
 */
const ScreeningScoreContext = createContext<boolean>(true);

/** CFG-LITE / BUG-11 — the tenant's score cut-offs (aiSettings.screeningScoreBands).
 * Defaults to the platform bands outside the provider. */
const ScreeningScoreBandsContext = createContext<ScreeningScoreBands>(
  SCREENING_SCORE_BANDS_DEFAULT,
);

export function ScreeningScoreProvider({
  visible,
  bands,
  children,
}: {
  visible: boolean;
  bands?: ScreeningScoreBands;
  children: ReactNode;
}) {
  return (
    <ScreeningScoreContext.Provider value={visible}>
      <ScreeningScoreBandsContext.Provider value={bands ?? SCREENING_SCORE_BANDS_DEFAULT}>
        {children}
      </ScreeningScoreBandsContext.Provider>
    </ScreeningScoreContext.Provider>
  );
}

export function useScreeningScoreBands(): ScreeningScoreBands {
  return useContext(ScreeningScoreBandsContext);
}

export function useScreeningScoreVisible(): boolean {
  return useContext(ScreeningScoreContext);
}
