-- READ-ONLY. Where does tech-specific text live under the Senior Backend Engineer
-- requisition (a5c0)? One row per table: total rows, rows mentioning tech words,
-- and one sample snippet. Used to scope the "move this history onto a GBS role" update.
WITH r AS (
  SELECT id, position_id FROM public.requisitions WHERE id = '00000000-0000-4000-8000-00000000a5c0'
),
apps AS (SELECT a.* FROM public.applications a WHERE a.requisition_id = (SELECT id FROM r)),
ivs AS (SELECT i.* FROM public.interviews i WHERE i.application_id IN (SELECT id FROM apps)),
cases AS (SELECT oc.* FROM public.onboarding_cases oc WHERE oc.application_id IN (SELECT id FROM apps)),
jdv AS (SELECT v.* FROM public.jd_versions v WHERE v.position_id = (SELECT position_id FROM r)),
pat AS (
  SELECT '\m(java|spring|kafka|postgres|aws|kubernetes|docker|microservice|backend|frontend|react|typescript|python|golang|api|distributed|devops|sre|cloud|engineer|coding|code review|system design|algorithm|bengaluru)\M'::text AS re
),
rows AS (
  SELECT 'positions' AS tbl, row_to_json(x)::text AS j FROM public.positions x WHERE x.id = (SELECT position_id FROM r)
  UNION ALL SELECT 'jd_versions', row_to_json(x)::text FROM jdv x
  UNION ALL SELECT 'jd_skills', row_to_json(x)::text FROM public.jd_skills x WHERE x.jd_version_id IN (SELECT id FROM jdv)
  UNION ALL SELECT 'interview_plans', row_to_json(x)::text FROM public.interview_plans x WHERE x.requisition_id = (SELECT id FROM r)
  UNION ALL SELECT 'applications', row_to_json(x)::text FROM apps x
  UNION ALL SELECT 'candidates', row_to_json(x)::text FROM public.candidates x WHERE x.id IN (SELECT candidate_id FROM apps)
  UNION ALL SELECT 'interviews', row_to_json(x)::text FROM ivs x
  UNION ALL SELECT 'interview_feedback', row_to_json(x)::text FROM public.interview_feedback x WHERE x.interview_id IN (SELECT id FROM ivs)
  UNION ALL SELECT 'interview_notes', row_to_json(x)::text FROM public.interview_notes x WHERE x.interview_id IN (SELECT id FROM ivs)
  UNION ALL SELECT 'interview_prep', row_to_json(x)::text FROM public.interview_prep x WHERE x.interview_id IN (SELECT id FROM ivs)
  UNION ALL SELECT 'recruiter_brief', row_to_json(x)::text FROM public.recruiter_brief x WHERE x.application_id IN (SELECT id FROM apps)
  UNION ALL SELECT 'hr_round_assessments', row_to_json(x)::text FROM public.hr_round_assessments x WHERE x.application_id IN (SELECT id FROM apps)
  UNION ALL SELECT 'hr_case_notes', row_to_json(x)::text FROM public.hr_case_notes x WHERE x.application_id IN (SELECT id FROM apps)
  UNION ALL SELECT 'comp_recommendations', row_to_json(x)::text FROM public.comp_recommendations x WHERE x.application_id IN (SELECT id FROM apps)
  UNION ALL SELECT 'offers', row_to_json(x)::text FROM public.offers x WHERE x.application_id IN (SELECT id FROM apps)
  UNION ALL SELECT 'onboarding_cases', row_to_json(x)::text FROM cases x
  UNION ALL SELECT 'onboarding_tasks', row_to_json(x)::text FROM public.onboarding_tasks x WHERE x.case_id IN (SELECT id FROM cases)
)
SELECT tbl,
       count(*) AS total_rows,
       count(*) FILTER (WHERE j ~* (SELECT re FROM pat)) AS rows_with_tech_text,
       left(min(substring(j FROM '(?i).{0,70}' || (SELECT re FROM pat) || '.{0,70}')), 160) AS sample
FROM rows
GROUP BY tbl
ORDER BY rows_with_tech_text DESC, tbl;
