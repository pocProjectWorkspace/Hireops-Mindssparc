/**
 * L&D demo seed — fills the learning catalogue, the tracks, the upskilling
 * skill map, and creates onboarding cases that the suggestion engine can
 * actually say something about.
 *
 * WHY THE FOURTH PIECE EXISTS. Seeding the three learning tables alone would
 * leave /admin/learning populated and the hire-facing half still dead, for a
 * reason that is easy to miss: `getSuggestedLearningForCase` derives its
 * answer from the gap between a hire's `candidates.parsed_skills.skills` and
 * their requisition's `jd_skills`. Every onboarding case that existed before
 * this seed belongs to a candidate with NO parsed skills, so all of them
 * correctly answer "we couldn't read this CV" — honest, and useless to
 * demonstrate with. The 13 offer_accepted hires from the analytics seed DO
 * carry parsed skills, and had no onboarding case. This seed bridges that.
 *
 * WHAT IT CREATES
 *   learning_resources    a catalogue of POINTERS — org induction material on
 *                         an intranet, plus public vendor documentation for the
 *                         technical skills the four cohort JDs actually ask for.
 *                         No media is hosted; `url` is the payload.
 *   learning_tracks       one organisation induction track (every hire) and one
 *                         role track per cohort position.
 *   learning_track_items  their ordered contents, with due offsets.
 *   learning_skill_map    skill -> resource, keyed on the REAL skill strings in
 *                         jd_skills so suggestions actually fire. Skills are
 *                         matched loosely by the server (two-way containment),
 *                         but the names here are exact on purpose.
 *   onboarding_cases      for analytics-seed hires WITH parsed skills, plus the
 *                         standard task checklist (mirrors seed-demo-data.ts).
 *
 * One case is pre-pushed with the induction track so /candidate/learning has
 * content to show. The rest are deliberately left empty so the push can be
 * demonstrated live from the onboarding case.
 *
 * SAFETY. Writes to the SHARED staging database.
 *   - Refuses to run unless the tenant slug is `kyndryl-poc`.
 *   - Every row carries the reserved UUID prefix `0000ed00-`, so `--undo`
 *     removes exactly what it added.
 *   - Idempotent: content upserts on stable ids; cases and their tasks are
 *     delete-then-reinsert so timestamps re-anchor to the run.
 *   - Dates are relative to now(), so nothing rots.
 *
 * Depends on: db:seed:analytics-demo (the hires with parsed skills) and
 * migrations 0111 + 0112.
 *
 * Run:   pnpm db:seed:learning-demo
 * Undo:  pnpm db:seed:learning-demo -- --undo
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";
const ID_PREFIX = "0000ed00";
const ANALYTICS_PREFIX = "0000ad00";

const KIND = {
  resource: 0x01,
  track: 0x02,
  trackItem: 0x03,
  skillMap: 0x04,
  onbCase: 0x05,
} as const;

function mkId(kind: number, n: number): string {
  const tail = kind.toString(16).padStart(2, "0") + n.toString(16).padStart(10, "0");
  return `${ID_PREFIX}-0000-4000-8000-${tail}`;
}

// ── memberships (db:seed:test-users) ─────────────────────────────────────────
const MEMBER = {
  admin: "69a8139c-8bca-4a63-87b2-2cd4983a84ab",
  hiringManager: "cb9eb9aa-cf33-47b6-be0a-f9a816015e11",
  hrOps: "664ea7f4-8009-41d2-a145-5c0b5a9b7178",
  panel: "c2ef7901-7ee9-43e6-9287-494a8944709b",
} as const;

const DAY_MS = 86_400_000;
const PROBATION_DAYS = 90;
const CHECK_IN_DAYS = [7, 14, 30];

/**
 * The catalogue. `key` is the stable handle used by tracks and the skill map;
 * `provider` must be one of the CHECK values on learning_resources.
 *
 * The technical URLs are real public vendor documentation — they resolve, which
 * matters when someone clicks one during a demo. The org-induction URLs point at
 * a fictional intranet and are the one place a broken link is honest: they stand
 * in for material the customer would supply.
 */
