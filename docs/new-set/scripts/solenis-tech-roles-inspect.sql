-- STEP 1 — READ-ONLY. Paste into the Supabase SQL editor of the SOLENIS project and Run.
-- Lists technical-role data on the Solenis tenant. Nothing in this script writes.
-- One result grid: `section` says what each row is. Review it before STEP 2.

WITH t AS (
  SELECT id FROM public.tenants
  WHERE slug IN ('solenis', 'kyndryl-poc') OR display_name ILIKE '%solenis%'
),
pat AS (
  SELECT '(engineer|developer|devops|site reliability|\msre\M|backend|frontend|full[ -]?stack|software|data platform|data scientist|machine learning|\mml\M|quality assurance|\mqa\M|tester|product designer|cloud|platform)'::text AS re
)
SELECT '1 tech requisition' AS section,
       p.title,
       r.status AS status,
       r.id::text AS id,
       concat_ws(' · ',
         (SELECT count(*) FROM public.applications a WHERE a.requisition_id = r.id) || ' applications',
         (SELECT count(*) FROM public.applications a JOIN public.interviews i ON i.application_id = a.id
            WHERE a.requisition_id = r.id) || ' interviews',
         (SELECT count(*) FROM public.applications a JOIN public.offers o ON o.application_id = a.id
            WHERE a.requisition_id = r.id) || ' offers',
         (SELECT count(*) FROM public.applications a JOIN public.onboarding_cases oc ON oc.application_id = a.id
            WHERE a.requisition_id = r.id) || ' onboarding cases') AS detail
FROM public.requisitions r
JOIN public.positions p ON p.id = r.position_id
WHERE r.tenant_id IN (SELECT id FROM t) AND p.title ~* (SELECT re FROM pat)

UNION ALL
SELECT '2 tech JD template', jt.title, NULL, jt.id::text, 'label: ' || jt.label
FROM public.jd_templates jt
WHERE jt.tenant_id IN (SELECT id FROM t)
  AND (jt.title ~* (SELECT re FROM pat) OR jt.label ~* (SELECT re FROM pat))

UNION ALL
SELECT '3 tech market benchmark', mb.role_title, NULL, mb.id::text, NULL
FROM public.market_benchmarks mb
WHERE mb.tenant_id IN (SELECT id FROM t) AND mb.role_title ~* (SELECT re FROM pat)

UNION ALL
SELECT '4 KEPT (not matched) — check for misses', p.title, r.status, NULL,
       count(*) || ' requisition(s)'
FROM public.requisitions r
JOIN public.positions p ON p.id = r.position_id
WHERE r.tenant_id IN (SELECT id FROM t) AND p.title !~* (SELECT re FROM pat)
GROUP BY p.title, r.status

ORDER BY 1, 2;
