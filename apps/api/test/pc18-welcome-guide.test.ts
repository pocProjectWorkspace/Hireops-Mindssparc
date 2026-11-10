/**
 * PC-18 — welcome guide per business unit (DB-backed).
 *
 *   1. Generation goes through the `welcome_guide` AI feature with the
 *      LocalAIClient fixture tier (NODE_ENV=test) standing in for the model.
 *      The fixture invents a person and a number; the post-check drops both
 *      and records them; model + prompt version are stored. Kill switch and
 *      empty source refuse BEFORE any model call.
 *   2. Publish / version rules: one draft and one published per scope;
 *      published is immutable; publishing supersedes; "edit as new draft".
 *   3. Candidate access: pre-joining only (accepted, not joined); own BU →
 *      nearest ancestor → organisation default; never a sibling BU's guide;
 *      read receipts only for the guide the candidate is shown; they surface
 *      on the engagement timeline.
 *   4. Journey step: welcome_guide is planned on journey start and the drain
 *      sends it with the guide link, or skips it when no guide resolves.
 *
 * REQUIRES migrations 0128 + 0130.
 */
import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { hashStructuredOptions } from "@hireops/ai-client";
import {
  AI_DEFAULT_MODEL,
  welcomeSourceFieldsSchema,
  type WelcomeSourceFields,
} from "@hireops/api-types";
import { startPreJoiningJourney } from "../src/lib/pre-joining/journey";
import { getEngagementTimeline } from "../src/lib/pre-joining/watchlist";
import {
  WELCOME_GUIDE_FEATURE,
  WELCOME_GUIDE_PROMPT_VERSION,
  WELCOME_GUIDE_SCHEMA_NAME,
  buildWelcomeGuidePrompt,
  welcomeGuideAiJsonSchema,
} from "../src/lib/pre-joining/welcome-guide-prompt";
import {
  createWelcomeDraftFromVersion,
  discardWelcomeGuideDraft,
  generateWelcomeGuide,
  getCandidateWelcomeGuide,
  getWelcomeContent,
  markWelcomeSectionViewed,
  publishWelcomeGuide,
  updateWelcomeGuideDraft,
  upsertWelcomeSource,
} from "../src/lib/pre-joining/welcome-guide";
import { drainPreJoiningTouchpointsOnce } from "../../../apps/workers/src/lib/pre-joining-drain.js";
import {
  ENABLED_IST,
  cleanupTenant,
  seedAcceptedCandidate,
  seedIds,
  seedTenant,
} from "./pc14-helpers";

function must<V>(v: V | null | undefined, what = "value"): V {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}

const NS = "18a";
const ids = seedIds(NS);
const log = createLogger({ base: { service: "pc18-welcome-test" } });
const xid = (n: string) => `00000000-0000-4000-8000-0000${NS}${n}`;
// Extra org structure: CHILD under ids.BU, SIBLING at the top level.
const CHILD = xid("00a01");
const SIBLING = xid("00a02");
const POS_CHILD = xid("00a03");
const JD_CHILD = xid("00a04");
const REQ_CHILD = xid("00a05");

const COMPANY = `PC14 Synth ${NS}`;
const BU_NAME = `PC14 BU ${NS}`;

const SOURCE: WelcomeSourceFields = welcomeSourceFieldsSchema.parse({
  overview: "Finance Operations runs the monthly close for 14 plants from the Pune hub.",
  leaders: [
    {
      name: "Meera Iyer",
      title: "Head of Finance Operations",
      bio: "Meera mentors every new joiner.",
      photoUrl: "https://example.test/meera.jpg",
    },
  ],
  culture: "We value ownership and plain speaking.",
  firstWeek: "Day 1 starts at 9:30 with a laptop handover.",
  links: [{ label: "Team intro video", url: "https://example.test/intro", kind: "video" }],
});

const FIXTURE_JSON = {
  welcome: `Welcome to ${COMPANY}. We are glad you are joining.`,
  businessUnit: "Finance Operations runs the monthly close for 14 plants. The team has 250 people.",
  people: [
    { name: "Meera Iyer", about: "Meera mentors every new joiner." },
    { name: "Sanjay Kapoor", about: "Sanjay will be your buddy." },
  ],
  howWeWork: "We value ownership and plain speaking.",
  firstWeek: "Day 1 starts at 9:30 with a laptop handover.",
  faqs: [{ question: "What time do I start?", answer: "Day 1 starts at 9:30." }],
};

