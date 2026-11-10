/**
 * Reporting semantic layer — BUSINESS-UNIT ROLL-UP (PC-19).
 *
 * `business_units.parent_business_unit_id` makes the org a tree (Solenis
 * India: Institutional → four sub-leaders → …). Until PC-19 every report BU
 * filter was EQUALITY on the position's business unit, so picking a parent
 * unit silently returned only the requisitions raised directly on it — none
 * of its children's. This module is the ONE place that turns "business unit
 * B" into "B and everything under it", and every report BU filter plus the
 * Ask-your-data BU parameter goes through it.
 *
 * Two shapes, same semantics:
 *   - `buSubtreePredicate(column, tenantId, buId)` — a SQL boolean for a
 *     WHERE list (`p.business_unit_id IN (<recursive CTE>)`). Used inside
 *     the report queries so the roll-up never costs an extra round trip.
 *   - `resolveBusinessUnitDescendants(db, tenantId, buId)` — the same CTE,
 *     executed, returning the id list (tests, and any caller that needs ids).
 *
 * Guarantees:
 *   - TENANT-SCOPED: both the anchor and the recursive step carry an
 *     explicit `tenant_id = …` predicate on top of RLS, so a parent id from
 *     another tenant resolves to nothing and a cross-tenant child can never
 *     be walked into (the compound self-FK already forbids that edge, the
 *     predicate makes the read not depend on it).
 *   - CYCLE-SAFE: the hierarchy has no DB-level acyclicity check, so the
 *     recursion carries the visited path and refuses to revisit a node. A
 *     corrupt A → B → A loop terminates and returns {A, B}.
 *   - ARCHIVED units are still included: an archived unit is retired from
 *     the creation picker, but positions already attached to it stay valid
 *     and must keep counting under their parent.
 *   - A leaf unit resolves to exactly itself, so for flat tenants the
 *     roll-up is byte-identical to the old equality filter.
 */

import { sql as dsql, type SQL } from "drizzle-orm";
import type { TenantBoundDb } from "@hireops/db";
import type { BusinessUnitTreeNode, ReportBuGroupBy } from "@hireops/api-types";

function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

/** Depth guard on top of the path check — a sane org is a handful deep. */
const MAX_BU_DEPTH = 32;

/** `(SELECT id FROM <recursive subtree of buId>)` — a uuid-set subquery. */
export function buSubtreeIdsSql(tenantId: string, businessUnitId: string): SQL {
  return dsql`(
    WITH RECURSIVE bu_subtree(id, path, depth) AS (
      SELECT b.id, ARRAY[b.id], 0
      FROM public.business_units b
      WHERE b.tenant_id = ${tenantId}::uuid AND b.id = ${businessUnitId}::uuid
      UNION ALL
      SELECT c.id, s.path || c.id, s.depth + 1
      FROM public.business_units c
      JOIN bu_subtree s ON c.parent_business_unit_id = s.id
      WHERE c.tenant_id = ${tenantId}::uuid
        AND NOT (c.id = ANY(s.path))
        AND s.depth < ${MAX_BU_DEPTH}
    )
    SELECT DISTINCT id FROM bu_subtree
  )`;
}

/** `<column> IN (<subtree of buId>)` — the roll-up predicate every report uses. */
export function buSubtreePredicate(column: SQL, tenantId: string, businessUnitId: string): SQL {
  return dsql`${column} IN ${buSubtreeIdsSql(tenantId, businessUnitId)}`;
}

/** The executed form: `buId` plus every descendant, tenant-scoped. */
export async function resolveBusinessUnitDescendants(
  db: TenantBoundDb,
  tenantId: string,
  businessUnitId: string,
): Promise<string[]> {
  const res = await db.execute(dsql`
    SELECT t.id::text AS id FROM ${buSubtreeIdsSql(tenantId, businessUnitId)} AS t(id)
  `);
  return asRows<{ id: string }>(res)
    .map((r) => r.id)
    .sort();
}

// ─────────────────────────────── the tree (pickers + grouping) ───────────────────────────────