const RESOURCES: {
  key: string;
  title: string;
  description: string;
  provider: string;
  url: string;
  minutes: number;
}[] = [
  // ── organisation induction ──
  {
    key: "welcome",
    title: "Welcome to NovaChem GCC",
    description: "Who we are, what the GCC does, and how your work reaches the business.",
    provider: "internal_doc",
    url: "https://novachem.sharepoint.com/sites/gcc-induction/welcome",
    minutes: 30,
  },
  {
    key: "code-of-conduct",
    title: "Code of conduct and ethics",
    description: "Mandatory. Conduct, conflicts of interest, and how to raise a concern.",
    provider: "internal_doc",
    url: "https://novachem.sharepoint.com/sites/gcc-induction/code-of-conduct",
    minutes: 45,
  },
  {
    key: "security-awareness",
    title: "Information security awareness",
    description: "Mandatory. Phishing, data handling, and incident reporting.",
    provider: "internal_doc",
    url: "https://novachem.sharepoint.com/sites/security/awareness-2026",
    minutes: 60,
  },
  {
    key: "ways-of-working",
    title: "How we work — tools, rituals and escalation",
    description: "Sprint cadence, on-call, and who to ask when you are stuck.",
    provider: "internal_doc",
    url: "https://novachem.sharepoint.com/sites/gcc-induction/ways-of-working",
    minutes: 40,
  },
  // ── technical ──
  {
    key: "kubernetes",
    title: "Kubernetes fundamentals",
    description: "Pods, deployments, services and the objects you meet on day one.",
    provider: "link",
    url: "https://kubernetes.io/docs/concepts/",
    minutes: 240,
  },
  {
    key: "mlops",
    title: "MLOps — putting models into production",
    description: "Pipelines, model registries, monitoring and rollback.",
    provider: "link",
    url: "https://ml-ops.org/content/mlops-principles",
    minutes: 180,
  },
  {
    key: "aws",
    title: "AWS core services",
    description: "IAM, S3, EC2 and VPC — the base every workload sits on.",
    provider: "link",
    url: "https://docs.aws.amazon.com/whitepapers/latest/aws-overview/introduction.html",
    minutes: 300,
  },
  {
    key: "genai",
    title: "Generative AI and LLM application patterns",
    description: "Prompting, retrieval augmentation, evaluation and guardrails.",
    provider: "link",
    url: "https://docs.anthropic.com/en/docs/build-with-claude/overview",
    minutes: 150,
  },
  {
    key: "python",
    title: "Python for production services",
    description: "Typing, packaging and the idioms our services are written in.",
    provider: "link",
    url: "https://docs.python.org/3/tutorial/",
    minutes: 200,
  },
  {
    key: "machine-learning",
    title: "Applied machine learning refresher",
    description: "Feature engineering, evaluation and the failure modes that matter.",
    provider: "link",
    url: "https://developers.google.com/machine-learning/crash-course",
    minutes: 900,
  },
  {
    key: "java",
    title: "Modern Java for backend services",
    description: "Records, streams and the language level our services target.",
    provider: "link",
    url: "https://dev.java/learn/",
    minutes: 240,
  },
  {
    key: "spring-boot",
    title: "Spring Boot essentials",
    description: "Configuration, dependency injection, and building a REST service.",
    provider: "link",
    url: "https://spring.io/guides/gs/spring-boot",
    minutes: 180,
  },
  {
    key: "kafka",
    title: "Kafka for application developers",
    description: "Topics, partitions, consumer groups and delivery semantics.",
    provider: "link",
    url: "https://kafka.apache.org/documentation/#gettingStarted",
    minutes: 210,
  },
  {
    key: "postgres",
    title: "PostgreSQL for application developers",
    description: "Indexing, transactions, and reading a query plan.",
    provider: "link",
    url: "https://www.postgresql.org/docs/current/tutorial.html",
    minutes: 240,
  },
  {
    key: "sql",
    title: "SQL beyond SELECT",
    description: "Window functions, CTEs and set-based thinking.",
    provider: "link",
    url: "https://www.postgresql.org/docs/current/tutorial-window.html",
    minutes: 120,
  },
  {
    key: "spark",
    title: "Apache Spark fundamentals",
    description: "DataFrames, partitioning and the cost of a shuffle.",
    provider: "link",
    url: "https://spark.apache.org/docs/latest/quick-start.html",
    minutes: 240,
  },
  {
    key: "airflow",
    title: "Airflow — authoring reliable DAGs",
    description: "Scheduling, backfills, idempotent tasks and retries.",
    provider: "link",
    url: "https://airflow.apache.org/docs/apache-airflow/stable/tutorial/index.html",
    minutes: 180,
  },
  {
    key: "dbt",
    title: "dbt — analytics engineering",
    description: "Models, tests and documentation as version-controlled code.",
    provider: "link",
    url: "https://docs.getdbt.com/docs/introduction",
    minutes: 180,
  },
];

