-- =====================================================================
-- 0104_t31_business_unit_is_archived.sql — T3.1 / G14 (hand-written)
--
-- Business-unit MANAGEMENT (Phase 3, Org structure). The business_units table
-- already exists (0004): tenant-scoped, hierarchical via parent_business_unit_id
-- (self-FK), (tenant_id, slug) unique, ENABLE + FORCE ROW LEVEL SECURITY (0004),
-- and an audit trigger (0013). This migration adds the ONE column the managed
-- surface needs: an archive flag.
--
-- Archiving a BU retires it from the requisition-creation picker (the wizard's
-- controlled list) WITHOUT breaking positions already attached to it — the FK
-- on positions.business_unit_id stays valid and the live department-name join
-- keeps rendering. Default false: every existing row (and the seed data) stays
-- active with no behaviour change.
--
-- No companion force-rls-audit migration: business_units already has FORCE RLS
-- (0004) and its audit trigger (0013).
-- =====================================================================

ALTER TABLE public.business_units ADD COLUMN is_archived boolean NOT NULL DEFAULT false;