const here = dirname(fileURLToPath(import.meta.url));
const AI_FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");
const written: string[] = [];

async function primeFixture(args: {
  businessUnitName: string | null;
  source: WelcomeSourceFields;
  organisationSource: WelcomeSourceFields | null;
}): Promise<void> {
  const built = buildWelcomeGuidePrompt({ companyName: COMPANY, ...args });
  const hash = hashStructuredOptions({
    system: built.system,
    prompt: built.user,
    model: AI_DEFAULT_MODEL,
    schema: welcomeGuideAiJsonSchema,
    schemaName: WELCOME_GUIDE_SCHEMA_NAME,
    feature: WELCOME_GUIDE_FEATURE,
  });
  await mkdir(AI_FIXTURE_DIR, { recursive: true });
  const path = resolve(AI_FIXTURE_DIR, `${hash}.json`);
  await writeFile(
    path,
    JSON.stringify({
      json: FIXTURE_JSON,
      inputTokens: 900,
      outputTokens: 400,
      costMicros: 4000,
      latencyMs: 400,
    }),
  );
  written.push(path);
}

async function setAiFeatureEnabled(enabled: boolean): Promise<void> {
  await poolSql`
    UPDATE public.tenants
    SET settings = settings || jsonb_build_object(
      'aiSettings', jsonb_build_object(${WELCOME_GUIDE_FEATURE}::text, jsonb_build_object('enabled', ${enabled}::boolean)))
    WHERE id = ${ids.T}
  `;
}

async function versionCount(bu: string | null): Promise<number> {
  const [r] = await poolSql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM public.welcome_guides
    WHERE tenant_id = ${ids.T} AND business_unit_id IS NOT DISTINCT FROM ${bu}::uuid
  `;
  return r?.n ?? 0;
}

async function usageCount(): Promise<number> {
  const [r] = await poolSql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM public.ai_usage_logs
    WHERE tenant_id = ${ids.T} AND feature = ${WELCOME_GUIDE_FEATURE}
  `;
  return r?.n ?? 0;
}

/** Publish a hand-written guide for a scope (no model call) — fixture data for access tests. */
async function publishDirect(bu: string | null, welcome: string): Promise<string> {
  const [v] = await poolSql<{ next: number }[]>`
    SELECT COALESCE(MAX(version), 0) + 1 AS next FROM public.welcome_guides
    WHERE tenant_id = ${ids.T} AND business_unit_id IS NOT DISTINCT FROM ${bu}::uuid
  `;
  await poolSql`
    UPDATE public.welcome_guides SET status = 'superseded'
    WHERE tenant_id = ${ids.T} AND business_unit_id IS NOT DISTINCT FROM ${bu}::uuid
      AND status = 'published'
  `;
  const [g] = await poolSql<{ id: string }[]>`
    INSERT INTO public.welcome_guides
      (tenant_id, business_unit_id, version, status, content, published_at)
    VALUES (${ids.T}, ${bu}::uuid, ${Number(v?.next ?? 1)}, 'published',
            ${JSON.stringify({ welcome })}::jsonb, now())
    RETURNING id
  `;
  return must(g).id;
}

const now = new Date();
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => isoDay(new Date(now.getTime() + n * 86_400_000));

