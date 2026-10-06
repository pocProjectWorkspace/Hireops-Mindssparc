-- WRITES. Makes Naveen Nair (Non-SAP Plant Accountant, Round 2 HR round,
-- interview 0000ad00-0000-4000-8000-060000000037) a realistic Round-2 candidate:
--   1. a parsed CV that matches 4 of the 5 JD must-haves (Advanced Excel, Cost
--      Accounting, Month-End Close, Plant Accounting — 80%; Internal Controls
--      shows only as "SOX testing support", the gap Round 1 flags), 11 years in
--      plant / cost accounting;
--   2. a COMPLETED Round 1 (functional) with two submitted panel scorecards
--      (both "yes"), so the Round-2 brief shows "Previous rounds".
-- Panelists for Round 1 = two other Solenis members (hiring manager / recruiter
-- roles first), never the demo admin, so the feedback reads as other people's.
-- One transaction. Re-running is safe: Round 1 is reused, feedback upserted.

BEGIN;

SELECT set_config('app.source', 'manual_seed_naveen_nair_demo', true);

CREATE TEMP TABLE _r2 ON COMMIT DROP AS
SELECT i.id, i.tenant_id, i.application_id, i.requisition_id, i.scorecard_template,
       i.scorecard_criteria_snapshot, i.created_by_membership_id, i.scheduled_start
FROM public.interviews i
WHERE i.id = '0000ad00-0000-4000-8000-060000000037';

CREATE TEMP TABLE _cand ON COMMIT DROP AS
SELECT a.candidate_id AS id FROM public.applications a WHERE a.id = (SELECT application_id FROM _r2);

-- 1. Parsed CV (object shape used across the platform; the brief now reads it).
UPDATE public.candidates c
SET parsed_skills = COALESCE(CASE WHEN jsonb_typeof(c.parsed_skills) = 'object' THEN c.parsed_skills END, '{}'::jsonb)
  || jsonb_build_object(
    'skills', '["Plant Accounting","Cost Accounting","Month-End Close","Advanced Excel","Inventory Valuation","Standard Costing","Fixed Asset Accounting","Variance Analysis","Oracle Financials","SOX testing support"]'::jsonb,
    'notice_period_days', 60,
    'summary', '11 years in plant and cost accounting for specialty-chemicals and FMCG manufacturing sites; owns month-end close, standard costing and inventory valuation for two plants.',
    'work_history', '[
      {"company":"Aarti Industries","title":"Senior Plant Accountant","start_date":"2020-04","end_date":null,
       "highlights":["Owns month-end close for two chemical plants; close cut from 6 to 4 working days","Runs standard-cost roll-ups and monthly variance analysis (price, usage, yield) for 400+ SKUs","Supports SOX walkthroughs and control testing for inventory and fixed assets"]},
      {"company":"Asian Paints","title":"Cost Accountant","start_date":"2016-07","end_date":"2020-03",
       "highlights":["Built the plant cost model in Excel feeding the annual budget","Reconciled inventory sub-ledger to GL monthly; resolved valuation differences"]},
      {"company":"Deloitte (audit)","title":"Audit Associate","start_date":"2014-08","end_date":"2016-06",
       "highlights":["Statutory audits of manufacturing clients: inventory, fixed assets and cost records"]}
    ]'::jsonb,
    'education', '[{"institution":"Osmania University","degree":"B.Com; Cost & Management Accountant (ICMAI)","graduated":"2014"}]'::jsonb),
  years_of_experience = 11,
  experience_summary = '11 yrs plant & cost accounting — month-end close, standard costing, inventory valuation (2 plants)',
  updated_at = now()
WHERE c.id = (SELECT id FROM _cand);

-- 2. Round 1: reuse an existing round-1 interview for this application, else create one.
CREATE TEMP TABLE _r1 ON COMMIT DROP AS
SELECT i.id FROM public.interviews i
WHERE i.application_id = (SELECT application_id FROM _r2) AND i.round_number = 1
LIMIT 1;

INSERT INTO public.interviews
  (tenant_id, application_id, requisition_id, round_number, round_name, status,
   scorecard_template, scorecard_criteria_snapshot, scheduled_start, scheduled_end,
   duration_minutes, mode, completed_at, created_by_membership_id)