/** Tracks. `positionTitle` binds a role track; null = the organisation track. */
const TRACKS: {
  key: string;
  name: string;
  layer: "organisation" | "role";
  positionTitle: string | null;
  items: { resource: string; required: boolean; dueOffsetDays: number }[];
}[] = [
  {
    key: "induction",
    name: "NovaChem GCC induction",
    layer: "organisation",
    positionTitle: null,
    items: [
      { resource: "welcome", required: true, dueOffsetDays: 3 },
      { resource: "code-of-conduct", required: true, dueOffsetDays: 5 },
      { resource: "security-awareness", required: true, dueOffsetDays: 5 },
      { resource: "ways-of-working", required: false, dueOffsetDays: 14 },
    ],
  },
  {
    key: "role-ai-architect",
    name: "Principal AI Architect — role ramp-up",
    layer: "role",
    positionTitle: "Principal AI Architect",
    items: [
      { resource: "genai", required: true, dueOffsetDays: 21 },
      { resource: "mlops", required: true, dueOffsetDays: 30 },
      { resource: "aws", required: false, dueOffsetDays: 45 },
      { resource: "kubernetes", required: false, dueOffsetDays: 60 },
    ],
  },
  {
    key: "role-backend",
    name: "Senior Backend Engineer — role ramp-up",
    layer: "role",
    positionTitle: "Senior Backend Engineer",
    items: [
      { resource: "spring-boot", required: true, dueOffsetDays: 21 },
      { resource: "kafka", required: true, dueOffsetDays: 30 },
      { resource: "postgres", required: false, dueOffsetDays: 45 },
      { resource: "kubernetes", required: false, dueOffsetDays: 60 },
    ],
  },
  {
    key: "role-data-platform",
    name: "Data Platform Engineer — role ramp-up",
    layer: "role",
    positionTitle: "Data Platform Engineer",
    items: [
      { resource: "kafka", required: true, dueOffsetDays: 21 },
      { resource: "postgres", required: true, dueOffsetDays: 30 },
      { resource: "kubernetes", required: false, dueOffsetDays: 45 },
    ],
  },
  {
    key: "role-data-engineer",
    name: "Data Engineer — role ramp-up",
    layer: "role",
    positionTitle: "Data Engineer",
    items: [
      { resource: "spark", required: true, dueOffsetDays: 21 },
      { resource: "airflow", required: true, dueOffsetDays: 30 },
      { resource: "dbt", required: false, dueOffsetDays: 45 },
    ],
  },
];

/**
 * skill -> resources. The skill strings mirror `jd_skills.skill_name` on the
 * four cohort requisitions EXACTLY (including "Springboot", which is how that
 * JD spells it) so the derived suggestions land. The server matches loosely,
 * but relying on that would be sloppy.
 */
const SKILL_MAP: { skill: string; resources: string[] }[] = [
  { skill: "Python", resources: ["python"] },
  { skill: "Machine Learning", resources: ["machine-learning"] },
  { skill: "Generative AI", resources: ["genai"] },
  { skill: "AWS", resources: ["aws"] },
  { skill: "Kubernetes", resources: ["kubernetes"] },
  { skill: "MLOps", resources: ["mlops", "kubernetes"] },
  { skill: "Java", resources: ["java"] },
  { skill: "Springboot", resources: ["spring-boot"] },
  { skill: "Spring Boot", resources: ["spring-boot"] },
  { skill: "Kafka", resources: ["kafka"] },
  { skill: "PostgreSQL", resources: ["postgres"] },
  { skill: "SQL", resources: ["sql", "postgres"] },
  { skill: "Spark", resources: ["spark"] },
  { skill: "Airflow", resources: ["airflow"] },
  { skill: "dbt", resources: ["dbt"] },
];