describe("PC-18 — welcome guide", () => {
  let A: Awaited<ReturnType<typeof seedAcceptedCandidate>>; // pre-joining, BU
  let B: Awaited<ReturnType<typeof seedAcceptedCandidate>>; // pre-joining, CHILD
  let C: Awaited<ReturnType<typeof seedAcceptedCandidate>>; // not pre-joining (interviewing)
  let D: Awaited<ReturnType<typeof seedAcceptedCandidate>>; // joined (case day_zero)

  beforeAll(async () => {
    process.env.PRE_JOINING_REPLY_DOMAIN = "in.example.test";
    await seedTenant(ids, NS, {});
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug, parent_business_unit_id)
      VALUES (${CHILD}, ${ids.T}, ${`PC18 Child ${NS}`}, ${`pc18-child-${NS}-${Date.now()}`}, ${ids.BU}),
             (${SIBLING}, ${ids.T}, ${`PC18 Sibling ${NS}`}, ${`pc18-sib-${NS}-${Date.now()}`}, NULL)
    `;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POS_CHILD}, ${ids.T}, ${CHILD}, 'PC18 AP Analyst', 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD_CHILD}, ${ids.T}, ${POS_CHILD}, 1, '# PC18 JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ_CHILD}, ${ids.T}, ${POS_CHILD}, ${JD_CHILD}, ${ids.REC_A}, ${ids.REC_A}, 'posted')
    `;
    A = await seedAcceptedCandidate(ids, "0001", { joiningDate: inDays(60), acceptedAt: now });
    B = await seedAcceptedCandidate(ids, "0002", { joiningDate: inDays(45), acceptedAt: now });
    await poolSql`UPDATE public.applications SET requisition_id = ${REQ_CHILD} WHERE id = ${B.app}`;
    C = await seedAcceptedCandidate(ids, "0003", { joiningDate: inDays(30), acceptedAt: now });
    await poolSql`UPDATE public.applications SET current_stage = 'tech_interview' WHERE id = ${C.app}`;
    await poolSql`UPDATE public.offers SET status = 'drafted', accepted_at = NULL WHERE id = ${C.offer}`;
    D = await seedAcceptedCandidate(ids, "0004", { joiningDate: inDays(1), acceptedAt: now });
    await poolSql`
      INSERT INTO public.onboarding_cases (tenant_id, application_id, candidate_id, status, geography_code)
      VALUES (${ids.T}, ${D.app}, ${D.candidate}, 'day_zero', 'IN')
    `;
    await primeFixture({ businessUnitName: BU_NAME, source: SOURCE, organisationSource: null });
  });

  afterAll(async () => {
    for (const p of written) await unlink(p).catch(() => undefined);
    await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${ids.T} AND id = ${REQ_CHILD}`.catch(
      () => undefined,
    );
    await cleanupTenant(ids);
    await poolSql.end({ timeout: 5 });
  });

  it("refuses to generate from an empty source, and an unknown business unit", async () => {
    const r = await generateWelcomeGuide(poolSql, {
      tenantId: ids.T,
      businessUnitId: ids.BU,
      membershipId: ids.HRHEAD,
      requestId: null,
    });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "BAD_REQUEST");
    const unknown = await upsertWelcomeSource(poolSql, {
      tenantId: ids.T,
      membershipId: ids.HRHEAD,
      businessUnitId: xid("00fff"),
      source: SOURCE,
    });
    assert.equal(!unknown.ok && unknown.code, "NOT_FOUND");
    assert.equal(await versionCount(ids.BU), 0);
  });

  it("kill switch: no model call, no version", async () => {
    const saved = await upsertWelcomeSource(poolSql, {
      tenantId: ids.T,
      membershipId: ids.HRHEAD,
      businessUnitId: ids.BU,
      source: SOURCE,
    });
    assert.equal(saved.ok, true);
    await setAiFeatureEnabled(false);
    const r = await generateWelcomeGuide(poolSql, {
      tenantId: ids.T,
      businessUnitId: ids.BU,
      membershipId: ids.HRHEAD,
      requestId: null,
    });
    assert.equal(!r.ok && r.code, "BAD_REQUEST");
    assert.match(!r.ok ? r.message : "", /disabled/);
    assert.equal(await versionCount(ids.BU), 0);
    assert.equal(await usageCount(), 0);
    await setAiFeatureEnabled(true);
  });

  it("generates a grounded draft: invented person + number dropped and listed; model + prompt version stored", async () => {
    const r = await generateWelcomeGuide(poolSql, {
      tenantId: ids.T,
      businessUnitId: ids.BU,
      membershipId: ids.HRHEAD,
      requestId: null,
    });
    assert.equal(r.ok, true, !r.ok ? r.message : "");
    const g = r.guide;
    assert.equal(g.version, 1);
    assert.equal(g.status, "draft");
    assert.equal(g.model, AI_DEFAULT_MODEL);
    assert.equal(g.promptVersion, WELCOME_GUIDE_PROMPT_VERSION);
    assert.deepEqual(
      g.content.people.map((p) => [p.name, p.title]),
      [["Meera Iyer", "Head of Finance Operations"]],
    );
    assert.equal(
      g.content.businessUnit,
      "Finance Operations runs the monthly close for 14 plants.",
    );
    const dropped = g.groundingReport.dropped.map((d) => `${d.reason}:${d.text}`);
    assert.ok(dropped.includes("person_not_in_source:Sanjay Kapoor"), dropped.join(" | "));
    assert.ok(dropped.includes("ungrounded_terms:The team has 250 people."), dropped.join(" | "));
    assert.equal(await usageCount(), 1);
  });

  it("publish / version rules", async () => {
    const content = must(
      await getWelcomeContent(poolSql, { tenantId: ids.T, businessUnitId: ids.BU }),
    );
    const v1 = must(content.versions.find((v) => v.status === "draft"));

    // Candidate sees nothing until something is published (no BU, ancestor or org guide).
    const before = await getCandidateWelcomeGuide(poolSql, {
      tenantId: ids.T,
      personId: A.person,
      companyName: COMPANY,
    });
    assert.equal(before.status, "no_guide");

    // Draft edit → publish.
    const edited = await updateWelcomeGuideDraft(poolSql, {
      tenantId: ids.T,
      guideId: v1.id,
      content: { ...v1.content, welcome: "Welcome aboard, edited by HR." },
      membershipId: ids.HRHEAD,
    });
    assert.equal(edited.ok, true);
    assert.ok(edited.ok && edited.guide.editedAt);
    const pub1 = await publishWelcomeGuide(poolSql, {
      tenantId: ids.T,
      guideId: v1.id,
      membershipId: ids.HRHEAD,
    });
    assert.deepEqual(pub1, { ok: true, version: 1 });

    // Published is immutable; cannot be re-published or discarded.
    const editPub = await updateWelcomeGuideDraft(poolSql, {
      tenantId: ids.T,
      guideId: v1.id,
      content: v1.content,
      membershipId: ids.HRHEAD,
    });
    assert.equal(!editPub.ok && editPub.code, "CONFLICT");
    const again = await publishWelcomeGuide(poolSql, {
      tenantId: ids.T,
      guideId: v1.id,
      membershipId: ids.HRHEAD,
    });
    assert.equal(!again.ok && again.code, "CONFLICT");
    const disc = await discardWelcomeGuideDraft(poolSql, { tenantId: ids.T, guideId: v1.id });
    assert.equal(!disc.ok && disc.code, "CONFLICT");

    // New draft from the published version; a second one is refused.
    const copy = await createWelcomeDraftFromVersion(poolSql, {
      tenantId: ids.T,
      guideId: v1.id,
      membershipId: ids.HRHEAD,
    });
    assert.equal(copy.ok, true);
    const v2 = copy.guide;
    assert.equal(v2.version, 2);
    assert.equal(v2.promptVersion, WELCOME_GUIDE_PROMPT_VERSION);
    const copy2 = await createWelcomeDraftFromVersion(poolSql, {
      tenantId: ids.T,
      guideId: v1.id,
      membershipId: ids.HRHEAD,
    });
    assert.equal(!copy2.ok && copy2.code, "CONFLICT");

    // Regenerating discards the open draft (kept as history) and makes v3.
    const regen = await generateWelcomeGuide(poolSql, {
      tenantId: ids.T,
      businessUnitId: ids.BU,
      membershipId: ids.HRHEAD,
      requestId: null,
    });
    assert.equal(regen.ok && regen.guide.version, 3);
    const after = must(
      await getWelcomeContent(poolSql, { tenantId: ids.T, businessUnitId: ids.BU }),
    );
    assert.deepEqual(
      after.versions.map((v) => [v.version, v.status]),
      [
        [3, "draft"],
        [2, "discarded"],
        [1, "published"],
      ],
    );

    // While v3 is a draft the candidate still sees v1.
    const mid = await getCandidateWelcomeGuide(poolSql, {
      tenantId: ids.T,
      personId: A.person,
      companyName: COMPANY,
    });
    assert.equal(mid.guide?.guideId, v1.id);
    assert.equal(mid.guide?.content.welcome, "Welcome aboard, edited by HR.");

    // Publishing v3 supersedes v1; exactly one published.
    const pub3 = await publishWelcomeGuide(poolSql, {
      tenantId: ids.T,
      guideId: must(after.versions[0]).id,
      membershipId: ids.HRHEAD,
    });
    assert.deepEqual(pub3, { ok: true, version: 3 });
    const [{ n } = { n: -1 }] = await poolSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM public.welcome_guides
      WHERE tenant_id = ${ids.T} AND business_unit_id = ${ids.BU} AND status = 'published'
    `;
    assert.equal(n, 1);
    const [s1] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.welcome_guides WHERE id = ${v1.id}
    `;
    assert.equal(s1?.status, "superseded");
    // The DB itself refuses a second published row for the scope.
    await assert.rejects(
      poolSql`UPDATE public.welcome_guides SET status = 'published', published_at = now() WHERE id = ${v1.id}`,
    );
  });

  it("candidate access: own BU, nearest ancestor, organisation default; never a sibling", async () => {
    // Sibling has a guide; the organisation default too.
    const sibGuide = await publishDirect(SIBLING, "Sibling welcome.");
    const orgGuide = await publishDirect(null, "Organisation welcome.");

    const a = await getCandidateWelcomeGuide(poolSql, {
      tenantId: ids.T,
      personId: A.person,
      companyName: COMPANY,
    });
    assert.equal(a.status, "available");
    assert.equal(a.guide?.scopeName, BU_NAME);
    assert.equal(a.guide?.photos["Meera Iyer"], "https://example.test/meera.jpg");
    assert.deepEqual(
      a.guide?.links.map((l) => l.url),
      ["https://example.test/intro"],
    );

    // CHILD has no guide → its parent (ids.BU), not the sibling or the org.
    const b = await getCandidateWelcomeGuide(poolSql, {
      tenantId: ids.T,
      personId: B.person,
      companyName: COMPANY,
    });
    assert.equal(b.guide?.scopeName, BU_NAME);
    assert.notEqual(b.guide?.guideId, sibGuide);

    // Remove the BU's published guide → the child falls back to the organisation default.
    await poolSql`
      UPDATE public.welcome_guides SET status = 'superseded'
      WHERE tenant_id = ${ids.T} AND business_unit_id = ${ids.BU} AND status = 'published'
    `;
    const b2 = await getCandidateWelcomeGuide(poolSql, {
      tenantId: ids.T,
      personId: B.person,
      companyName: COMPANY,
    });
    assert.equal(b2.guide?.guideId, orgGuide);
    assert.equal(b2.guide?.scopeName, null);
    // Restore the BU guide for the next tests.
    await poolSql`
      UPDATE public.welcome_guides SET status = 'published'
      WHERE tenant_id = ${ids.T} AND business_unit_id = ${ids.BU} AND version = 3
    `;

    // Not pre-joining (interviewing) and already joined → nothing.
    for (const who of [C, D]) {
      const r = await getCandidateWelcomeGuide(poolSql, {
        tenantId: ids.T,
        personId: who.person,
        companyName: COMPANY,
      });
      assert.equal(r.status, "not_pre_joining");
      assert.equal(r.guide, null);
    }
  });

  it("read receipts: only the shown guide, idempotent, on the engagement timeline", async () => {
    const a = await getCandidateWelcomeGuide(poolSql, {
      tenantId: ids.T,
      personId: A.person,
      companyName: COMPANY,
    });
    const guideId = must(a.guide).guideId;
    const [sib] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.welcome_guides
      WHERE tenant_id = ${ids.T} AND business_unit_id = ${SIBLING} AND status = 'published'
    `;
    const wrong = await markWelcomeSectionViewed(poolSql, {
      tenantId: ids.T,
      personId: A.person,
      guideId: must(sib).id,
      section: "welcome",
    });
    assert.equal(!wrong.ok && wrong.code, "NOT_FOUND");
    const notPre = await markWelcomeSectionViewed(poolSql, {
      tenantId: ids.T,
      personId: C.person,
      guideId,
      section: "welcome",
    });
    assert.equal(!notPre.ok && notPre.code, "NOT_FOUND");

    for (const section of ["welcome", "people", "welcome"] as const) {
      const r = await markWelcomeSectionViewed(poolSql, {
        tenantId: ids.T,
        personId: A.person,
        guideId,
        section,
      });
      assert.equal(r.ok, true);
    }
    const again = await getCandidateWelcomeGuide(poolSql, {
      tenantId: ids.T,
      personId: A.person,
      companyName: COMPANY,
    });
    assert.deepEqual([...(again.guide?.viewedSections ?? [])].sort(), ["people", "welcome"]);

    const tl = must(
      await getEngagementTimeline(poolSql, { tenantId: ids.T, applicationId: A.app }),
    );
    const viewed = tl.items.filter((i) => i.kind === "welcome_guide_viewed");
    assert.equal(viewed.length, 1);
    assert.ok(viewed[0]?.kind === "welcome_guide_viewed" && viewed[0].sectionsViewed === 2);
  });

  it("journey step: planned on start, sent with the guide link, skipped when no guide resolves", async () => {
    await poolSql`
      UPDATE public.tenants
      SET settings = settings || ${JSON.stringify(ENABLED_IST)}::jsonb
      WHERE id = ${ids.T}
    `;
    for (const who of [A, B]) {
      const r = await startPreJoiningJourney(poolSql, {
        tenantId: ids.T,
        applicationId: who.app,
        log,
      });
      assert.equal(r.created, true);
    }
    // Drop the organisation default so B's chain (CHILD → BU → org) can be
    // emptied below by superseding only the BU guide. A still has its BU guide.
    await poolSql`
      UPDATE public.welcome_guides SET status = 'superseded'
      WHERE tenant_id = ${ids.T} AND status = 'published' AND business_unit_id IS NULL
    `;
    await poolSql`
      UPDATE public.pre_joining_touchpoints
      SET scheduled_for = now() - interval '1 minute'
      WHERE tenant_id = ${ids.T} AND application_id = ${A.app} AND step_key = 'welcome_guide'
        AND status = 'scheduled'
    `;
    for (let i = 0; i < 5; i++) {
      const r = await drainPreJoiningTouchpointsOnce({ log, batchSize: 50 });
      if (r.claimed === 0) break;
    }
    const [aTp] = await poolSql<{ status: string; notification_outbox_id: string | null }[]>`
      SELECT status, notification_outbox_id FROM public.pre_joining_touchpoints
      WHERE tenant_id = ${ids.T} AND application_id = ${A.app} AND step_key = 'welcome_guide'
    `;
    assert.equal(aTp?.status, "sent");
    const [ob] = await poolSql<{ template_key: string; template_data: Record<string, unknown> }[]>`
      SELECT template_key, template_data FROM public.notification_outbox
      WHERE id = ${must(aTp?.notification_outbox_id)}
    `;
    assert.equal(ob?.template_key, "candidate.pre_joining_welcome_guide");
    assert.match(String(ob?.template_data.guideUrl), /\/candidate\/welcome$/);

    // B: no guide anywhere on its chain now that BU is superseded too.
    await poolSql`
      UPDATE public.welcome_guides SET status = 'superseded'
      WHERE tenant_id = ${ids.T} AND business_unit_id = ${ids.BU} AND status = 'published'
    `;
    await poolSql`
      UPDATE public.pre_joining_touchpoints
      SET scheduled_for = now() - interval '1 minute'
      WHERE tenant_id = ${ids.T} AND application_id = ${B.app} AND step_key = 'welcome_guide'
        AND status = 'scheduled'
    `;
    for (let i = 0; i < 5; i++) {
      const r = await drainPreJoiningTouchpointsOnce({ log, batchSize: 50 });
      if (r.claimed === 0) break;
    }
    const [bTp] = await poolSql<{ status: string; skip_reason: string | null }[]>`
      SELECT status, skip_reason FROM public.pre_joining_touchpoints
      WHERE tenant_id = ${ids.T} AND application_id = ${B.app} AND step_key = 'welcome_guide'
    `;
    assert.equal(bTp?.status, "skipped");
    assert.equal(bTp?.skip_reason, "no_welcome_guide");
  });
});
