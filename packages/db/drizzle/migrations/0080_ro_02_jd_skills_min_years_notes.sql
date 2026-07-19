-- =====================================================================
-- 0080_ro_02_jd_skills_min_years_notes.sql — RO-02 (hand-written)
--
-- Additive-only columns on jd_skills for the requisition wizard v2's skill
-- weighting step:
--   min_years_experience  integer  NULL — the minimum years the requirement
--     owner expects for THIS skill. Captured on the requisition for
--     interviewers + future scoring; older callers (REQ-02) that never send
--     it leave it NULL, unaffected.
--   notes                 text     NULL — a short free-text rationale per
--     skill (e.g. "core to the payments rewrite"). Advisory context; no
--     downstream consumer parses it today.
--
-- Both are NULLABLE with no default, so every existing jd_skills row and every
-- pre-RO-02 insert path is valid unchanged (the additive contract). No
-- companion FORCE-RLS / audit-trigger migration is needed: jd_skills already
-- carries its tenant_isolation policy + audit coverage from its create
-- migration; ADD COLUMN does not disturb either.
--
-- NOTE (parallel-ticket coordination): RO-01 reserves migrations 0077–0079 and
-- RO-03 may also add files this pass — the 0080 filename + journal idx may need
-- renumbering at reconciliation. This migration only ALTERs jd_skills (no new
-- table, no DDL clash with the other tickets).
-- =====================================================================

ALTER TABLE "jd_skills" ADD COLUMN IF NOT EXISTS "min_years_experience" integer;
ALTER TABLE "jd_skills" ADD COLUMN IF NOT EXISTS "notes" text;
