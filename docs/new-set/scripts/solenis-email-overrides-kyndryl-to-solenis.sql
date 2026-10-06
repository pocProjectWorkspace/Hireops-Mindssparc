-- WRITES. Replaces "Kyndryl" with "Solenis" in the Solenis tenant's saved email
-- wording (tenant_email_template_overrides). These rows came from an old demo
-- seed (seed-t14-email-overrides); the built-in templates are already clean.
-- One statement; returns the rows it changed.

WITH scope AS (
  SELECT id FROM public.tenants
  WHERE slug IN ('solenis', 'kyndryl-poc') OR display_name ILIKE '%solenis%'
)
UPDATE public.tenant_email_template_overrides o
SET subject_override = CASE WHEN o.subject_override IS NULL THEN NULL
                            ELSE regexp_replace(o.subject_override, 'Kyndryl', 'Solenis', 'gi') END,
    slot_overrides   = regexp_replace(o.slot_overrides::text, 'Kyndryl', 'Solenis', 'gi')::jsonb,
    updated_at = now()
WHERE o.tenant_id IN (SELECT id FROM scope)
  AND (o.subject_override ~* 'Kyndryl' OR o.slot_overrides::text ~* 'Kyndryl')
RETURNING o.template_key, o.subject_override, o.slot_overrides;
