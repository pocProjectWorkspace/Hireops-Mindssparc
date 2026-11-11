/**
 * "Ask your data" — the QUESTION LOG (PC-21).
 *
 * Every ANSWERED question is appended to `ask_data_questions` (migration
 * 0131, FORCE RLS, append-only) with who asked, their Ask-your-data roles at
 * the time, the typed text (NULL for a chip click) and the resolved intent +
 * effective params. Three reads sit on top:
 *
 *   - `loadRecentQuestions` — "Your recent": the caller's OWN last questions,
 *     de-duplicated on (intent, params) so re-asking the same thing does not
 *     fill the strip. Each item re-runs as a chip (intent + params), so a
 *     click never calls the AI.
 *   - `loadPopularIntents` — "Popular in your team": the most-asked INTENTS
 *     over the last 30 days among askers who share an Ask-your-data role with
 *     the caller (ROLE-AWARE), limited to intents the caller can actually run.
 *     Intents only — a peer's typed wording is never shown to another peer.
 *   - `loadTopQuestions` — admin only (gated in the router): the tenant's
 *     top intents and top typed questions (case / whitespace normalised).
 *
 * Every statement carries an explicit `tenant_id = …` predicate on top of RLS.
 */

import { sql as dsql } from "drizzle-orm";
import type { TenantBoundDb } from "@hireops/db";
import {
  ASK_DATA_INTENT_IDS,
  ASK_DATA_POPULAR_WINDOW_DAYS,
  askDataCatalogEntry,
  askDataParamsSchema,
  type AskDataIntentId,
  type AskDataParams,
  type AskDataPopularItem,
  type AskDataRecentItem,
  type AskDataTopQuestionsOutput,
} from "@hireops/api-types";

function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

/** `{"a","b"}` — a Postgres text[] literal. Role keys are fixed identifiers; quotes/backslashes stripped anyway. */
export function textArrayLiteral(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/["\\]/g, "")}"`).join(",")}}`;
}

const INTENT_SET: ReadonlySet<string> = new Set(ASK_DATA_INTENT_IDS);
const isIntent = (v: string): v is AskDataIntentId => INTENT_SET.has(v);

/** Matches the DB CHECK on `question`. */
export const ASK_DATA_QUESTION_MAX_CHARS = 500;
export const ASK_DATA_RECENT_LIMIT = 6;
export const ASK_DATA_POPULAR_LIMIT = 5;

/**
 * The digest question, answered: the report-digest worker (R1.5) renders only
 * the executive board pack. An Ask-your-data intent is not a digest kind, so
 * "Make this a weekly digest" is NOT offered — it would need a new digest kind
 * plus a renderer per intent, which is not the cheap path the brief allowed.
 */
export const ASK_DATA_DIGEST_SUPPORTED = false;
export const ASK_DATA_DIGEST_NOTE =
  "Weekly digests currently send the executive summary only. Individual questions can't be scheduled yet.";

export interface LogAskDataQuestionArgs {
  tenantId: string;
  membershipId: string;
  /** The asker's roles (only Ask-your-data roles are stored — see `askerRolesFor`). */
  roles: readonly string[];
  /** Typed text, or null for a chip click / chip edit. */
  question: string | null;
  intent: AskDataIntentId;
  params: AskDataParams;
  source: "chip" | "matched" | "ai";
}

/** The roles that matter for "Popular in your team": Ask-your-data roles only, sorted. */
export function askerRolesFor(
  roles: readonly string[],
  askDataRoles: ReadonlySet<string>,
): string[] {
  return [...new Set(roles.filter((r) => askDataRoles.has(r)))].sort();
}

/** Normalise typed text for storage + grouping: trimmed, single-spaced, capped. */
export function normaliseQuestionText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.slice(0, ASK_DATA_QUESTION_MAX_CHARS);
}

export async function logAskDataQuestion(
  db: TenantBoundDb,
  a: LogAskDataQuestionArgs,
): Promise<void> {
  await db.execute(dsql`
    INSERT INTO public.ask_data_questions
      (tenant_id, membership_id, asker_roles, question, intent, params, source)
    VALUES (
      ${a.tenantId}::uuid,
      ${a.membershipId}::uuid,
      ${textArrayLiteral(a.roles)}::text[],
      ${normaliseQuestionText(a.question)},
      ${a.intent},
      ${JSON.stringify(a.params)}::jsonb,
      ${a.source}
    )
  `);
}

/** Stable identity of a re-runnable question (intent + params, key-order independent). */
export function recentKey(intent: string, params: AskDataParams): string {
  const p = params as Record<string, unknown>;
  return `${intent}|${JSON.stringify(
    Object.keys(p)
      .sort()
      .filter((k) => p[k] !== undefined)
      .map((k) => [k, p[k]]),
  )}`;
}

interface RecentSqlRow {
  question: string | null;
  intent: string;
  params: unknown;
  created_at: string | Date;
}

/**
 * De-duplicate newest-first rows on (intent, params), keep the newest of each,
 * drop rows whose intent / params no longer parse (catalog shrank). Pure.
 */
