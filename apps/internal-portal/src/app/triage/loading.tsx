/**
 * Rarely shown — the page is a server component so initial render
 * arrives with data. This loading state covers client-side navigations
 * (link clicks from somewhere else) where Next streams the new RSC
 * payload.
 */
export default function TriageLoading() {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-neutral-900">Triage</h1>
      </header>
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-md bg-neutral-100" />
        ))}
      </div>
    </main>
  );
}
