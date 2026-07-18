import { Badge, ScoreMeter } from "@/components/ui";

/**
 * AI score affordance. Two variants:
 *   - "card": compact score meter + up to 3 top-factor chips
 *   - "drawer": ring meter hero + every factor with its 0–1 sub-score
 *
 * Reads `ai_score_explanation` as `unknown` (the column is jsonb). The real
 * shape written by the scorer (apps/workers ai-score-drain + the demo seed) is
 * `{ scored_by, model, scored_at, top_factors: [{ factor, score, note }],
 * caveats, scoring_emphasis? }`; the skipped path writes `{ scored_by:
 * 'skipped', reason }`. Defensive narrowing tolerates missing fields.
 *
 * Honesty (CONF-01): when scored_by === 'skipped' the drawer says "Scoring
 * disabled" rather than pretending the candidate is merely unscored.
 *
 * Pure presentational — no data fetching. The score visual comes from the
 * shared ScoreMeter primitive so rows, cards, and the drawer read as one.
 */

interface RawFactor {
  factor?: string;
  score?: number;
  note?: string;
}

interface EmphasisEntry {
  key?: string;
  label?: string;
  weight?: number;
}

interface AIScoreExplanation {
  scored_by?: string;
  model?: string;
  top_factors?: RawFactor[];
  caveats?: string[];
  reason?: string;
  /** CONF-03: present only when the tenant scored with a non-default weight
   * profile — the grading emphasis the model was instructed with. */
  scoring_emphasis?: EmphasisEntry[];
}

function narrowExplanation(value: unknown): AIScoreExplanation {
  if (!value || typeof value !== "object") return {};
  return value as AIScoreExplanation;
}

/** "skills_match" → "Skills match". Falls back to a title-cased slug. */
function humaniseFactor(factor: string): string {
  const words = factor.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
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
  const scoredBy = typeof exp.scored_by === "string" ? exp.scored_by : null;
  const skipped = scoredBy === "skipped";
  const rawFactors = Array.isArray(exp.top_factors) ? exp.top_factors : [];
  const factors = rawFactors
    .filter((f): f is RawFactor => !!f && typeof f === "object")
    .slice(0, variant === "card" ? 3 : 10);

  if (variant === "card") {
    return (
      <div className="flex items-center gap-2">
        <ScoreMeter score={score} />
        {factors.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label="Top scoring factors">
            {factors.map((f, i) => (
              <li key={i} title={f.note}>
                <Badge tone="neutral">{humaniseFactor(f.factor ?? "factor")}</Badge>
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
          {skipped ? (
            <p className="text-xs text-neutral-500">Scoring disabled</p>
          ) : exp.model ? (
            <p className="text-xs text-neutral-500">
              Scored by <span className="font-mono">{exp.model}</span>
            </p>
          ) : scoredBy ? (
            <p className="text-xs text-neutral-500">
              Scored by <span className="font-mono">{scoredBy}</span>
            </p>
          ) : null}
        </div>
        <ScoreMeter score={skipped ? null : score} variant="ring" label="Score" />
      </header>
      {skipped ? (
        <p className="text-sm text-neutral-600">
          AI scoring is turned off for this tenant, so this application was left unscored. Assess it
          on its merits below.
        </p>
      ) : factors.length > 0 ? (
        <ul className="space-y-2">
          {factors.map((f, i) => (
            <li
              key={i}
              className="flex items-baseline justify-between gap-3 border-b border-brand-100/60 pb-2 last:border-b-0 last:pb-0"
            >
              <div>
                <p className="text-sm font-medium text-neutral-800">
                  {humaniseFactor(f.factor ?? "factor")}
                </p>
                {f.note && <p className="text-xs text-neutral-600">{f.note}</p>}
              </div>
              {typeof f.score === "number" && (
                <span className="font-mono text-xs tabular-nums text-neutral-500">
                  {f.score.toFixed(2)}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-600">No factor breakdown available.</p>
      )}
      {!skipped && Array.isArray(exp.scoring_emphasis) && exp.scoring_emphasis.length > 0 ? (
        <p className="mt-3 text-xs text-neutral-500">
          <span className="font-medium text-neutral-600">Grading emphasis:</span>{" "}
          {exp.scoring_emphasis
            .filter((e) => typeof e.weight === "number")
            .map((e) => `${e.label ?? e.key} ${e.weight}%`)
            .join(" · ")}
          . This is the emphasis the AI was instructed to apply — guidance, not a computed sum.
        </p>
      ) : null}
    </section>
  );
}