export function dedupeRecent(rows: readonly RecentSqlRow[], limit: number): AskDataRecentItem[] {
  const out: AskDataRecentItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isIntent(r.intent)) continue;
    const parsed = askDataParamsSchema.safeParse(
      typeof r.params === "string" ? JSON.parse(r.params) : r.params,
    );
    if (!parsed.success) continue;
    const key = recentKey(r.intent, parsed.data);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: r.question ?? askDataCatalogEntry(r.intent).question,
      intent: r.intent,
      params: parsed.data,
      askedAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function loadRecentQuestions(
  db: TenantBoundDb,
  tenantId: string,
  membershipId: string,
  limit = ASK_DATA_RECENT_LIMIT,
): Promise<AskDataRecentItem[]> {
  // Over-fetch so de-duplication still fills the strip.
  const res = await db.execute(dsql`
    SELECT q.question, q.intent, q.params, q.created_at
    FROM public.ask_data_questions q
    WHERE q.tenant_id = ${tenantId}::uuid
      AND q.membership_id = ${membershipId}::uuid
    ORDER BY q.created_at DESC
    LIMIT ${limit * 8}
  `);
  return dedupeRecent(asRows<RecentSqlRow>(res), limit);
}

export interface PopularIntentRow {
  intent: string;
  count: number;
}

/**
 * Rank aggregated intent counts for the caller: drop intents the caller cannot
 * run, most-asked first, catalog order breaks ties. Pure.
 */
export function rankPopularIntents(
  rows: readonly PopularIntentRow[],
  canRun: (intent: AskDataIntentId) => boolean,
  limit = ASK_DATA_POPULAR_LIMIT,
): AskDataPopularItem[] {
  const order = new Map(ASK_DATA_INTENT_IDS.map((id, i) => [id as string, i]));
  return rows
    .filter((r): r is { intent: AskDataIntentId; count: number } => isIntent(r.intent))
    .filter((r) => r.count > 0 && canRun(r.intent))
    .sort((a, b) => b.count - a.count || (order.get(a.intent) ?? 0) - (order.get(b.intent) ?? 0))
    .slice(0, limit)
    .map((r) => ({
      intent: r.intent,
      label: askDataCatalogEntry(r.intent).question,
      count: r.count,
    }));
}

/**
 * "Popular in your team": intents asked in the window by askers who share at
 * least one Ask-your-data role with the caller. A caller with no such role
 * gets nothing (never the tenant-wide ranking).
 */
export async function loadPopularIntents(
  db: TenantBoundDb,
  tenantId: string,
  opts: {
    callerRoles: readonly string[];
    canRun: (intent: AskDataIntentId) => boolean;
    days?: number;
    limit?: number;
  },
): Promise<AskDataPopularItem[]> {
  if (opts.callerRoles.length === 0) return [];
  const days = opts.days ?? ASK_DATA_POPULAR_WINDOW_DAYS;
  const res = await db.execute(dsql`
    SELECT q.intent AS intent, COUNT(*)::int AS count
    FROM public.ask_data_questions q
    WHERE q.tenant_id = ${tenantId}::uuid
      AND q.created_at >= now() - make_interval(days => ${days}::int)
      AND q.asker_roles && ${textArrayLiteral(opts.callerRoles)}::text[]
    GROUP BY q.intent
  `);
  return rankPopularIntents(asRows<PopularIntentRow>(res), opts.canRun, opts.limit);
}

/** Admin view: top intents (+ distinct askers) and top typed questions in the window. */
export async function loadTopQuestions(
  db: TenantBoundDb,
  tenantId: string,
  days = ASK_DATA_POPULAR_WINDOW_DAYS,
  limit = 10,
): Promise<AskDataTopQuestionsOutput> {
  const intentRes = await db.execute(dsql`
    SELECT q.intent AS intent, COUNT(*)::int AS count,
           COUNT(DISTINCT q.membership_id)::int AS askers
    FROM public.ask_data_questions q
    WHERE q.tenant_id = ${tenantId}::uuid
      AND q.created_at >= now() - make_interval(days => ${days}::int)
    GROUP BY q.intent
    ORDER BY count DESC, q.intent ASC
  `);
  const questionRes = await db.execute(dsql`
    SELECT lower(q.question) AS question, q.intent AS intent, COUNT(*)::int AS count
    FROM public.ask_data_questions q
    WHERE q.tenant_id = ${tenantId}::uuid
      AND q.created_at >= now() - make_interval(days => ${days}::int)
      AND q.question IS NOT NULL
    GROUP BY lower(q.question), q.intent
    ORDER BY count DESC, lower(q.question) ASC
    LIMIT ${limit}
  `);
  const intents = asRows<{ intent: string; count: number; askers: number }>(intentRes)
    .filter((r): r is { intent: AskDataIntentId; count: number; askers: number } =>
      isIntent(r.intent),
    )
    .slice(0, limit)
    .map((r) => ({
      intent: r.intent,
      label: askDataCatalogEntry(r.intent).question,
      count: r.count,
      askers: r.askers,
    }));
  const questions = asRows<{ question: string; intent: string; count: number }>(questionRes)
    .filter((r): r is { question: string; intent: AskDataIntentId; count: number } =>
      isIntent(r.intent),
    )
    .map((r) => ({ question: r.question, intent: r.intent, count: r.count }));
  return {
    days,
    intents,
    questions,
    digestSupported: ASK_DATA_DIGEST_SUPPORTED,
    digestNote: ASK_DATA_DIGEST_NOTE,
  };
}
