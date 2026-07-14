/**
 * Stub privacy policy page for CRS-01.
 *
 * The real legal copy is a separate ticket — tracked at the moment as
 * the legal-review follow-up coupled to open-questions.md (the offers
 * disclaimer + retention sweep also lean on it). Until that lands, the
 * apply-form consent link points here so the page exists; replace this
 * file's body when the legal copy is approved.
 */

import { CandidateShell } from "@/components/candidate/CandidateShell";

export const metadata = {
  title: "Privacy policy — HireOps",
};

export default function PrivacyStubPage() {
  return (
    <CandidateShell width="2xl">
      <article className="flex flex-col gap-5">
        <header className="flex flex-col gap-2 border-b border-neutral-200 pb-5">
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">Privacy policy</h1>
          <p className="text-sm text-neutral-500">
            Placeholder copy. The production privacy policy for this tenant is pending legal review
            and will replace this page before any candidate-facing launch.
          </p>
        </header>

        <section className="flex max-w-prose flex-col gap-4 text-base leading-relaxed text-neutral-700">
          <p>
            We collect the data you submit through the apply form (name, contact, resume, and any
            links you share) for the purpose of considering you for the role you applied to. We
            retain this data for the duration permitted under the Digital Personal Data Protection
            Act, 2023, after which it is redacted unless you grant separate consent for inclusion in
            our talent pool.
          </p>
          <p>
            You can request access, correction, or deletion of your data by writing to the
            recruiting team contact listed in any email you receive from us.
          </p>
        </section>
      </article>
    </CandidateShell>
  );
}
