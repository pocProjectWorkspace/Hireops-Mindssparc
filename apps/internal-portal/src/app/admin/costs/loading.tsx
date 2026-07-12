/**
 * Covers client-side navigations into /admin/costs — the page itself is a
 * server component so a direct load arrives with data.
 */
export default function CostsLoading() {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-neutral-900">AI Cost</h1>
      </header>
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-md bg-neutral-100" />
        ))}
      </div>
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-neutral-100" />
        ))}
      </div>
    </main>
  );
}
