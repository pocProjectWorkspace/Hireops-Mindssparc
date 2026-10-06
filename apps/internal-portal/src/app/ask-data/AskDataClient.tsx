"use client";

import { useRef, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import {
  ASK_DATA_GROUPS,
  ASK_DATA_GROUP_LABELS,
  ASK_DATA_MONTHS_MAX,
  ASK_DATA_MONTHS_MIN,
  ASK_DATA_PERIODS,
  ASK_DATA_PERIOD_LABELS,
  type AskDataCatalogOutput,
  type AskDataColumn,
  type AskDataInput,
  type AskDataIntentId,
  type AskDataInterpretation,
  type AskDataOutput,
  type AskDataParams,
  type AskDataPeriod,
  type AskDataResult,
} from "@hireops/api-types";
import { Select } from "@hireops/ui";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Skeleton,
  SkeletonRows,
  StatTile,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";
import { buildCsv, downloadCsv } from "@/lib/csv";
import { trpc } from "@/lib/trpc-client";

/**
 * ASK-DATA — the /ask-data client.
 *
 * A question box, the 14 supported questions as chips, and a result card per
 * answer. Three things keep this honest and stage-safe:
 *   - every figure, the summary sentence and the footnote arrive from the API
 *     (deterministic report-layer code) — this file only lays them out;
 *   - "How I read your question" always shows the resolved intent + params, and
 *     editing a chip re-runs with `intent` + `params`, which never calls the AI;
 *   - unsupported / unavailable questions show the API's honest message and its
 *     suggested questions, never a guessed answer.
 * Session history is client state only (newest first); nothing is persisted.
 */

const AskDataChart = dynamic(() => import("./AskDataChart").then((m) => m.AskDataChart), {
  ssr: false,
  loading: () => <Skeleton className="h-[240px] w-full" />,
});

const ALL_BUS = "__all__";
const MONTH_OPTIONS = [3, 6, 12, 18, 24].filter(
  (n) => n >= ASK_DATA_MONTHS_MIN && n <= ASK_DATA_MONTHS_MAX,
);

interface Turn {
  id: number;
  /** What the user asked (or the chip's question). */
  asked: string;
  input: AskDataInput;
  output: AskDataOutput | null;
  error: string | null;
}

export function AskDataClient({ catalog }: { catalog: AskDataCatalogOutput }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const nextId = useRef(1);
  const askMutation = trpc.askData.useMutation();
  const pending = askMutation.isPending;

  const questionFor = (intent: AskDataIntentId) =>
    catalog.entries.find((e) => e.id === intent)?.question ?? intent;

  async function ask(input: AskDataInput, asked: string) {
    const id = nextId.current++;
    setTurns((t) => [{ id, asked, input, output: null, error: null }, ...t]);
    try {
      const output = await askMutation.mutateAsync(input);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, output } : x)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: message } : x)));
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || pending) return;
    setQuestion("");
    void ask({ question: q }, q);
  }

  const runIntent = (intent: AskDataIntentId, params?: AskDataParams) =>
    void ask({ intent, params }, questionFor(intent));

  const [current, ...earlier] = turns;

  return (
    <PageContainer variant="measure" className="py-8">
      <h1 className="text-xl font-semibold text-neutral-900">Ask your data</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Answers come from your live hiring data. The AI only interprets your question — every number
        is calculated by HireOps.
      </p>

      <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          placeholder="e.g. What is our average time to fill?"
          aria-label="Ask a question about your hiring data"
          className="h-12 flex-1 rounded-button border border-neutral-300 bg-white px-4 text-base text-neutral-900 shadow-1 placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
        <Button type="submit" disabled={pending || !question.trim()} className="h-12 px-6">
          {pending ? "Working…" : "Ask"}
        </Button>
      </form>
      {!catalog.aiEnabled ? (
        <p className="mt-2 text-xs text-neutral-500">
          Typed questions are switched off for your organisation; the suggested questions below
          always work.
        </p>
      ) : null}

      <div className="mt-6 space-y-3">
        {ASK_DATA_GROUPS.map((group) => {
          const entries = catalog.entries.filter((e) => e.group === group);
          if (entries.length === 0) return null;
          return (
            <div key={group}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                {ASK_DATA_GROUP_LABELS[group]}
              </p>
              <div className="flex flex-wrap gap-2">
                {entries.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    disabled={pending || !e.available}
                    title={e.available ? undefined : "Not available for your role"}
                    onClick={() => runIntent(e.id)}
                    className="rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-left text-sm text-neutral-700 shadow-1 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {e.question}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {current ? (
        <div className="mt-8">
          <TurnCard
            turn={current}
            catalog={catalog}
            pending={pending}
            onRun={runIntent}
            onFollowUp={(q, previous) => void ask({ question: q, previous }, q)}
            onRetry={() => void ask(current.input, current.asked)}
            questionFor={questionFor}
          />
        </div>
      ) : null}

      {earlier.length > 0 ? (
        <div className="mt-10">
          <h2 className="mb-3 text-sm font-semibold text-neutral-900">Earlier in this session</h2>
          <div className="space-y-3">
            {earlier.map((t) => (
              <HistoryRow
                key={t.id}
                turn={t}
                // Re-open by the RESOLVED intent + params when there is one, so
                // asking again never needs the AI.
                onReopen={() => {
                  const interp = t.output?.interpretation;
                  void ask(
                    interp ? { intent: interp.intent, params: interp.params } : t.input,
                    t.asked,
                  );
                }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </PageContainer>
  );
}

// ─────────────────────────────── one answer ───────────────────────────────

function TurnCard({
  turn,
  catalog,
  pending,
  onRun,
  onFollowUp,
  onRetry,
  questionFor,
}: {
  turn: Turn;
  catalog: AskDataCatalogOutput;
  pending: boolean;
  onRun: (intent: AskDataIntentId, params?: AskDataParams) => void;
  onFollowUp: (
    question: string,
    previous: { intent: AskDataIntentId; params: AskDataParams },
  ) => void;
  onRetry: () => void;
  questionFor: (intent: AskDataIntentId) => string;
}) {
  const [followUp, setFollowUp] = useState("");
  const out = turn.output;

  return (
    <Card>
      <p className="text-xs text-neutral-500">You asked</p>
      <p className="text-base font-medium text-neutral-900">{turn.asked}</p>

      {!out && !turn.error ? (
        <div className="mt-5 space-y-3" aria-busy="true">
          <Skeleton className="h-6 w-2/3" />
          <SkeletonRows count={4} />
        </div>
      ) : null}

      {turn.error ? (
        <div className="mt-5 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          <p>Couldn't get an answer: {turn.error}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={onRetry}
            disabled={pending}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {out ? (
        <>
          {out.interpretation ? (
            <Interpretation
              interp={out.interpretation}
              catalog={catalog}
              pending={pending}
              onRun={onRun}
            />
          ) : null}

          {out.status !== "answered" ? (
            <div className="mt-5">
              <p className="text-sm text-neutral-800">{out.message}</p>
              {out.suggestions.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {out.suggestions.map((s) => (
                    <button
                      key={s.intent}
                      type="button"
                      disabled={pending}
                      onClick={() => onRun(s.intent)}
                      className="rounded-full border border-brand-200 bg-brand-50 px-3 py-1.5 text-left text-sm text-brand-800 hover:bg-brand-100 disabled:opacity-50"
                    >
                      {s.question || questionFor(s.intent)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {out.status === "answered" && out.result ? <ResultView result={out.result} /> : null}

          {out.status === "answered" && out.interpretation ? (
            <form
              className="mt-6 flex gap-2 border-t border-neutral-100 pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                const q = followUp.trim();
                if (!q || pending || !out.interpretation) return;
                setFollowUp("");
                onFollowUp(q, {
                  intent: out.interpretation.intent,
                  params: out.interpretation.params,
                });
              }}
            >
              <input
                type="text"
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                maxLength={500}
                placeholder="Ask a follow-up… (e.g. now only Finance, same for last quarter)"
                aria-label="Ask a follow-up"
                className="h-10 flex-1 rounded-button border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
              <Button type="submit" variant="secondary" disabled={pending || !followUp.trim()}>
                Ask
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

// ─────────────────────────────── "How I read your question" ───────────────────────────────

function Interpretation({
  interp,
  catalog,
  pending,
  onRun,
}: {
  interp: AskDataInterpretation;
  catalog: AskDataCatalogOutput;
  pending: boolean;
  onRun: (intent: AskDataIntentId, params?: AskDataParams) => void;
}) {
  const entry = catalog.entries.find((e) => e.id === interp.intent);
  const honours = new Set(entry?.params ?? []);
  const params = interp.params;
  const rerun = (patch: Partial<AskDataParams>, clear?: "businessUnit" | "requisition") => {
    const next: AskDataParams = { ...params, ...patch };
    if (clear === "businessUnit") delete next.businessUnit;
    if (clear === "requisition") delete next.requisition;
    onRun(interp.intent, next);
  };

  return (
    <div className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50/60 p-3">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          How I read your question
        </p>
        <Badge tone={interp.source === "ai" ? "accent" : "neutral"}>
          {interp.source === "ai"
            ? "Interpreted by AI"
            : interp.source === "matched"
              ? "Matched a supported question"
              : "Selected"}
        </Badge>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Chip label="Question" value={interp.intentLabel} />
        {honours.has("period") ? (
          <div className="w-44">
            <Select
              size="sm"
              label="Period"
              disabled={pending}
              value={params.period ?? "all_time"}
              options={ASK_DATA_PERIODS.map((p) => ({
                value: p,
                label: ASK_DATA_PERIOD_LABELS[p],
              }))}
              onValueChange={(v) => rerun({ period: v as AskDataPeriod })}
            />
          </div>
        ) : null}
        {honours.has("businessUnit") ? (
          <div className="w-52">
            <Select
              size="sm"
              label="Business unit"
              disabled={pending}
              value={params.businessUnit ?? ALL_BUS}
              options={[
                { value: ALL_BUS, label: "All business units" },
                ...catalog.businessUnits.map((b) => ({ value: b, label: b })),
              ]}
              onValueChange={(v) =>
                v === ALL_BUS ? rerun({}, "businessUnit") : rerun({ businessUnit: v })
              }
            />
          </div>
        ) : null}
        {honours.has("months") ? (
          <div className="w-40">
            <Select
              size="sm"
              label="Window"
              disabled={pending}
              value={String(params.months ?? 6)}
              options={MONTH_OPTIONS.map((n) => ({ value: String(n), label: `Last ${n} months` }))}
              onValueChange={(v) => rerun({ months: Number(v) })}
            />
          </div>
        ) : null}
        {params.requisition ? (
          <Chip
            label="Requisition"
            value={params.requisition}
            onClear={pending ? undefined : () => rerun({}, "requisition")}
          />
        ) : null}
      </div>
      {interp.notes.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-xs text-status-warning-800">
          {interp.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Chip({ label, value, onClear }: { label: string; value: string; onClear?: () => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-3 text-sm text-brand-800">
        {value}
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            aria-label={`Remove ${label.toLowerCase()} filter`}
            className="text-brand-600 hover:text-brand-900"
          >
            ×
          </button>
        ) : null}
      </span>
    </div>
  );
}

// ─────────────────────────────── the visual ───────────────────────────────

function formatCell(
  value: string | number | null | undefined,
  format: AskDataColumn["format"],
): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") {
    if (format === "percent") return `${value.toLocaleString()}%`;
    if (format === "days") return `${value.toLocaleString()} d`;
    return value.toLocaleString();
  }
  return value;
}

function ResultView({ result }: { result: AskDataResult }) {
  const exportCsv = () => {
    const csv = buildCsv(
      result.columns.map((c) => c.label),
      result.rows.map((r) => result.columns.map((c) => (r[c.key] == null ? "" : String(r[c.key])))),
    );
    const slug = result.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    downloadCsv(`${slug || "answer"}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  };

  return (
    <div className="mt-5">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-base font-semibold text-neutral-900">{result.title}</h2>
        {!result.empty && result.rows.length > 0 ? (
          <Button variant="secondary" size="sm" onClick={exportCsv}>
            Export CSV
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-neutral-800">{result.summary}</p>

      <div className="mt-4">
        {result.empty ? (
          <EmptyState
            title="No data for this period"
            hint="Try a wider period or another business unit."
          />
        ) : result.kind === "kpi" ? (
          <KpiTiles result={result} />
        ) : result.kind === "table" ? (
          <ResultTable result={result} />
        ) : (
          <>
            <AskDataChart result={result} />
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-neutral-600">
                Show the numbers
              </summary>
              <div className="mt-2">
                <ResultTable result={result} />
              </div>
            </details>
          </>
        )}
      </div>

      <p className="mt-4 text-xs text-neutral-500">{result.footnote}</p>
    </div>
  );
}

function KpiTiles({ result }: { result: AskDataResult }) {
  const row = result.rows[0] ?? {};
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {result.columns.map((c, i) => (
        <StatTile
          key={c.key}
          label={c.label}
          tone={i === 0 ? "accent" : "neutral"}
          value={formatCell(row[c.key], c.format === "days" ? "number" : c.format)}
          hint={c.format === "days" && row[c.key] != null ? "days" : undefined}
        />
      ))}
    </div>
  );
}

function ResultTable({ result }: { result: AskDataResult }) {
  const numeric = (c: AskDataColumn) =>
    c.format === "number" || c.format === "percent" || c.format === "days";
  return (
    <TableShell>
      <Thead>
        {result.columns.map((c) => (
          <Th key={c.key} numeric={numeric(c)}>
            {c.label}
          </Th>
        ))}
      </Thead>
      <Tbody>
        {result.rows.map((r, i) => (
          <Tr key={i}>
            {result.columns.map((c) => (
              <Td key={c.key} numeric={numeric(c)} label={c.label}>
                {formatCell(r[c.key], c.format)}
              </Td>
            ))}
          </Tr>
        ))}
      </Tbody>
    </TableShell>
  );
}

// ─────────────────────────────── session history ───────────────────────────────

function HistoryRow({ turn, onReopen }: { turn: Turn; onReopen: () => void }) {
  const out = turn.output;
  const line =
    turn.error ??
    (out?.status === "answered" ? out.result?.summary : out?.message) ??
    "Waiting for an answer…";
  return (
    <Card padded={false} className="flex items-start justify-between gap-4 p-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-neutral-900">{turn.asked}</p>
        {out?.interpretation ? (
          <p className="mt-0.5 text-xs text-neutral-500">
            {out.interpretation.chips.map((c) => c.value).join(" · ")}
          </p>
        ) : null}
        <p className="mt-1 text-sm text-neutral-700">{line}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={onReopen}>
        Ask again
      </Button>
    </Card>
  );
}