/** How many onboarding cases to create per cohort requisition. */
const CASES_PER_REQ = 2;

type SqlClient = (typeof import("../client"))["sql"];

async function main(): Promise<void> {
  const undo = process.argv.includes("--undo");
  const { sql } = await import("../client");

  try {
    const [tenant] = await sql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!tenant) {
      console.error(`tenant ${TENANT_SLUG} not found — refusing to run.`);
      process.exit(2);
    }
    const tid = tenant.id;

    if (undo) {
      await runUndo(sql, tid);
      return;
    }

    console.log(`Seeding L&D demo data into ${TENANT_SLUG} (${tid})\n`);
    await deleteSeededRows(sql, tid);

    // ── 1. catalogue ─────────────────────────────────────────────────────────
    const resourceId = new Map<string, string>();
    let n = 0;
    for (const r of RESOURCES) {
      const id = mkId(KIND.resource, n);
      resourceId.set(r.key, id);
      await sql`
        INSERT INTO public.learning_resources
          (id, tenant_id, title, description, provider, url, estimated_minutes,
           is_archived, sort_order, created_by_membership_id, updated_by_membership_id,
           created_at, updated_at)
        VALUES (${id}, ${tid}, ${r.title}, ${r.description}, ${r.provider}, ${r.url},
                ${r.minutes}, false, ${n}, ${MEMBER.admin}, ${MEMBER.admin}, now(), now())
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title, description = EXCLUDED.description,
          provider = EXCLUDED.provider, url = EXCLUDED.url,
          estimated_minutes = EXCLUDED.estimated_minutes, updated_at = now()
      `;
      n += 1;
    }
    console.log(`  ✓ ${n} learning resources`);

    // ── 2. tracks + items ────────────────────────────────────────────────────
    let trackN = 0;
    let itemN = 0;
    for (const t of TRACKS) {
      let positionId: string | null = null;
      if (t.positionTitle) {
        const [pos] = await sql<{ id: string }[]>`
          SELECT p.id FROM public.positions p
           WHERE p.tenant_id = ${tid} AND p.title = ${t.positionTitle}
           ORDER BY p.created_at LIMIT 1
        `;
        if (!pos) {
          console.log(`  ! position "${t.positionTitle}" not found — skipping track ${t.key}`);
          continue;
        }
        positionId = pos.id;
      }
      const id = mkId(KIND.track, trackN);
      await sql`
        INSERT INTO public.learning_tracks
          (id, tenant_id, name, layer, business_unit_id, position_id, role_family,
           is_active, sort_order, created_by_membership_id, updated_by_membership_id,
           created_at, updated_at)
        VALUES (${id}, ${tid}, ${t.name}, ${t.layer}, NULL, ${positionId}, NULL,
                true, ${trackN}, ${MEMBER.admin}, ${MEMBER.admin}, now(), now())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, position_id = EXCLUDED.position_id, updated_at = now()
      `;
      let order = 0;
      for (const it of t.items) {
        const rid = resourceId.get(it.resource);
        if (!rid) continue;
        await sql`
          INSERT INTO public.learning_track_items
            (id, tenant_id, track_id, resource_id, sort_order, is_required,
             due_offset_days, created_at)
          VALUES (${mkId(KIND.trackItem, itemN)}, ${tid}, ${id}, ${rid}, ${order},
                  ${it.required}, ${it.dueOffsetDays}, now())
          ON CONFLICT (id) DO UPDATE SET
            sort_order = EXCLUDED.sort_order, is_required = EXCLUDED.is_required,
            due_offset_days = EXCLUDED.due_offset_days
        `;
        itemN += 1;
        order += 1;
      }
      trackN += 1;
    }
    console.log(`  ✓ ${trackN} tracks, ${itemN} track items`);

    // ── 3. skill map ─────────────────────────────────────────────────────────
    let mapN = 0;
    for (const m of SKILL_MAP) {
      let order = 0;
      for (const key of m.resources) {
        const rid = resourceId.get(key);
        if (!rid) continue;
        await sql`
          INSERT INTO public.learning_skill_map
            (id, tenant_id, skill_name, resource_id, sort_order,
             created_by_membership_id, updated_by_membership_id, created_at, updated_at)
          VALUES (${mkId(KIND.skillMap, mapN)}, ${tid}, ${m.skill}, ${rid}, ${order},
                  ${MEMBER.admin}, ${MEMBER.admin}, now(), now())
          ON CONFLICT (id) DO UPDATE SET
            skill_name = EXCLUDED.skill_name, resource_id = EXCLUDED.resource_id,
            sort_order = EXCLUDED.sort_order, updated_at = now()
        `;
        mapN += 1;
        order += 1;
      }
    }
    console.log(`  ✓ ${mapN} skill -> resource mappings across ${SKILL_MAP.length} skills`);

    // ── 4. onboarding cases for hires that HAVE parsed skills ────────────────
    //
    // Without this the suggestion engine has nothing to talk about: every
    // pre-existing case belongs to a candidate with no parsed_skills, so the
    // panel correctly (and uselessly, for a demo) says the CV could not be read.
    const hires = await sql<
      { application_id: string; candidate_id: string; requisition_id: string; full_name: string }[]
    >`
      SELECT a.id AS application_id, a.candidate_id, a.requisition_id, p.full_name
        FROM public.applications a
        JOIN public.candidates c ON c.id = a.candidate_id AND c.tenant_id = a.tenant_id
        JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
       WHERE a.tenant_id = ${tid}
         AND a.current_stage = 'offer_accepted'
         AND a.id::text LIKE ${`${ANALYTICS_PREFIX}-%`}
         AND jsonb_array_length(COALESCE(c.parsed_skills->'skills', '[]'::jsonb)) > 0
       ORDER BY a.requisition_id, a.created_at
    `;

    const perReq = new Map<string, number>();
    let caseN = 0;
    const created: { caseId: string; name: string }[] = [];
    for (const h of hires) {
      const seen = perReq.get(h.requisition_id) ?? 0;
      if (seen >= CASES_PER_REQ) continue;
      perReq.set(h.requisition_id, seen + 1);

      const caseId = mkId(KIND.onbCase, caseN);
      // Stagger starts so the list has pre-boarding, day-zero and in-progress.
      const startOffset = [10, -3, -20, 25, -12, 5, 18, -30][caseN % 8] ?? 10;
      const status =
        startOffset > 0 ? "pre_boarding" : startOffset > -14 ? "day_zero" : "in_progress";
      const start = new Date(Date.now() + startOffset * DAY_MS);
      const startIso = start.toISOString().slice(0, 10);
      const probationEnds = new Date(start.getTime() + PROBATION_DAYS * DAY_MS)
        .toISOString()
        .slice(0, 10);

      await sql`
        INSERT INTO public.onboarding_cases
          (id, tenant_id, application_id, candidate_id, status, geography_code,
           expected_start_date, actual_start_date, probation_days, probation_ends_at,
           buddy_membership_id, manager_membership_id, created_at, updated_at)
        VALUES (${caseId}, ${tid}, ${h.application_id}, ${h.candidate_id}, ${status}, 'IN',
                ${startIso}::date, ${status === "pre_boarding" ? null : startIso}::date,
                ${PROBATION_DAYS}, ${probationEnds}::date,
                ${MEMBER.panel}, ${MEMBER.hiringManager}, now(), now())
      `;

      // Document tasks straight from the reference catalogue, so the checklist
      // matches the production shape (mirror of ensureDocumentCollectionTasks).
      await sql`
        INSERT INTO public.onboarding_tasks
          (tenant_id, case_id, task_type, status, title, metadata)
        SELECT ${tid}, ${caseId}, 'document_collection', 'pending', dt.name,
               jsonb_build_object('documentTypeId', dt.id, 'documentTypeCode', dt.code,
                                  'geographyCode', dt.geography_code)
          FROM public.document_types dt
         WHERE dt.required_for_lifecycle_stage = 'pre_boarding'
           AND (dt.geography_code IS NULL OR dt.geography_code = 'IN')
      `;
      await sql`
        INSERT INTO public.onboarding_tasks (tenant_id, case_id, task_type, status, title)
        VALUES
          (${tid}, ${caseId}, 'it_provisioning', 'pending', 'Provision IT accounts, email, and equipment'),
          (${tid}, ${caseId}, 'buddy_assignment', 'pending', 'Assign an onboarding buddy'),
          (${tid}, ${caseId}, 'training', 'pending', 'Complete mandatory onboarding training')
      `;
      for (const day of CHECK_IN_DAYS) {
        await sql`
          INSERT INTO public.onboarding_tasks
            (tenant_id, case_id, task_type, status, title, due_at, metadata)
          VALUES (${tid}, ${caseId}, 'check_in', 'pending', ${`Day ${day} check-in`},
                  ${new Date(start.getTime() + day * DAY_MS).toISOString()}::timestamptz,
                  ${JSON.stringify({ checkInDay: day })}::jsonb)
        `;
      }
      await sql`
        INSERT INTO public.onboarding_tasks
          (tenant_id, case_id, task_type, status, title, due_at, metadata)
        VALUES (${tid}, ${caseId}, 'probation_review', 'pending', 'Probation review',
                ${new Date(start.getTime() + PROBATION_DAYS * DAY_MS).toISOString()}::timestamptz,
                ${JSON.stringify({ probationDays: PROBATION_DAYS })}::jsonb)
      `;

      // ── give this hire a REALISTIC skill gap ────────────────────────────────
      //
      // The analytics seed hands each candidate a prefix of their JD's skills
      // sized by AI score, and offer_accepted hires score 90-95 — so they come
      // out holding EVERY skill and the suggestion engine correctly finds
      // nothing to say. True to the scoring model, useless to demonstrate, and
      // not how hiring actually goes: an offer is a judgement that someone is
      // worth training, not that they already know everything.
      //
      // So trim their parsed skills to what a strong-but-real hire looks like:
      // the must-haves stay, the nice-to-haves come off. Every third hire also
      // loses their last REQUIRED skill, so the panel has required-gap rows
      // (which render differently) and not only nice-to-have ones.
      //
      // This edits `candidates.parsed_skills` on rows the ANALYTICS seed owns.
      // `--undo` here does not restore them — re-run db:seed:analytics-demo for
      // that; it upserts parsed_skills back to the score-derived prefix.
      const jdSkills = await sql<{ skill_name: string; is_required: boolean }[]>`
        SELECT s.skill_name, s.is_required
          FROM public.applications a
          JOIN public.requisitions r ON r.id = a.requisition_id
          JOIN public.jd_skills s ON s.jd_version_id = r.jd_version_id
         WHERE a.id = ${h.application_id} AND a.tenant_id = ${tid}
         ORDER BY s.is_required DESC, s.created_at, s.id
      `;
      // NB: ordered by the JD's own insert order, NOT alphabetically. A JD lists
      // its most central skill first, so the LAST required skill is the safest
      // one to take away. Sorting by name instead produced a Principal AI
      // Architect who could not write Python — technically a valid gap, and the
      // first thing a client would stop the demo to query.
      const dropRequired = caseN % 3 === 2;
      const requiredNames = jdSkills.filter((s) => s.is_required).map((s) => s.skill_name);
      const drop = new Set(
        [
          ...jdSkills.filter((s) => !s.is_required).map((s) => s.skill_name),
          ...(dropRequired && requiredNames.length > 1
            ? [requiredNames[requiredNames.length - 1] as string]
            : []),
        ].map((s) => s.toLowerCase()),
      );
      if (drop.size > 0) {
        await sql`
          UPDATE public.candidates
             SET parsed_skills = jsonb_set(
                   parsed_skills, '{skills}',
                   COALESCE((
                     SELECT jsonb_agg(v) FROM jsonb_array_elements_text(parsed_skills->'skills') AS t(v)
                      WHERE lower(v) <> ALL(${Array.from(drop)}::text[])
                   ), '[]'::jsonb)
                 ),
                 updated_at = now()
           WHERE id = ${h.candidate_id} AND tenant_id = ${tid}
        `;
      }

      created.push({ caseId, name: h.full_name });
      caseN += 1;
    }
    console.log(`  ✓ ${caseN} onboarding cases for hires WITH parsed skills`);

    // ── 5. pre-push the induction onto ONE case ──────────────────────────────
    //
    // So /candidate/learning has something to show without anyone clicking
    // first. Every other case is left empty ON PURPOSE — the push is the thing
    // worth demonstrating live, and pre-doing it everywhere would hide it.
    const first = created[0];
    if (first) {
      const inductionId = mkId(KIND.track, 0);
      const items = await sql<
        { resource_id: string; is_required: boolean; due_offset_days: number | null }[]
      >`
        SELECT resource_id, is_required, due_offset_days
          FROM public.learning_track_items
         WHERE tenant_id = ${tid} AND track_id = ${inductionId}
         ORDER BY sort_order
      `;
      for (const it of items) {
        const [res] = await sql<{ title: string; url: string; provider: string }[]>`
          SELECT title, url, provider FROM public.learning_resources
           WHERE tenant_id = ${tid} AND id = ${it.resource_id} LIMIT 1
        `;
        if (!res) continue;
        await sql`
          INSERT INTO public.onboarding_tasks
            (tenant_id, case_id, task_type, status, title, due_at, metadata)
          VALUES (${tid}, ${first.caseId}, 'orientation', 'pending', ${res.title},
                  ${it.due_offset_days == null ? null : new Date(Date.now() + it.due_offset_days * DAY_MS).toISOString()}::timestamptz,
                  ${JSON.stringify({
                    learningResourceId: it.resource_id,
                    trackId: inductionId,
                    layer: "organisation",
                    url: res.url,
                    provider: res.provider,
                  })}::jsonb)
        `;
      }
      console.log(`  ✓ induction pre-pushed onto ${first.name}'s case (the rest left empty)`);
    }

    console.log("\nL&D demo data seeded. Undo with: pnpm db:seed:learning-demo -- --undo");
  } finally {
    await sql.end({ timeout: 10 });
  }
}

