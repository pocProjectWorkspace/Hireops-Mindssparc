/**
 * Privacy policy (LEGAL-1) — replaces the CRS-01 stub. v1 pilot copy lives in
 * legal-copy.ts; the candidate apply-form consent link points here, so the
 * route must keep working for anonymous candidates as well as signed-in staff
 * (CandidateShell is purely presentational, so it does).
 */
import { LegalArticle } from "@/components/legal/LegalArticle";
import { PRIVACY_POLICY } from "@/lib/legal-copy";

export const metadata = { title: "Privacy Policy · HireOps" };

export default function PrivacyPage() {
  return <LegalArticle doc={PRIVACY_POLICY} />;
}
