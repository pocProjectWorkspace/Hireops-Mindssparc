/**
 * PC-19 — business-unit roll-up.
 *
 * Pure: tree flattening (3-level Solenis-shaped org, cycle, orphan) and the
 * "group by BU level" mapping. SQL: the recursive descendant CTE (3 levels,
 * cycle-safe, tenant-scoped incl. a planted cross-tenant edge) against a
 * THROWAWAY LOCAL Postgres only — see local-pg-fixture.ts; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import {
  buGroupFor,
  buildBusinessUnitTree,
  indexBusinessUnitTree,
  type BusinessUnitRow,
} from "../src/lib/reports/bu-tree";
import { HAS_LOCAL_PG, loadLocalDb, prepareLocalSchema } from "./local-pg-fixture";

// Institutional → 4 sub-leaders → teams under two of them; plus a flat root.
const T = {
  inst: "00000000-0000-4000-8000-000000000001",
  subA: "00000000-0000-4000-8000-000000000002",
  subB: "00000000-0000-4000-8000-000000000003",
  subC: "00000000-0000-4000-8000-000000000004",
  subD: "00000000-0000-4000-8000-000000000005",
  teamA1: "00000000-0000-4000-8000-000000000006",
  teamA2: "00000000-0000-4000-8000-000000000007",
  teamB1: "00000000-0000-4000-8000-000000000008",
  water: "00000000-0000-4000-8000-000000000009",
};

const ROWS: BusinessUnitRow[] = [
  { id: T.inst, name: "Institutional", parentId: null, isArchived: false },
  { id: T.subA, name: "Accounts Payable", parentId: T.inst, isArchived: false },
  { id: T.subB, name: "Billing", parentId: T.inst, isArchived: false },
  { id: T.subC, name: "Controllership", parentId: T.inst, isArchived: false },
  { id: T.subD, name: "Data & Tax", parentId: T.inst, isArchived: true },
  { id: T.teamA1, name: "AP Vendors", parentId: T.subA, isArchived: false },
  { id: T.teamA2, name: "AP Audit", parentId: T.subA, isArchived: false },
  { id: T.teamB1, name: "Billing Ops", parentId: T.subB, isArchived: false },
  { id: T.water, name: "Water", parentId: null, isArchived: false },
];

describe("PC-19 buildBusinessUnitTree", () => {
  it("flattens depth-first, children A→Z, with depth + top-level ancestor", () => {
    const tree = buildBusinessUnitTree(ROWS);
    expect(tree.map((n) => [n.name, n.depth])).toEqual([
      ["Institutional", 0],
      ["Accounts Payable", 1],
      ["AP Audit", 2],
      ["AP Vendors", 2],
      ["Billing", 1],
      ["Billing Ops", 2],
      ["Controllership", 1],
      ["Data & Tax", 1],
      ["Water", 0],
    ]);
    const byId = indexBusinessUnitTree(tree);
    expect(byId.get(T.teamA1)?.topLevelId).toBe(T.inst);
    expect(byId.get(T.teamA1)?.parentId).toBe(T.subA);
    expect(byId.get(T.subD)?.isArchived).toBe(true);
    expect(byId.get(T.water)?.topLevelId).toBe(T.water);
  });

  it("survives a cycle (A → B → A) without looping and keeps every node", () => {
    const a = randomUUID();
    const b = randomUUID();
    const tree = buildBusinessUnitTree([
      { id: a, name: "Loop A", parentId: b, isArchived: false },
      { id: b, name: "Loop B", parentId: a, isArchived: false },
      { id: T.water, name: "Water", parentId: null, isArchived: false },
    ]);
    expect(tree.map((n) => n.name).sort()).toEqual(["Loop A", "Loop B", "Water"]);
    expect(new Set(tree.map((n) => n.id)).size).toBe(3);
  });

  it("treats a self-parent or a missing parent as a root", () => {
    const self = randomUUID();
    const orphan = randomUUID();
    const tree = buildBusinessUnitTree([
      { id: self, name: "Self", parentId: self, isArchived: false },
      { id: orphan, name: "Orphan", parentId: randomUUID(), isArchived: false },
    ]);
    expect(tree.every((n) => n.depth === 0 && n.parentId === null)).toBe(true);
  });
});

describe("PC-19 buGroupFor", () => {
  const idx = indexBusinessUnitTree(buildBusinessUnitTree(ROWS));

  it("top_level rolls every unit into its root", () => {
    expect(buGroupFor(idx, T.teamA1, "top_level")?.id).toBe(T.inst);
    expect(buGroupFor(idx, T.subC, "top_level")?.id).toBe(T.inst);
    expect(buGroupFor(idx, T.water, "top_level")?.id).toBe(T.water);
  });

  it("sub_unit (unfiltered) groups under the root's children; root-level rows stay on the root", () => {
    expect(buGroupFor(idx, T.teamA2, "sub_unit")?.id).toBe(T.subA);
    expect(buGroupFor(idx, T.teamB1, "sub_unit")?.id).toBe(T.subB);
    expect(buGroupFor(idx, T.subC, "sub_unit")?.id).toBe(T.subC);
    expect(buGroupFor(idx, T.inst, "sub_unit")?.id).toBe(T.inst);
  });

  it("sub_unit with a focus groups under the focus's children", () => {
    expect(buGroupFor(idx, T.teamA1, "sub_unit", T.subA)?.id).toBe(T.teamA1);
    expect(buGroupFor(idx, T.subA, "sub_unit", T.subA)?.id).toBe(T.subA);
  });

  it("returns null for an unknown unit", () => {
    expect(buGroupFor(idx, randomUUID(), "top_level")).toBeNull();
  });
});

describe.skipIf(!HAS_LOCAL_PG)("PC-19 resolveBusinessUnitDescendants (local Postgres)", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const loopA = randomUUID();
  const loopB = randomUUID();
  const foreignChild = randomUUID();
  const foreignUnit = randomUUID();
  let mod: Awaited<ReturnType<typeof loadLocalDb>>;
  let resolve: typeof import("../src/lib/reports/bu-tree").resolveBusinessUnitDescendants;
  let predicate: typeof import("../src/lib/reports/bu-tree").buSubtreePredicate;
  let loadTree: typeof import("../src/lib/reports/bu-tree").loadBusinessUnitTree;

  // Ids are per-run so re-runs never collide.
  const ids = Object.fromEntries(Object.keys(T).map((k) => [k, randomUUID()])) as Record<
    keyof typeof T,
    string
  >;
  const byFixedId = new Map(
    (Object.keys(T) as (keyof typeof T)[]).map((k) => [T[k] as string, ids[k]]),
  );
  const remap = (id: string): string => {
    const got = byFixedId.get(id);
    if (!got) throw new Error(`unknown fixture id ${id}`);
    return got;
  };

  beforeAll(async () => {
    mod = await loadLocalDb();
    await prepareLocalSchema(mod);
    ({
      resolveBusinessUnitDescendants: resolve,
      buSubtreePredicate: predicate,
      loadBusinessUnitTree: loadTree,
    } = await import("../src/lib/reports/bu-tree"));
    const { sql } = mod;
    await sql`INSERT INTO public.tenants (id) VALUES (${tenantA}), (${tenantB})`;
    for (const r of ROWS) {
      await sql`INSERT INTO public.business_units (id, tenant_id, name, parent_business_unit_id, is_archived)
        VALUES (${remap(r.id)}, ${tenantA}, ${r.name}, ${r.parentId ? remap(r.parentId) : null}, ${r.isArchived})`;
    }
    // A corrupt cycle in tenant A: loopA → loopB → loopA (each unit has one
    // parent, so a cycle is always its own island — walking INTO it from a
    // healthy root is impossible; starting inside it is the hazard).
    await sql`INSERT INTO public.business_units (id, tenant_id, name, parent_business_unit_id)
      VALUES (${loopA}, ${tenantA}, 'Loop A', NULL), (${loopB}, ${tenantA}, 'Loop B', ${loopA})`;
    await sql`UPDATE public.business_units SET parent_business_unit_id = ${loopB} WHERE id = ${loopA}`;
    // Cross-tenant: tenant B's unit claiming tenant A's Institutional as parent.
    await sql`INSERT INTO public.business_units (id, tenant_id, name, parent_business_unit_id)
      VALUES (${foreignChild}, ${tenantB}, 'Foreign child', ${ids.inst}),
             (${foreignUnit}, ${tenantB}, 'Foreign root', NULL)`;
  });

  afterAll(async () => {
    if (!mod) return;
    await mod.sql`DELETE FROM public.business_units WHERE tenant_id IN (${tenantA}, ${tenantB})`;
    await mod.sql`DELETE FROM public.tenants WHERE id IN (${tenantA}, ${tenantB})`;
    await mod.sql.end();
  });

  const asTenant = <T>(
    tid: string,
    fn: (db: Parameters<Parameters<typeof mod.withTenantContext>[1]>[0]["db"]) => Promise<T>,
  ) => mod.withTenantContext({ sub: randomUUID(), tid, roles: ["hr_head"] }, ({ db }) => fn(db));

  it("a 3-level root resolves to itself + every descendant (archived included)", async () => {
    const got = await asTenant(tenantA, (db) => resolve(db, tenantA, ids.inst));
    expect(got).toEqual(
      [ids.inst, ids.subA, ids.subB, ids.subC, ids.subD, ids.teamA1, ids.teamA2, ids.teamB1].sort(),
    );
  });

  it("a middle node resolves to itself + its children only", async () => {
    const got = await asTenant(tenantA, (db) => resolve(db, tenantA, ids.subB));
    expect(got).toEqual([ids.subB, ids.teamB1].sort());
  });

  it("a leaf resolves to exactly itself (flat tenants unchanged)", async () => {
    expect(await asTenant(tenantA, (db) => resolve(db, tenantA, ids.water))).toEqual([ids.water]);
  });

  it("is cycle-safe: a loop terminates and each node appears once", async () => {
    const got = await asTenant(tenantA, (db) => resolve(db, tenantA, loopA));
    expect(got).toEqual([loopA, loopB].sort());
  });

  it("never walks into another tenant's unit, even with a planted parent edge", async () => {
    const got = await asTenant(tenantA, (db) => resolve(db, tenantA, ids.inst));
    expect(got).not.toContain(foreignChild);
  });

  it("a foreign unit id resolves to nothing for the wrong tenant", async () => {
    expect(await asTenant(tenantA, (db) => resolve(db, tenantA, foreignUnit))).toEqual([]);
    // …even when the caller's RLS context is the foreign tenant, the explicit
    // tenant predicate still binds to the tenant asked about.
    expect(await asTenant(tenantB, (db) => resolve(db, tenantA, foreignUnit))).toEqual([]);
  });

  it("buSubtreePredicate filters a WHERE list by the subtree", async () => {
    const rows = await asTenant(tenantA, async (db) => {
      const res = await db.execute(
        mod.drizzleSql`SELECT b.id::text AS id FROM public.business_units b
          WHERE ${predicate(mod.drizzleSql`b.id`, tenantA, ids.subA)}`,
      );
      return ((res as { rows?: { id: string }[] }).rows ?? (res as unknown as { id: string }[]))
        .map((r) => r.id)
        .sort();
    });
    expect(rows).toEqual([ids.subA, ids.teamA1, ids.teamA2].sort());
  });

  it("loadBusinessUnitTree returns only the caller tenant's units, cycle members surfaced", async () => {
    const tree = await asTenant(tenantA, (db) => loadTree(db, tenantA));
    expect(tree).toHaveLength(ROWS.length + 2);
    expect(tree.find((n) => n.id === foreignChild)).toBeUndefined();
    expect(tree.find((n) => n.id === ids.teamA1)?.depth).toBe(2);
  });
});
