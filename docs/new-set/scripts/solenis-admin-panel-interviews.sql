-- WRITES. Fills "My interviews" / "All interviews" for the demo admin login.
-- Those pages list interviews where the signed-in person is a PANELIST, and the
-- admin is on none. This, as one statement:
--   1. adds the admin as a panelist on up to 14 live interviews on the Solenis
--      tenant (skips AI async rounds, cancelled interviews and cancelled reqs);
--   2. moves 'scheduled' interviews whose time has already passed onto the next
--      working days (10:00–15:00 IST), so there are upcoming interviews to show.
-- The two staged demo interviews (Karthik af866943…, Sanjana b25cdf5b…) are
-- never touched. Change the email on the first line if you present with
-- another admin login.

WITH me AS (
  SELECT 'ashwin.kumar@solenis.com'::text AS email
),
scope AS (
  SELECT id FROM public.tenants
  WHERE slug IN ('solenis', 'kyndryl-poc') OR display_name ILIKE '%solenis%'
),
admin_m AS (
  SELECT m.id, m.tenant_id
  FROM public.tenant_user_memberships m
  JOIN auth.users u ON u.id = m.user_id
  WHERE lower(u.email) = (SELECT lower(email) FROM me)
    AND m.tenant_id IN (SELECT id FROM scope)
  LIMIT 1
),
candidates_iv AS (
  SELECT i.id, i.tenant_id, i.status, i.scheduled_start,
         row_number() OVER (ORDER BY (i.status = 'scheduled') DESC, i.scheduled_start DESC NULLS LAST) AS rn
  FROM public.interviews i
  JOIN public.requisitions r ON r.id = i.requisition_id
  WHERE i.tenant_id IN (SELECT id FROM scope)
    AND i.status <> 'cancelled'
    AND i.mode <> 'ai_async'
    AND r.status NOT IN ('cancelled', 'closed')
    AND i.id::text NOT LIKE 'af866943%'
    AND i.id::text NOT LIKE 'b25cdf5b%'
),
added AS (
  INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
  SELECT c.tenant_id, c.id, a.id, false
  FROM candidates_iv c CROSS JOIN admin_m a
  WHERE c.rn <= 14
    AND NOT EXISTS (SELECT 1 FROM public.interview_panelists p
                    WHERE p.interview_id = c.id AND p.membership_id = a.id)
  RETURNING interview_id
),
to_move AS (
  SELECT c.id,
         row_number() OVER (ORDER BY c.scheduled_start NULLS LAST, c.id) AS k
  FROM candidates_iv c
  WHERE c.rn <= 14 AND c.status = 'scheduled'
    AND (c.scheduled_start IS NULL OR c.scheduled_start < now())
),
workdays AS (
  -- working days from tomorrow (skip Sat/Sun), numbered 1, 2, 3 …
  SELECT d, row_number() OVER (ORDER BY d) AS n
  FROM generate_series(1, 21) AS d
  WHERE extract(isodow FROM (now() AT TIME ZONE 'Asia/Kolkata') + make_interval(days => d)) < 6
),
slots AS (
  -- two interviews per working day, between 10:00 and 14:00 IST
  SELECT t.id,
         ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
           + make_interval(days => w.d)
           + make_interval(hours => 10 + ((t.k - 1) % 5)::int)) AT TIME ZONE 'Asia/Kolkata') AS start_at
  FROM to_move t
  JOIN workdays w ON w.n = ((t.k - 1) / 2) + 1
),
moved AS (
  UPDATE public.interviews i
  SET scheduled_start = s.start_at,
      scheduled_end   = s.start_at + make_interval(mins => COALESCE(i.duration_minutes, 60)),
      updated_at = now()
  FROM slots s
  WHERE i.id = s.id
  RETURNING i.id
)
SELECT
  (SELECT count(*) FROM admin_m)  AS admin_found,
  (SELECT count(*) FROM added)    AS panelist_rows_added,
  (SELECT count(*) FROM moved)    AS interviews_moved_to_upcoming;
