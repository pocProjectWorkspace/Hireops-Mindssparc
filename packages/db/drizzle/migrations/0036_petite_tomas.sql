-- =====================================================================
-- 0036_petite_tomas.sql — CRS-01 slug uniques + regex CHECKs.
--
-- Drizzle-generated (the DROP INDEX / ALTER / CREATE INDEX / ADD CHECK
-- statements at the bottom) plus a hand-prepended backfill block.
-- Single file so the NOT NULL flip cannot apply before the rows it
-- inspects are guaranteed non-null.
--
-- Steps in order:
--   1. Backfill any requisitions.public_slug NULL → derived from
--      positions.title + 6-char id suffix.
--   2. Backfill any tenants.slug that doesn't match the regex →
--      derived from display_name with a dedup loop. No NOT NULL flip
--      needed here (tenants.slug is already NOT NULL); the CHECK is the
--      new constraint.
--   3. Drop the partial-WHERE unique index on requisitions.public_slug.
--   4. SET NOT NULL on requisitions.public_slug.
--   5. Re-create the unique index without the partial-WHERE.
--   6. ADD CHECK constraints for the regex format on both tables.
--
-- Backfill is idempotent — re-running this migration after a clean run
-- finds no NULL or invalid rows and leaves data alone.
-- =====================================================================

-- ── 1. Requisitions backfill (NULL → derived) ───────────────────────
UPDATE public.requisitions r
SET public_slug = (
  substring(
    regexp_replace(lower(p.title), '[^a-z0-9]+', '-', 'g'),
    1, 73
  ) || '-' || substring(r.id::text, 1, 6)
)
FROM public.positions p
WHERE r.tenant_id = p.tenant_id
  AND r.position_id = p.id
  AND r.public_slug IS NULL;--> statement-breakpoint

-- ── 2. Tenants regex backfill (defensive — POC data already conforms) ──
-- Slugs that already match the regex + length range are left alone.
-- The DO block deduplicates against existing slugs by appending -NN.
DO $$
DECLARE
  t RECORD;
  base TEXT;
  candidate TEXT;
  i INTEGER;
BEGIN
  FOR t IN
    SELECT id, slug, display_name
    FROM public.tenants
    WHERE slug !~ '^[a-z0-9-]+$'
       OR char_length(slug) NOT BETWEEN 3 AND 40
  LOOP
    base := substring(regexp_replace(lower(t.display_name), '[^a-z0-9]+', '-', 'g'), 1, 35);
    candidate := base;
    i := 0;
    WHILE EXISTS (SELECT 1 FROM public.tenants WHERE slug = candidate AND id <> t.id) LOOP
      i := i + 1;
      candidate := base || '-' || lpad(i::text, 2, '0');
    END LOOP;
    UPDATE public.tenants SET slug = candidate WHERE id = t.id;
  END LOOP;
END
$$;--> statement-breakpoint

-- ── 3-6. Drizzle-generated schema changes ──────────────────────────
DROP INDEX "idx_requisitions_public_slug";--> statement-breakpoint
ALTER TABLE "requisitions" ALTER COLUMN "public_slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_requisitions_public_slug" ON "requisitions" USING btree ("tenant_id","public_slug");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_slug_format_check" CHECK ("tenants"."slug" ~ '^[a-z0-9-]+$' AND char_length("tenants"."slug") BETWEEN 3 AND 40);--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_public_slug_format_check" CHECK ("requisitions"."public_slug" ~ '^[a-z0-9-]+$' AND char_length("requisitions"."public_slug") BETWEEN 3 AND 80);
