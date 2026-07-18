import { Badge, ScoreMeter } from "@/components/ui";

/**
 * AI score affordance. Two variants:
 *   - "card": compact score meter + up to 3 top-factor chips
 *   - "drawer": ring meter + every factor with its weight
 *
 * Reads aiScoreExplanation as `unknown` (the row column is jsonb and
 * the schema isn't locked in Wave 1). Defensive narrowing pulls
 * `top_factors[]` when present; otherwise renders just the score.
 *
 * Pure presentational — no data fetching. The score visual comes from the
 * shared ScoreMeter primitive so rows, cards, and the drawer read as one.
 */

interface FactorChip {
  label: string;
  weight?: number;
  description?: string;
}

interface EmphasisEntry {
  key?: string;
  label?: string;
  weight?: number;
}

interface AIScoreExplanation {
  top_factors?: FactorChip[];
  model?: string;
  notes?: string;
  /** CONF-03: present only when the tenant scored with a non-default weight
   * profile — the grading emphasis the model was instructed with. */
  scoring_emphasis?: EmphasisEntry[];
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
  const exp = narrowExplanation(explanation);
  const factors = Array.isArray(exp.top_factors)
    ? exp.top_factors.slice(0, variant === "card" ? 3 : 10)
    : [];

  if (variant === "card") {
    return (
      <div className="flex items-center gap-2">
        <ScoreMeter score={score} />
        {factors.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label="Top scoring factors">
            {factors.map((f, i) => (
              <li key={i} title={f.description}>
                <Badge tone="neutral">{f.label}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // drawer variant — fuller layout with the ring hero.
  return (
    <section
      aria-labelledby="ai-score-heading"
      className="rounded-lg border border-brand-100 bg-brand-50/40 p-4"
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 id="ai-score-heading" className="text-sm font-semibold text-neutral-900">
            AI screening
          </h3>
          {exp.model ? (
            <p className="text-xs text-neutral-500">
              Scored by <span className="font-mono">{exp.model}</span>
            </p>
          ) : null}
        </div>
        <ScoreMeter score={score} variant="ring" label="Score" />
      </header>
      {factors.length > 0 ? (
        <ul className="space-y-2">
          {factors.map((f, i) => (
            <li
              key={i}
              className="flex items-baseline justify-between gap-3 border-b border-brand-100/60 pb-2 last:border-b-0 last:pb-0"
            >
              <div>
                <p className="text-sm font-medium text-neutral-800">{f.label}</p>
                {f.description && <p className="text-xs text-neutral-600">{f.description}</p>}
              </div>
              {typeof f.weight === "number" && (
                <span className="font-mono text-xs tabular-nums text-neutral-500">
                  {f.weight.toFixed(2)}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-600">No factor breakdown available.</p>
      )}
      {Array.isArray(exp.scoring_emphasis) && exp.scoring_emphasis.length > 0 ? (
        <p className="mt-3 text-xs text-neutral-500">
          <span className="font-medium text-neutral-600">Grading emphasis:</span>{" "}
          {exp.scoring_emphasis
            .filter((e) => typeof e.weight === "number")
            .map((e) => `${e.label ?? e.key} ${e.weight}%`)
            .join(" · ")}
          . This is the emphasis the AI was instructed to apply — guidance, not a computed sum.
        </p>
      ) : null}
      {exp.notes && <p className="mt-3 text-xs text-neutral-500">{exp.notes}</p>}
    </section>
  );
}
