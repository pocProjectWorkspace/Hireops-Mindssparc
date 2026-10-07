-- WRITES. Resets the "Import from Workday" PoC preview after a rehearsal, so the
-- live click on stage creates the 3 sample drafts fresh.
-- For every requisition created by the preview import (provenance on its
-- creating state transition, source = workday_import_preview), as one statement:
--   * cancels the requisition (logged as a status transition, like the app);
--   * retires its position, so re-importing the same title is not blocked by
--     the "active position with this title already exists" check;
--   * removes the Workday tag from the provenance transition, so the preview
--     no longer shows the row as "Already imported".
-- Nothing is deleted. Returns one row per reset requisition.

WITH cfg AS (
  SELECT set_config('app.source', 'manual_reset_workday_import_preview', true) AS v
),
scope AS (
  SELECT id FROM public.tenants
  WHERE slug IN ('solenis', 'kyndryl-poc') OR display_name ILIKE '%solenis%'
),
tagged AS (
  SELECT t.id AS transition_id, t.requisition_id, t.tenant_id,
         t.metadata->>'workdayJobRequisitionId' AS jr_id
  FROM public.requisition_state_transitions t
  WHERE t.tenant_id IN (SELECT id FROM scope)
    AND t.metadata->>'source' = 'workday_import_preview'
),
reqs AS (
  SELECT DISTINCT r.id, r.tenant_id, r.status, r.position_id, tg.jr_id
  FROM public.requisitions r
  JOIN tagged tg ON tg.requisition_id = r.id
),
logged AS (
  INSERT INTO public.requisition_state_transitions
    (tenant_id, requisition_id, from_status, to_status, reason, metadata)
  SELECT tenant_id, id, status, 'cancelled',
         'Reset after demo rehearsal (Workday import preview)',
         jsonb_build_object('source', 'manual_reset', 'workdayJobRequisitionId', jr_id)
  FROM reqs
  WHERE status NOT IN ('cancelled', 'closed', 'filled')
  RETURNING requisition_id
),
cancelled AS (
  UPDATE public.requisitions r
  SET status = 'cancelled', updated_at = now()
  FROM reqs x
  WHERE r.id = x.id AND r.status NOT IN ('cancelled', 'closed', 'filled')
  RETURNING r.id
),
retired AS (
  UPDATE public.positions p
  SET is_active = false, retired_at = now(), updated_at = now()
  FROM reqs x
  WHERE p.id = x.position_id AND p.is_active = true
  RETURNING p.id
),
untagged AS (
  UPDATE public.requisition_state_transitions t
  SET metadata = (t.metadata - 'source' - 'workdayJobRequisitionId')
                 || jsonb_build_object('resetFromSource', 'workday_import_preview',
                                       'resetWorkdayJobRequisitionId', t.metadata->>'workdayJobRequisitionId')
  FROM tagged tg
  WHERE t.id = tg.transition_id
  RETURNING t.id
)
SELECT x.jr_id, x.id AS requisition_id, x.status AS status_before,
       (SELECT count(*) FROM cancelled) AS requisitions_cancelled,
       (SELECT count(*) FROM retired)   AS positions_retired,
       (SELECT count(*) FROM untagged)  AS tags_removed
FROM reqs x, cfg
ORDER BY x.jr_id;