SELECT r.tenant_id, r.application_id, r.requisition_id, 1, 'Round 1: Functional (plant accounting)', 'completed',
       r.scorecard_template, r.scorecard_criteria_snapshot,
       COALESCE(r.scheduled_start, now()) - interval '6 days',
       COALESCE(r.scheduled_start, now()) - interval '6 days' + interval '60 minutes',
       60, 'video', COALESCE(r.scheduled_start, now()) - interval '6 days' + interval '60 minutes',
       r.created_by_membership_id
FROM _r2 r
WHERE NOT EXISTS (SELECT 1 FROM _r1)
RETURNING id;

INSERT INTO _r1
SELECT i.id FROM public.interviews i
WHERE i.application_id = (SELECT application_id FROM _r2) AND i.round_number = 1
  AND NOT EXISTS (SELECT 1 FROM _r1)
LIMIT 1;

UPDATE public.interviews i
SET status = 'completed',
    round_name = 'Round 1: Functional (plant accounting)',
    completed_at = COALESCE(i.completed_at, COALESCE(i.scheduled_end, now() - interval '6 days')),
    scorecard_template = COALESCE(i.scorecard_template, (SELECT scorecard_template FROM _r2)),
    scorecard_criteria_snapshot = COALESCE(i.scorecard_criteria_snapshot, (SELECT scorecard_criteria_snapshot FROM _r2)),
    updated_at = now()
WHERE i.id = (SELECT id FROM _r1);

-- Two Round-1 panelists: other Solenis members, hiring managers / recruiters first.
CREATE TEMP TABLE _panel ON COMMIT DROP AS
SELECT m.id, row_number() OVER (
         ORDER BY ('hiring_manager' = ANY (m.roles::text[])) DESC,
                  ('recruiter' = ANY (m.roles::text[])) DESC, m.created_at) AS k
FROM public.tenant_user_memberships m
WHERE m.tenant_id = (SELECT tenant_id FROM _r2)
  AND NOT ('admin' = ANY (m.roles::text[]))
  AND NOT ('candidate' = ANY (m.roles::text[]))
  AND NOT ('partner_user' = ANY (m.roles::text[]))
  AND NOT ('partner_admin' = ANY (m.roles::text[]))
LIMIT 2;

INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
SELECT (SELECT tenant_id FROM _r2), (SELECT id FROM _r1), p.id, p.k = 1
FROM _panel p
WHERE NOT EXISTS (SELECT 1 FROM public.interview_panelists x
                  WHERE x.interview_id = (SELECT id FROM _r1) AND x.membership_id = p.id);

-- Submitted scorecards: every criterion of the round's template, 4s with one 5 / one 3.
INSERT INTO public.interview_feedback
  (tenant_id, interview_id, membership_id, scorecard, strengths, concerns, notes, recommendation, submitted_at)
SELECT (SELECT tenant_id FROM _r2), (SELECT id FROM _r1), p.id,
       COALESCE((SELECT jsonb_object_agg(c->>'key',
                    CASE WHEN o = 1 THEN 5 WHEN o = 3 AND p.k = 2 THEN 3 ELSE 4 END)
                 FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof((SELECT scorecard_criteria_snapshot FROM _r2)) = 'array'
                             THEN (SELECT scorecard_criteria_snapshot FROM _r2) ELSE '[]'::jsonb END)
                      WITH ORDINALITY AS e(c, o)), '{}'::jsonb),
       CASE p.k WHEN 1 THEN
         'Very strong on plant accounting: walked through a full month-end close for two sites, standard-cost roll-up and how he investigates usage and yield variances. Clear, structured answers.'
       ELSE
         'Hands-on with inventory valuation and fixed assets; good examples of reconciling the inventory sub-ledger to GL and fixing valuation differences. Strong Excel modelling.' END,
       CASE p.k WHEN 1 THEN
         'Internal controls exposure is supporting SOX testing rather than owning controls — worth probing in the HR / stakeholder round.'
       ELSE
         'Has worked on Oracle, not SAP; will need SAP FI/CO ramp-up in the first 60 days.' END,
       NULL, 'yes',
       (SELECT completed_at FROM public.interviews WHERE id = (SELECT id FROM _r1)) + (p.k || ' hours')::interval
FROM _panel p
ON CONFLICT (tenant_id, interview_id, membership_id) DO UPDATE SET
  scorecard = EXCLUDED.scorecard, strengths = EXCLUDED.strengths, concerns = EXCLUDED.concerns,
  recommendation = EXCLUDED.recommendation, submitted_at = EXCLUDED.submitted_at, updated_at = now();

COMMIT;