export interface BusinessUnitRow {
  id: string;
  name: string;
  parentId: string | null;
  isArchived: boolean;
}

/**
 * Flatten the tenant's units into DEPTH-FIRST picker order (children A→Z under
 * their parent), each with its depth and its top-level ancestor. Pure, so the
 * tree logic is unit-testable without a database.
 *
 * Cycle / orphan handling: a node whose parent is missing (or in another
 * tenant, or archived away) is treated as a root. Nodes caught in a cycle are
 * unreachable from any root; they are appended as roots so they still appear
 * in the picker rather than vanishing, and the walk never revisits a node.
 */
export function buildBusinessUnitTree(rows: readonly BusinessUnitRow[]): BusinessUnitTreeNode[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string | null, BusinessUnitRow[]>();
  for (const r of rows) {
    const parent = r.parentId && byId.has(r.parentId) && r.parentId !== r.id ? r.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(r);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const out: BusinessUnitTreeNode[] = [];
  const seen = new Set<string>();
  const walk = (
    node: BusinessUnitRow,
    depth: number,
    topLevelId: string,
    parentId: string | null,
  ) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    out.push({
      id: node.id,
      name: node.name,
      parentId,
      depth,
      topLevelId,
      isArchived: node.isArchived,
    });
    for (const c of children.get(node.id) ?? []) walk(c, depth + 1, topLevelId, node.id);
  };
  for (const root of children.get(null) ?? []) walk(root, 0, root.id, null);
  // Anything left is inside a cycle — surface it as a root, never loop.
  for (const r of [...rows].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!seen.has(r.id)) walk(r, 0, r.id, null);
  }
  return out;
}

/** Load + flatten the tenant's BU tree (archived units included, flagged). */
export async function loadBusinessUnitTree(
  db: TenantBoundDb,
  tenantId: string,
): Promise<BusinessUnitTreeNode[]> {
  const res = await db.execute(dsql`
    SELECT b.id::text AS id, b.name AS name,
           b.parent_business_unit_id::text AS parent_id, b.is_archived AS is_archived
    FROM public.business_units b
    WHERE b.tenant_id = ${tenantId}::uuid
  `);
  return buildBusinessUnitTree(
    asRows<{ id: string; name: string; parent_id: string | null; is_archived: boolean }>(res).map(
      (r) => ({ id: r.id, name: r.name, parentId: r.parent_id, isArchived: r.is_archived }),
    ),
  );
}

/** id → node lookup over a flattened tree; build once per report, not per row. */
export type BusinessUnitTreeIndex = ReadonlyMap<string, BusinessUnitTreeNode>;

export function indexBusinessUnitTree(
  tree: readonly BusinessUnitTreeNode[],
): BusinessUnitTreeIndex {
  return new Map(tree.map((n) => [n.id, n]));
}

/**
 * Which group a unit rolls into for a "group by BU level" breakdown.
 *   - top_level: its root ancestor.
 *   - sub_unit:  the child of the FOCUS unit that contains it (the focus is
 *     the filtered BU, or — unfiltered — the unit's own root). Rows raised
 *     directly on the focus unit group under the focus itself.
 * Returns null for an id not in the tree (should not happen; caller skips).
 */
export function buGroupFor(
  index: BusinessUnitTreeIndex,
  businessUnitId: string,
  groupBy: ReportBuGroupBy,
  focusBusinessUnitId?: string,
): BusinessUnitTreeNode | null {
  const node = index.get(businessUnitId);
  if (!node) return null;
  if (groupBy === "top_level") return index.get(node.topLevelId) ?? node;

  const focusId = focusBusinessUnitId ?? node.topLevelId;
  // Walk up until the parent is the focus (or we hit the focus / a root).
  let cur: BusinessUnitTreeNode = node;
  const guard = new Set<string>();
  while (cur.id !== focusId && cur.parentId && cur.parentId !== focusId) {
    if (guard.has(cur.id)) break;
    guard.add(cur.id);
    const up = index.get(cur.parentId);
    if (!up) break;
    cur = up;
  }
  return cur;
}
