/**
 * What the recruiter sees when their triage queue has nothing in it.
 * Honest: empty triage IS a normal state at the start of a tenant's
 * lifecycle. No "oh no" energy; just "nothing here yet."
 */
export function TriageEmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
      <p className="text-lg font-medium text-neutral-700">No candidates in triage</p>
      <p className="mt-1 text-sm text-neutral-500">
        New applications will appear here as candidates submit through the apply form.
      </p>
    </div>
  );
}
