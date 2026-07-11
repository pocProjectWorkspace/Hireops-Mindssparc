/**
 * Covers client-side navigations into /admin/workflows — the page itself
 * is a server component so a direct load arrives with data.
 */
export default function WorkflowsLoading() {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-neutral-900">Agent Workflows</h1>
      </header>
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-neutral-100" />
        ))}
      </div>
    </main>
  );
}