/** FK-safe teardown of everything this seed owns. Learning tasks are matched by
 * their case, plus any this seed pushed onto a case it created. */
async function deleteSeededRows(sql: SqlClient, tid: string): Promise<void> {
  const pfx = `${ID_PREFIX}-%`;
  await sql`
    DELETE FROM public.onboarding_tasks
     WHERE tenant_id = ${tid} AND case_id IN (
       SELECT id FROM public.onboarding_cases WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}
     )
  `;
  // Release the offboarding back-reference BEFORE deleting the cases it points
  // at. fk_offboarding_cases_onboarding_case (0059) is ON DELETE RESTRICT, so
  // without this the whole teardown — and therefore every re-seed — dies with a
  // 23503 the moment anything links an offboarding case to one of ours. That is
  // not hypothetical: db:seed:offboard-demo links its cases to onboarding rows
  // this seed owns, so running the documented seed order twice was enough to
  // wedge it permanently.
  //
  // NULL rather than DELETE, deliberately. The offboarding case belongs to a
  // DIFFERENT seed; deleting it here would have one seed's teardown silently
  // destroying another's data. The column is nullable and the FK is compound
  // (MATCH SIMPLE), so a NULL leg simply stops the constraint applying — the
  // offboarding case survives, having lost only a pointer to an onboarding
  // case that is itself about to stop existing.
  await sql`
    UPDATE public.offboarding_cases
       SET onboarding_case_id = NULL
     WHERE tenant_id = ${tid}
       AND onboarding_case_id::text LIKE ${pfx}
  `;
  await sql`DELETE FROM public.onboarding_cases WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.learning_skill_map WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.learning_track_items WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.learning_tracks WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.learning_resources WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
}

async function runUndo(sql: SqlClient, tid: string): Promise<void> {
  console.log(`Removing L&D demo data from ${TENANT_SLUG} (${tid})`);
  await deleteSeededRows(sql, tid);
  console.log("  ✓ removed every 0000ed00-* row (catalogue, tracks, skill map, cases + tasks)");
  console.log(
    "  ! learning pushed onto cases this seed did NOT create is left alone — those are real pushes.",
  );
}

main().catch((err) => {
  console.error("seed-learning-demo failed:", err);
  process.exit(1);
});
