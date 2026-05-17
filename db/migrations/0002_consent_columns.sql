-- =============================================================================
-- 0002_consent_columns.sql
-- BookItMalta — Phase 1.5b: explicit terms acceptance on enquiry submission
-- =============================================================================
--
-- Adds the audit trail for explicit consent under GDPR + Maltese consumer law.
--
-- When a customer ticks the consent checkbox on the public charter page form,
-- we record the timestamp + the version of the terms they accepted. The IP
-- and user agent are already captured in the existing audit columns
-- (ip_hash, user_agent) so we don't duplicate them here.
--
-- terms_version uses a date-coded scheme — bump it whenever terms.html
-- changes materially so future replays can map a row back to the exact
-- copy the customer saw.
--
-- Legacy rows (any enquiry inserted before this migration ran) keep
-- terms_accepted_at = NULL — they predate the explicit-consent flow and
-- relied on implicit "by using the site" acceptance which is GDPR-weak.
--
-- Migration runs against the BANDAMA Supabase project. Repeat against any
-- new tenant Supabase project when onboarding.
-- =============================================================================

ALTER TABLE enquiries
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terms_version     TEXT;

CREATE INDEX IF NOT EXISTS idx_enquiries_terms_accepted_at
  ON enquiries(terms_accepted_at);

COMMENT ON COLUMN enquiries.terms_accepted_at IS
  'Timestamp when customer ticked the explicit-consent checkbox on the public form. NULL = legacy row predating Phase 1.5b.';

COMMENT ON COLUMN enquiries.terms_version IS
  'Date-coded version of terms.html that was visible at acceptance time (e.g. 2026-05-16-v1). Bump whenever cancellation/refund/liability clauses change.';
