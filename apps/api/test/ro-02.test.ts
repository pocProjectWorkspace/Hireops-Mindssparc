/**
 * RO-02 — requisition wizard v2 & skill weighting.
 *
 * Three groups:
 *   A. Skill-metadata round-trip: updateRequisitionDraft persists the new
 *      per-skill fields (category / min_years / notes, migration 0080), and
 *      getRequisitionDetail + the raw jd_skills row read them back.
 *   B. Submit gating: the REAL submit path (submitRequisitionForApproval)
 *      refuses an incomplete requisition with BAD_REQUEST — verified for the
 *      "no skills" and "no JD" cases (what the server actually enforces; the
 *      client checklist is a stricter UX guard on top).
 *   C. JD-quality pure helpers (computeJdCompleteness / computeJdReadability /
 *      computeJdBiasScore) — no DB, deterministic unit cases.
 *
 * NODE_ENV=test. JD is set via updateRequisitionDraft(sections) so no AI call /
 * fixture is needed. Requires `pnpm db:seed:test-users`. Cleans up its rows.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import {
  computeJdCompleteness,
  computeJdReadability,
  computeJdBiasScore,
  type JdSections,
  type JdBiasScan,
} from "@hireops/api-types";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

const RUN = Date.now().toString(36);
const TITLE = `RO-02 Weighting Engineer ${RUN}`;
const DEPARTMENT = `RO-02 QA ${RUN}`;
const TITLE_GATE = `RO-02 Gate Role ${RUN}`;
const DEPARTMENT_GATE = `RO-02 Gate QA ${RUN}`;

let hiringManagerJwt: string;
let tenantId: string;
let reqId: string;
let gateReqId: string;

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string; httpStatus?: number } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}
async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcMutation<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

const SECTIONS = {
  summary: "A senior engineer owning quality for the payments platform team.",
  responsibilities: ["Design automated test suites.", "Partner on release readiness."],
  requirements: ["5+ years in quality engineering.", "Strong programming fundamentals."],
  niceToHave: ["Fintech domain exposure."],
  toolsTech: ["Playwright", "TypeScript"],
  education: [],
  softSkills: ["Clear communication"],
};

async function cleanupReq(id: string) {
  const [row] = await poolSql<{ position_id: string; jd_version_id: string }[]>`
    SELECT position_id, jd_version_id FROM public.requisitions WHERE id = ${id}
  `;
  await poolSql`DELETE FROM public.approval_requests WHERE tenant_id = ${tenantId} AND subject_id = ${id}`;
  await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${id}`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${id}`;
  if (row?.jd_version_id) {
    await poolSql`DELETE FROM public.jd_versions WHERE id = ${row.jd_version_id}`;
  }
  if (row?.position_id) {
    await poolSql`DELETE FROM public.positions WHERE id = ${row.position_id}`;
  }
}

describe("RO-02 wizard v2 & skill weighting", () => {
  beforeAll(async () => {
    hiringManagerJwt = await signIn(HIRING_MANAGER);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
  });

  afterAll(async () => {
    try {
      if (reqId) await cleanupReq(reqId);
      if (gateReqId) await cleanupReq(gateReqId);
      await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${tenantId} AND name IN (${DEPARTMENT.trim()}, ${DEPARTMENT_GATE.trim()})`;
      await poolSql`
        DELETE FROM public.approval_chains c
        WHERE c.tenant_id = ${tenantId}
          AND NOT EXISTS (SELECT 1 FROM public.approval_requests r WHERE r.chain_id = c.id)
          AND c.created_at >= now() - interval '30 minutes'
      `;
    } catch {
      // best-effort — leave residue for the groom sweep.
    }
  });

  // ─────────────── A. skill-metadata round-trip ───────────────

  it("A1: updateRequisitionDraft persists category / min_years / notes on skills", async () => {
    const created = await trpcMutation<{ requisitionId: string }>(
      "createRequisitionDraft",
      { title: TITLE, department: DEPARTMENT, locationType: "hybrid", numberOfOpenings: 1 },
      hiringManagerJwt,
    );
    assert.ok(!isErr(created), `create: ${JSON.stringify(created)}`);
    reqId = created.result.data.requisitionId;

    const updated = await trpcMutation<{ skillCount: number }>(
      "updateRequisitionDraft",
      {
        requisitionId: reqId,
        sections: SECTIONS,
        skills: [
          {
            skillName: "Kafka",
            weight: 8,
            isRequired: true,
            category: "Infrastructure",
            minYears: 3,
            notes: "Event-streaming depth.",
          },
          { skillName: "TypeScript", weight: 5, isRequired: false, category: "Languages" },
        ],
      },
      hiringManagerJwt,
    );
    assert.ok(!isErr(updated), `update: ${JSON.stringify(updated)}`);
    assert.equal(updated.result.data.skillCount, 2);

    // Raw row check — the migration-0080 columns carry the values.
    const rows = await poolSql<
      {
        skill_name: string;
        category: string | null;
        min_years_experience: number | null;
        notes: string | null;
      }[]
    >`
      SELECT s.skill_name, s.category, s.min_years_experience, s.notes
      FROM public.jd_skills s
      JOIN public.requisitions r ON r.jd_version_id = s.jd_version_id
      WHERE r.id = ${reqId}
      ORDER BY s.skill_name
    `;
    const kafka = rows.find((r) => r.skill_name === "Kafka");
    assert.ok(kafka, "Kafka row exists");
    assert.equal(kafka.category, "Infrastructure");
    assert.equal(Number(kafka.min_years_experience), 3);
    assert.equal(kafka.notes, "Event-streaming depth.");
    const ts = rows.find((r) => r.skill_name === "TypeScript");
    assert.equal(ts?.category, "Languages");
    assert.equal(ts?.min_years_experience, null, "TypeScript min_years stays NULL when omitted");
    assert.equal(ts?.notes, null, "TypeScript notes stays NULL when omitted");
  });

  it("A2: getRequisitionDetail reads back the additive skill fields", async () => {
    const detail = await trpcQuery<{
      skills: {
        skillName: string;
        category: string | null;
        minYears: number | null;
        notes: string | null;
      }[];
    }>("getRequisitionDetail", { requisitionId: reqId }, hiringManagerJwt);
    assert.ok(!isErr(detail), `detail: ${JSON.stringify(detail)}`);
    const kafka = detail.result.data.skills.find((s) => s.skillName === "Kafka");
    assert.ok(kafka, "Kafka in detail");
    assert.equal(kafka.category, "Infrastructure");
    assert.equal(kafka.minYears, 3);
    assert.equal(kafka.notes, "Event-streaming depth.");
  });

  it("A3: listRequisitionsForSkillWeighting summarises coverage", async () => {
    const list = await trpcQuery<{
      rows: { id: string; skillCount: number; mustHaveCount: number; editable: boolean }[];
    }>("listRequisitionsForSkillWeighting", { limit: 100 }, hiringManagerJwt);
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    const row = list.result.data.rows.find((r) => r.id === reqId);
    assert.ok(row, "our req appears in the picker");
    assert.equal(row.skillCount, 2);
    assert.equal(row.mustHaveCount, 1);
    assert.equal(row.editable, true, "a draft is editable");
  });

  // ─────────────── B. submit gating (real server enforcement) ───────────────

  it("B1: submit is refused (BAD_REQUEST) while the requisition has no skills", async () => {
    const created = await trpcMutation<{ requisitionId: string }>(
      "createRequisitionDraft",
      {
        title: TITLE_GATE,
        department: DEPARTMENT_GATE,
        locationType: "onsite",
        numberOfOpenings: 1,
      },
      hiringManagerJwt,
    );
    assert.ok(!isErr(created), `create gate: ${JSON.stringify(created)}`);
    gateReqId = created.result.data.requisitionId;

    // JD present, but NO skills → server checklist fails on "at least one skill".
    const upd = await trpcMutation(
      "updateRequisitionDraft",
      { requisitionId: gateReqId, sections: SECTIONS },
      hiringManagerJwt,
    );
    assert.ok(!isErr(upd), `update gate: ${JSON.stringify(upd)}`);

    const submit = await trpcMutation(
      "submitRequisitionForApproval",
      { requisitionId: gateReqId },
      hiringManagerJwt,
    );
    assert.ok(isErr(submit), `expected BAD_REQUEST, got ${JSON.stringify(submit)}`);
    assert.equal(submit.error.data.code, "BAD_REQUEST");
    assert.match(submit.error.message ?? "", /skill/i, "the reason names the missing skill");
  });

  it("B2: submit succeeds once the requisition is complete (skill added)", async () => {
    const upd = await trpcMutation(
      "updateRequisitionDraft",
      {
        requisitionId: gateReqId,
        skills: [{ skillName: "Playwright", weight: 6, isRequired: true, minYears: 2 }],
      },
      hiringManagerJwt,
    );
    assert.ok(!isErr(upd), `add skill: ${JSON.stringify(upd)}`);

    const submit = await trpcMutation<{ status: string }>(
      "submitRequisitionForApproval",
      { requisitionId: gateReqId },
      hiringManagerJwt,
    );
    assert.ok(!isErr(submit), `expected success, got ${JSON.stringify(submit)}`);
    assert.equal(submit.result.data.status, "pending");
  });

  // ─────────────── C. JD-quality pure helpers ───────────────

  it("C1: completeness counts filled sections out of 7", () => {
    const full: JdSections = SECTIONS as JdSections; // 6 of 7 filled (education empty)
    const c = computeJdCompleteness(full);
    assert.equal(c.total, 7);
    assert.equal(c.filled, 6);
    assert.equal(c.pct, Math.round((6 / 7) * 100));
    assert.ok(c.emptyKeys.includes("education"));

    const empty: JdSections = {
      summary: "",
      responsibilities: [],
      requirements: [],
      niceToHave: [],
      toolsTech: [],
      education: [],
      softSkills: [],
    };
    assert.equal(computeJdCompleteness(empty).pct, 0);
  });

  it("C2: readability is 0 for empty and higher for plain than dense prose", () => {
    const empty: JdSections = {
      summary: "",
      responsibilities: [],
      requirements: [],
      niceToHave: [],
      toolsTech: [],
      education: [],
      softSkills: [],
    };
    assert.equal(computeJdReadability(empty).pct, 0);

    const plain: JdSections = {
      summary: "We build tools. The team is small. You will ship often.",
      responsibilities: ["Write clean code.", "Help teammates."],
      requirements: ["Know one language well."],
      niceToHave: [],
      toolsTech: [],
      education: [],
      softSkills: [],
    };
    const dense: JdSections = {
      summary:
        "Responsibilities encompass architecting comprehensively sophisticated infrastructural microservices orchestration frameworks incorporating multidimensional observability instrumentation throughout distributed computational environments continuously.",
      responsibilities: [
        "Operationalise comprehensively multidisciplinary transformational organisational methodologies systematically.",
      ],
      requirements: ["Demonstrable experience implementing infrastructural orchestration."],
      niceToHave: [],
      toolsTech: [],
      education: [],
      softSkills: [],
    };
    const plainScore = computeJdReadability(plain).pct;
    const denseScore = computeJdReadability(dense).pct;
    assert.ok(
      plainScore > denseScore,
      `plain (${plainScore}) should read easier than dense (${denseScore})`,
    );
  });

  it("C3: bias score derives from the real scan (clean=100, flags subtract, off=disabled)", () => {
    assert.deepEqual(computeJdBiasScore(null), {
      pct: 100,
      blockingCount: 0,
      warnCount: 0,
      disabled: true,
    });

    const off: JdBiasScan = { enforcement: "off", matches: [], blockingCount: 0, warningCount: 0 };
    assert.equal(computeJdBiasScore(off).disabled, true);

    const clean: JdBiasScan = {
      enforcement: "block",
      matches: [],
      blockingCount: 0,
      warningCount: 0,
    };
    assert.equal(computeJdBiasScore(clean).pct, 100);

    const flagged: JdBiasScan = {
      enforcement: "block",
      matches: [
        {
          term: "rockstar",
          matchedText: "rockstar",
          category: "superlative_pressure",
          severity: "block",
          suggestion: null,
          start: 0,
          end: 8,
        },
        {
          term: "guru",
          matchedText: "guru",
          category: "superlative_pressure",
          severity: "warn",
          suggestion: null,
          start: 9,
          end: 13,
        },
      ],
      blockingCount: 1,
      warningCount: 1,
    };
    const r = computeJdBiasScore(flagged);
    assert.equal(r.blockingCount, 1);
    assert.equal(r.warnCount, 1);
    assert.equal(r.pct, 100 - 20 - 8); // 72
  });
});
