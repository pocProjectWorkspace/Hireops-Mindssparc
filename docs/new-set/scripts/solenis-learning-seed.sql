-- WRITES. Learning catalogue for the Solenis tenant: non-technical, GBS-shaped.
--   * archives the NovaChem / engineering resources and deactivates their tracks
--     (archived, not deleted, so existing onboarding assignments keep resolving);
--   * adds a Solenis GBS induction track + finance, supply-chain and HR role tracks;
--   * binds a Record-to-Report track to the "Record-to-Report (R2R) Lead" position;
--   * maps finance skills to resources (used by skill-gap suggestions).
-- Every URL is a PLACEHOLDER (https://learning.example.com/…) — replace with real
-- Solenis SharePoint / Workday Learning links when available.
-- Idempotent: fixed ids derived from md5(key); re-running updates in place.
-- One transaction.

BEGIN;

SELECT set_config('app.source', 'manual_seed_solenis_learning', true);

CREATE TEMP TABLE _t ON COMMIT DROP AS
SELECT id FROM public.tenants
WHERE slug IN ('solenis', 'kyndryl-poc') OR display_name ILIKE '%solenis%'
LIMIT 1;

-- 1. Retire the engineering / NovaChem catalogue.
UPDATE public.learning_resources r
SET is_archived = true, updated_at = now()
WHERE r.tenant_id = (SELECT id FROM _t)
  AND r.is_archived = false
  AND (r.title ~* '\m(kubernetes|mlops|aws|generative ai|llm|python|machine learning|java|spring|kafka|postgres|sql|spark|airflow|dbt|novachem)\M'
       OR r.url ~* 'novachem');

UPDATE public.learning_tracks t
SET is_active = false, updated_at = now()
WHERE t.tenant_id = (SELECT id FROM _t)
  AND t.is_active = true
  AND t.name ~* '(novachem|engineer|architect|data platform|backend|frontend)';

-- 2. Resources.
CREATE TEMP TABLE _res (key text, title text, description text, provider text, minutes int, sort int) ON COMMIT DROP;
INSERT INTO _res VALUES
  -- organisation induction
  ('welcome',        'Welcome to Solenis GBS Hyderabad',            'Who we are, what the GBS centre delivers for Solenis businesses worldwide, and how your work fits in.', 'internal_doc',      30, 10),
  ('conduct',        'Solenis Code of Conduct',                      'Our standards for integrity, fair dealing and speaking up.',                                          'workday_learning',  45, 20),
  ('posh',           'Prevention of Sexual Harassment (POSH)',       'Mandatory awareness training under the POSH Act, 2013, and how to raise a concern.',                  'workday_learning',  40, 30),
  ('privacy',        'Data privacy and the DPDP Act',                'Handling personal data at Solenis under India''s Digital Personal Data Protection Act.',              'workday_learning',  30, 40),
  ('infosec',        'Information security essentials',              'Phishing, passwords, classification and safe handling of company data.',                             'workday_learning',  30, 50),
  ('ways',           'Ways of working in GBS',                       'Service catalogue, SLAs, ticketing, escalation paths and stakeholder etiquette across time zones.',    'internal_doc',      45, 60),
  ('workday-nav',    'Navigating Workday as a new joiner',           'Profile, time off, payslips, learning and your onboarding tasks in Workday.',                         'workday_learning',  20, 70),
  -- finance
  ('r2r',            'Record-to-Report fundamentals',                'The R2R cycle end to end: journals, accruals, reconciliations, close and reporting.',                 'linkedin_learning', 90, 110),
  ('close',          'Running a clean month-end close',              'Close calendars, checklists, cut-off, review and reducing close days.',                               'linkedin_learning', 60, 120),
  ('recon',          'Balance-sheet reconciliations that pass audit','Reconciliation standards, aging, ownership and evidence.',                                            'internal_doc',      45, 130),
  ('sap-fico',       'SAP S/4HANA Finance (FI/CO) overview',         'GL, AP, AR, asset accounting and controlling in S/4HANA, with Solenis entity structure.',             'linkedin_learning', 120, 140),
  ('indas',          'IFRS and Ind AS essentials',                   'Key differences, revenue recognition and lease accounting for shared-services finance.',              'linkedin_learning', 90, 150),
  ('sox',            'SOX and internal controls in shared services', 'Control design, evidence, testing cycles and working with internal audit.',                           'internal_doc',      45, 160),
  ('p2p',            'Procure-to-Pay process',                       'Purchase requisition to payment: 3-way match, vendor master, exceptions and payment runs.',           'linkedin_learning', 60, 170),
  ('o2c',            'Order-to-Cash process',                        'Order, billing, cash application, collections and dispute management.',                               'linkedin_learning', 60, 180),
  ('excel-fin',      'Excel for finance professionals',              'Lookups, pivot tables, power query and reconciliation workbooks.',                                    'linkedin_learning', 90, 190),
  ('powerbi-fin',    'Power BI for finance reporting',               'Building finance dashboards and variance reports from SAP extracts.',                                  'linkedin_learning', 90, 200),
  -- supply chain
  ('sc-planning',    'Demand and supply planning basics',            'Forecasting, S&OP, inventory policy and service levels.',                                             'linkedin_learning', 75, 310),
  ('sc-sap-mm',      'SAP MM for supply-chain teams',                'Material master, purchasing and inventory management in SAP.',                                        'linkedin_learning', 90, 320),
  -- HR
  ('hr-ops',         'HR operations in a GBS',                       'Employee lifecycle transactions, case management and data quality in Workday.',                       'internal_doc',      60, 410),
  ('hr-policies',    'Solenis India HR policies',                    'Leave, attendance, benefits and statutory compliance (PF, ESIC, gratuity).',                          'internal_doc',      45, 420);

INSERT INTO public.learning_resources
  (id, tenant_id, title, description, provider, url, estimated_minutes, is_archived, sort_order)
SELECT md5('solenis-learning-res-' || r.key)::uuid, (SELECT id FROM _t), r.title,
       r.description || ' (Placeholder link.)', r.provider,
       'https://learning.example.com/solenis/' || r.key, r.minutes, false, r.sort
FROM _res r
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, description = EXCLUDED.description, provider = EXCLUDED.provider,
  url = EXCLUDED.url, estimated_minutes = EXCLUDED.estimated_minutes,
  is_archived = false, sort_order = EXCLUDED.sort_order, updated_at = now();

-- 3. Tracks. Organisation track has no binding; role tracks bind to a role family,
--    except R2R, which binds to the R2R Lead position when it exists.
CREATE TEMP TABLE _trk (key text, name text, layer text, role_family text, position_title text, sort int) ON COMMIT DROP;
INSERT INTO _trk VALUES
  ('induction',  'Solenis GBS induction',                 'organisation', NULL,             NULL,                          10),
  ('r2r',        'Finance — Record to Report ramp-up',    'role',         NULL,             'Record-to-Report (R2R) Lead', 20),
  ('finance',    'Finance — accounting essentials',       'role',         'Finance',        NULL,                          30),
  ('p2p-o2c',    'Finance — P2P and O2C ramp-up',         'role',         'Finance operations', NULL,                      40),
  ('supply',     'Supply chain — planning ramp-up',       'role',         'Supply chain',   NULL,                          50),
  ('hr',         'HR operations ramp-up',                 'role',         'HR',             NULL,                          60);

INSERT INTO public.learning_tracks
  (id, tenant_id, name, layer, business_unit_id, position_id, role_family, is_active, sort_order)
SELECT md5('solenis-learning-trk-' || k.key)::uuid, (SELECT id FROM _t), k.name, k.layer, NULL,
       p.id,
       CASE WHEN k.layer = 'role' AND p.id IS NULL THEN COALESCE(k.role_family, 'Finance') ELSE NULL END,
       true, k.sort
FROM _trk k
LEFT JOIN LATERAL (
  SELECT pp.id FROM public.positions pp
  WHERE pp.tenant_id = (SELECT id FROM _t) AND k.position_title IS NOT NULL AND pp.title = k.position_title
  ORDER BY pp.created_at LIMIT 1
) p ON true
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, layer = EXCLUDED.layer, position_id = EXCLUDED.position_id,
  role_family = EXCLUDED.role_family, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();

-- 4. Track items.
CREATE TEMP TABLE _items (track text, res text, required boolean, due int, sort int) ON COMMIT DROP;
INSERT INTO _items VALUES
  ('induction','welcome',true,3,1), ('induction','conduct',true,5,2), ('induction','posh',true,7,3),
  ('induction','privacy',true,7,4), ('induction','infosec',true,7,5), ('induction','ways',false,14,6),
  ('induction','workday-nav',false,3,7),
  ('r2r','r2r',true,14,1), ('r2r','close',true,21,2), ('r2r','recon',true,21,3),
  ('r2r','sap-fico',true,30,4), ('r2r','indas',false,45,5), ('r2r','sox',true,30,6),
  ('finance','excel-fin',true,14,1), ('finance','sap-fico',true,30,2), ('finance','powerbi-fin',false,45,3),
  ('p2p-o2c','p2p',true,14,1), ('p2p-o2c','o2c',true,14,2), ('p2p-o2c','sap-fico',false,30,3),
  ('supply','sc-planning',true,14,1), ('supply','sc-sap-mm',true,30,2), ('supply','excel-fin',false,30,3),
  ('hr','hr-ops',true,14,1), ('hr','hr-policies',true,7,2), ('hr','workday-nav',true,3,3);

INSERT INTO public.learning_track_items
  (id, tenant_id, track_id, resource_id, sort_order, is_required, due_offset_days)
SELECT md5('solenis-learning-item-' || i.track || '-' || i.res)::uuid, (SELECT id FROM _t),
       md5('solenis-learning-trk-' || i.track)::uuid, md5('solenis-learning-res-' || i.res)::uuid,
       i.sort, i.required, i.due
FROM _items i
ON CONFLICT (id) DO UPDATE SET
  sort_order = EXCLUDED.sort_order, is_required = EXCLUDED.is_required,
  due_offset_days = EXCLUDED.due_offset_days;

-- 5. Skill → resource map (skill-gap suggestions for the finance roles).
CREATE TEMP TABLE _skills (skill text, res text, sort int) ON COMMIT DROP;
INSERT INTO _skills VALUES
  ('Record to Report (R2R)','r2r',1), ('Month-end close','close',1), ('Account reconciliations','recon',1),
  ('SAP FI/CO','sap-fico',1), ('IFRS / Ind AS','indas',1), ('SOX controls','sox',1),
  ('Procure to Pay (P2P)','p2p',1), ('Order to Cash (O2C)','o2c',1), ('Advanced Excel','excel-fin',1),
  ('Power BI','powerbi-fin',1), ('Demand planning','sc-planning',1), ('SAP MM','sc-sap-mm',1);

INSERT INTO public.learning_skill_map (id, tenant_id, skill_name, resource_id, sort_order)
SELECT md5('solenis-learning-skill-' || s.skill)::uuid, (SELECT id FROM _t), s.skill,
       md5('solenis-learning-res-' || s.res)::uuid, s.sort
FROM _skills s
ON CONFLICT (id) DO UPDATE SET resource_id = EXCLUDED.resource_id, sort_order = EXCLUDED.sort_order;

COMMIT;
