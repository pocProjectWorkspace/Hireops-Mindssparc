import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { BiasShieldClient } from "./BiasShieldClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live tenant config.

/**
 * Admin Bias Shield (AD11) — the refusal centerpiece.
 *
 * The prototype ships ~25 demographic / protected-class "bias" rules (gender
 * balance %, ethnicity/age correlation, salary equity by gender, panel
 * diversity, "interview times correlate with demographics"). We REFUSE all of
 * them: HireOps does not collect or infer protected attributes and deliberately
 * builds no demographic scoring or monitoring. That is a designed compliance
 * posture (the EU AI Act selling point for France/Germany GCC targets), stated
 * confidently here — not an empty page.
 *
 * What this screen presents instead is HireOps' REAL, honest bias controls: the
 * deterministic JD bias lexicon (warn/block terms by category + enforcement
 * mode) and the text-based blind-screening posture. The lexicon is READ here
 * via getBiasLexicon (shared read); it is EDITED on Admin → AI settings, which
 * this page links to. Nothing is duplicated or rewritten.
 */
export default async function BiasShieldPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const lexicon = await caller.getBiasLexicon({});

  return (
    <AppShell title="Bias Shield" isAdmin active="bias-shield" user={sessionUserChip(session)}>
      <BiasShieldClient lexicon={lexicon} />
    </AppShell>
  );
}
