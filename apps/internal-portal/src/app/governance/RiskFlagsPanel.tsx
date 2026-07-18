import type { GetGovernanceRiskFlagsOutput, RiskSeverity } from "@hireops/api-types";
import { Card, Badge } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";

/**
 * HRHEAD-03 — the active risk-flag panel (server component, read-only). The
 * same deterministic feed the Executive Audit page renders, shown here as the
 * governance "active risk flags" list. Each flag carries a severity, a
 * one-line consequence, and a deep-link into the offending surface.
 */

const SEVERITY_TONE: Record<RiskSeverity, BadgeTone> = {
  high: "error",
  medium: "warning",
  low: "info",
};

export function RiskFlagsPanel({ risk }: { risk: GetGovernanceRiskFlagsOutput }) {
  return (
    <section className="mt-10">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-neutral-900">Active risk flags</h2>
        {risk.counts.total > 0 ? (
          <Badge tone="error">{risk.counts.total}</Badge>
        ) : (
          <Badge tone="success">All clear</Badge>
        )}
      </div>
      <p className="mt-1 max-w-prose text-sm text-neutral-600">
        Rule-based checks over live data — budgets, approvals, must-have lists, offer bands and
        feedback SLAs. Deterministic, no AI. Each flag links to where it can be resolved.
      </p>

      <Card className="mt-4 p-0">
        {risk.flags.length === 0 ? (
          <p className="px-5 py-6 text-sm text-neutral-500">
            No risk flags fired against current data.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {risk.flags.map((f) => (
              <li key={f.id} className="flex items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
                    <p className="text-sm font-medium text-neutral-900">{f.title}</p>
                  </div>
                  <p className="mt-1 text-xs text-neutral-600">{f.detail}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">{f.consequence}</p>
                </div>
                {f.deepLink ? (
                  <a
                    href={f.deepLink}
                    className="shrink-0 self-center text-sm font-medium text-brand-600 hover:underline"
                  >
                    View
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {risk.skippedRules.length > 0 ? (
        <p className="mt-2 text-xs text-neutral-400">
          {risk.skippedRules.length} rule
          {risk.skippedRules.length === 1 ? "" : "s"} not evaluated:{" "}
          {risk.skippedRules.map((s) => s.reason).join("; ")}.
        </p>
      ) : null}
    </section>
  );
}
