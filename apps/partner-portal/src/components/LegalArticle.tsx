import { type LegalDoc } from "@/lib/legal-copy";

/** Shared article layout for /terms and /privacy (LEGAL-1). Wrapped in a
 * plain page column (this app has no candidate shell); PlatformFooter is
 * appended by the page. */
export function LegalArticle({ doc }: { doc: LegalDoc }) {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <article className="flex flex-col gap-5">
        <header className="flex flex-col gap-2 border-b border-neutral-200 pb-5">
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">{doc.title}</h1>
          <p className="text-sm text-neutral-600">{doc.intro}</p>
        </header>
        {doc.sections.map((s) => (
          <section key={s.heading} className="flex flex-col gap-2">
            {s.heading ? (
              <h2 className="text-lg font-semibold text-neutral-900">{s.heading}</h2>
            ) : null}
            {s.paras.map((p, i) => (
              <p key={i} className="text-sm leading-6 text-neutral-700">
                {p}
              </p>
            ))}
          </section>
        ))}
        <p className="border-t border-neutral-200 pt-4 text-xs text-neutral-400">
          {doc.versionLine}
        </p>
      </article>
    </main>
  );
}
