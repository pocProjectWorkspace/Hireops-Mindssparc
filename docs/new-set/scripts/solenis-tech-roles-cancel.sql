-- STEP 2 — WRITES. Run only after reviewing STEP 1 (solenis-tech-roles-inspect.sql),
-- which is the preview: it lists exactly the rows this script touches.
--
-- Solenis India hires no technical roles. This, as ONE atomic statement:
--   * CANCELS the leftover technical requisitions (they drop out of active lists;
--     their candidates, interviews and offers stay intact for history), logging a
--     status transition for each, the same way the app does;
--   * DELETES technical JD templates and market-benchmark rows (configuration
--     only, nothing hangs off them).
-- The result grid lists every change. The existing audit trigger records each
-- row change, tagged source = manual_cleanup_tech_roles_solenis.
--
-- Keep the word pattern identical to STEP 1. Techno-functional roles (SAP,
-- cybersecurity, infra, Workday, Salesforce) are deliberately NOT matched.

WITH cfg AS (
  SELECT set_config('app.source', 'manual_cleanup_tech_roles_solenis', true) AS v
),
scope AS (
  SELECT id FROM public.tenants
  WHERE slug IN ('solenis', 'kyndryl-poc') OR display_name ILIKE '%solenis%'
),
pat AS (
  SELECT '(engineer|developer|devops|site reliability|\msre\M|backend|frontend|full[ -]?stack|software|data platform|data scientist|machine learning|\mml\M|quality assurance|\mqa\M|tester|product designer|cloud|platform)'::text AS re
),
target AS (
  SELECT r.id, r.tenant_id, r.status AS from_status, p.title
  FROM public.requisitions r
  JOIN public.positions p ON p.id = r.position_id
  WHERE r.tenant_id IN (SELECT id FROM scope)
    AND p.title ~* (SELECT re FROM pat)
    AND r.status NOT IN ('cancelled', 'closed', 'filled')
),
logged AS (
  INSERT INTO public.requisition_state_transitions
    (tenant_id, requisition_id, from_status, to_status, reason, metadata)
  SELECT tenant_id, id, from_status, 'cancelled',
         'Cleanup: Solenis India does not hire technical roles (leftover generic demo data)',
         jsonb_build_object('source', 'manual_cleanup', 'title', title)
  FROM target
  RETURNING requisition_id
),
cancelled AS (
  UPDATE public.requisitions r
  SET status = 'cancelled', updated_at = now()
  FROM target x
  WHERE r.id = x.id
  RETURNING r.id, x.title, x.from_status
),
del_jd AS (
  DELETE FROM public.jd_templates jt
  WHERE jt.tenant_id IN (SELECT id FROM scope)
    AND (jt.title ~* (SELECT re FROM pat) OR jt.label ~* (SELECT re FROM pat))
  RETURNING jt.title
),
del_mb AS (
  DELETE FROM public.market_benchmarks mb
  WHERE mb.tenant_id IN (SELECT id FROM scope)
    AND mb.role_title ~* (SELECT re FROM pat)
  RETURNING mb.role_title
)
SELECT 'cancelled requisition' AS change, title, from_status || ' → cancelled' AS detail
FROM cancelled, cfg
UNION ALL
SELECT 'deleted JD template', title, NULL FROM del_jd, cfg
UNION ALL
SELECT 'deleted market benchmark', role_title, NULL FROM del_mb, cfg
UNION ALL
SELECT 'transitions logged', count(*)::text, NULL FROM logged
ORDER BY 1, 2;
