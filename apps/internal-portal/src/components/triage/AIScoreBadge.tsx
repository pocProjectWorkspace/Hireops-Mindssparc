/**
 * AI score affordance. Two variants:
 *   - "card": small badge (Score: NN) + up to 3 chips for top factors
 *   - "drawer": full breakdown — score, model, every factor with weight
 *
 * Reads aiScoreExplanation as `unknown` (the row column is jsonb and
 * the schema isn't locked in Wave 1). Defensive narrowing pulls
 * `top_factors[]` when present; otherwise renders just the score.
 *
 * Pure presentational — no data fetching.
 */

interface FactorChip {
  label: string;
  weight?: number;
  description?: string;
}

interface AIScoreExplanation {
  top_factors?: FactorChip[];
  model?: string;
  notes?: string;
}

function narrowExplanation(value: unknown): AIScoreExplanation {
  if (!value || typeof value !== "object") return {};
  return value as AIScoreExplanation;
}

export function AIScoreBadge({
  score,
  explanation,
  variant = "card",
}: {
  score: number | null;
  explanation: unknown;
  variant?: "card" | "drawer";
}) {
  if (score === null) {
    return (
      <span className="rounded-md bg-neutral-100 px-2 py-1 font-mono text-xs text-neutral-500">
        no score
      </span>
    );
  }

  const exp = narrowExplanation(explanation);
  const factors = Array.isArray(exp.top_factors)
    ? exp.top_factors.slice(0, variant === "card" ? 3 : 10)
    : [];
  const formatted = score.toFixed(0);

  if (variant === "card") {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-brand-50 px-2 py-1 font-mono text-xs font-semibold text-brand-700">
          {formatted}
        </span>
        {factors.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label="Top scoring factors">
            {factors.map((f, i) => (
              <li
                key={i}
                title={f.description}
                className="rounded-md bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-700"
              >
                {f.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // drawer variant — fuller layout
  return (
    <section
      aria-labelledby="ai-score-heading"
      className="rounded-lg border border-neutral-200 bg-white p-4"
    >
      <header className="mb-3 flex items-baseline justify-between">
        <h3 id="ai-score-heading" className="text-base font-semibold text-neutral-900">
          AI score
        </h3>
        <span className="font-mono text-2xl font-semibold text-brand-700">{formatted}</span>
      </header>
      {exp.model && (
        <p className="mb-3 text-xs text-neutral-500">
          Model: <span className="font-mono">{exp.model}</span>
        </p>
      )}
      {factors.length > 0 ? (
        <ul className="space-y-2">
          {factors.map((f, i) => (
            <li
              key={i}
              className="flex items-baseline justify-between gap-3 border-b border-neutral-100 pb-2 last:border-b-0"
            >
              <div>
                <p className="text-sm font-medium text-neutral-800">{f.label}</p>
                {f.description && <p className="text-xs text-neutral-600">{f.description}</p>}
              </div>
              {typeof f.weight === "number" && (
                <span className="font-mono text-xs text-neutral-500">{f.weight.toFixed(2)}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-600">No factor breakdown available.</p>
      )}
      {exp.notes && <p className="mt-3 text-xs text-neutral-500">{exp.notes}</p>}
    </section>
  );
}
