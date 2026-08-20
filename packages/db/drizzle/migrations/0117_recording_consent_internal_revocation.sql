-- =====================================================================
-- 0117_recording_consent_internal_revocation.sql — N2a (hand-written)
--
-- ONE constraint edit: widen interview_recording_consents.captured_via to
-- allow 'internal_revocation' alongside 'candidate_confirm_link'.
--
-- Why a second capture seam exists at all. 0116 modelled consent as
-- something only the candidate can express, via their signed confirm link.
-- That is right about WHO decides and wrong about the operational reality
-- of how a withdrawal arrives: the signed link EXPIRES, the right to
-- withdraw does not. A candidate who phones or emails a DPDPA withdrawal
-- three weeks after the round has no working link, and with 0116's CHECK
-- alone there is no honest way to record what they asked for.
--
-- So the internal path (trpc withdrawInterviewRecordingConsent, role-gated
-- to recruiter / hiring_manager / hr_ops / admin and audited via withAudit)
-- appends a normal 'withdrawn' row and stamps this value. The point of the
-- separate value is HONESTY OF PROVENANCE: a row captured because a staff
-- member actioned a request must never be indistinguishable from a row the
-- candidate created by clicking. 0116's purpose-scoping comment says
-- widening a CHECK here is "a deliberate CHECK edit in a future migration,
-- visible in review" — this is that edit, and it is the whole migration.
--
-- Deliberately NOT widened in the other direction: there is still no
-- verbal-attestation or "recruiter asserts the candidate agreed" seam. The
-- internal path can only ever record a WITHDRAWAL in practice (the
-- procedure hard-codes decision = 'withdrawn'); the CHECK on `decision` is
-- untouched, and nothing here lets staff manufacture a grant.
--
-- Everything else about the table is unchanged: still append-only, still
-- SELECT+INSERT-only RLS under FORCE ROW LEVEL SECURITY, still no audit
-- trigger (it IS the log). No data migration — existing rows all carry
-- 'candidate_confirm_link' and remain valid under the new CHECK.
-- =====================================================================

ALTER TABLE "interview_recording_consents"
	DROP CONSTRAINT "interview_recording_consents_captured_via_check";--> statement-breakpoint
ALTER TABLE "interview_recording_consents"
	ADD CONSTRAINT "interview_recording_consents_captured_via_check"
	CHECK ("captured_via" IN ('candidate_confirm_link', 'internal_revocation'));
